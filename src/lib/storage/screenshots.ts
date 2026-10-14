/**
 * Screenshot storage. Every upload is re-encoded on the server before it is
 * stored publicly:
 * - metadata such as GPS location, camera details, XMP, IPTC, text chunks and
 *   colour profiles is dropped (colours are converted to sRGB first);
 * - EXIF orientation is applied first, so the picture still looks right;
 * - only the first frame of animated images is kept;
 * - anything smuggled after or inside the image data (polyglot files) is gone,
 *   because only decoded pixels are written back out.
 * A pixel limit and a timeout bound memory and CPU per request. Files get a
 * random name and an explicit content type; the client's file name is never
 * used. Stored files are public (the request issue links them), so the form
 * asks for an explicit acknowledgement and browsers may cache them only briefly.
 */
import { randomUUID } from "node:crypto";

import { del, put } from "@vercel/blob";
import type { Sharp, SharpOptions } from "sharp";

import { HttpError } from "@/lib/api/envelope";
import { log } from "@/lib/log";
import type { ValidatedScreenshot } from "@/lib/requests/validation";

/** 25 megapixels: far above real screenshots, bounded decode memory. */
export const MAX_INPUT_PIXELS = 25_000_000;
/** Wider screenshots are scaled down to this width; tall pages keep their height. */
export const MAX_WIDTH = 4096;
/** Re-encoded output above this is refused rather than stored. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Short browser caching, so a deleted screenshot disappears quickly. */
export const CACHE_MAX_AGE_SECONDS = 3600;
const DECODE_TIMEOUT_SECONDS = 10;
const UPLOAD_TIMEOUT_MS = 15_000;

type SharpFactory = (input: Uint8Array, options: SharpOptions) => Sharp;
let sharpFactory: Promise<SharpFactory> | null = null;

/**
 * Load sharp on first use, so a broken native binary only affects requests
 * with a screenshot (503) instead of every submission.
 */
function loadSharp(): Promise<SharpFactory> {
  sharpFactory ??= import("sharp")
    .then(({ default: sharp }) => {
      sharp.cache(false); // every input is unique; caching only holds memory
      sharp.concurrency(1); // one libvips thread per request keeps memory predictable
      return sharp as unknown as SharpFactory;
    })
    .catch((error: unknown) => {
      sharpFactory = null;
      log.error("screenshot.processor_unavailable", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new HttpError(
        503,
        "SERVICE_UNAVAILABLE",
        "Screenshots can't be processed right now. Try again, or submit without one.",
      );
    });
  return sharpFactory;
}

export interface SanitisedImage {
  bytes: Buffer;
  contentType: ValidatedScreenshot["contentType"];
  extension: ValidatedScreenshot["extension"];
}

const screenshotError = (message: string) =>
  new HttpError(422, "VALIDATION_FAILED", "Please fix the highlighted fields.", {
    screenshot: message,
  });

/** Decode and re-encode in the same format, with no metadata. */
export async function sanitiseScreenshot(
  screenshot: ValidatedScreenshot,
  limitInputPixels: number = MAX_INPUT_PIXELS,
): Promise<SanitisedImage> {
  const sharp = await loadSharp();
  let bytes: Buffer;
  try {
    const image = sharp(screenshot.bytes, { limitInputPixels, failOn: "error", pages: 1 })
      .rotate() // apply EXIF orientation before the metadata is dropped
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .timeout({ seconds: DECODE_TIMEOUT_SECONDS });
    const encoded =
      screenshot.contentType === "image/png"
        ? image.png()
        : screenshot.contentType === "image/webp"
          ? image.webp({ quality: 85 })
          : image.jpeg({ quality: 85, mozjpeg: true });
    bytes = await encoded.toBuffer();
  } catch (error) {
    // The input is a buffer, so sharp's message names no user data; it tells
    // decoder faults apart from bad uploads in the logs.
    log.info("screenshot.unreadable", {
      reason: error instanceof Error ? error.message.slice(0, 120) : typeof error,
    });
    throw screenshotError("The screenshot couldn't be read as an image. Try a different file.");
  }
  if (bytes.byteLength > MAX_OUTPUT_BYTES) {
    log.warn("screenshot.output_too_large", { bytes: bytes.byteLength });
    throw screenshotError(
      "This screenshot is too detailed to store. Try a smaller or cropped image.",
    );
  }
  return { bytes, contentType: screenshot.contentType, extension: screenshot.extension };
}

const storageFailed = () =>
  new HttpError(
    502,
    "UPSTREAM_ERROR",
    "We couldn't store the screenshot. Please try again, or submit without it.",
  );

/** Re-encode and upload; returns the public URL. */
export async function storeScreenshot(
  screenshot: ValidatedScreenshot,
  token: string,
): Promise<string> {
  const image = await sanitiseScreenshot(screenshot);
  try {
    const result = await put(`screenshots/${randomUUID()}.${image.extension}`, image.bytes, {
      access: "public",
      token,
      contentType: image.contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
      abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    log.info("screenshot.stored", {
      bytes: image.bytes.byteLength,
      contentType: image.contentType,
    });
    return result.url;
  } catch (error) {
    log.error("screenshot.store_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw storageFailed();
  }
}

/** Best-effort delete of a stored screenshot (its request failed). */
export async function discardScreenshot(url: string, token: string): Promise<void> {
  await del(url, { token, abortSignal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
}
