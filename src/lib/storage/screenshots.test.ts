// @vitest-environment node
import { del, put } from "@vercel/blob";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ValidatedScreenshot, detectScreenshotType } from "@/lib/requests/validation";

import {
  CACHE_MAX_AGE_SECONDS,
  MAX_WIDTH,
  discardScreenshot,
  sanitiseScreenshot,
  storeScreenshot,
} from "./screenshots";

vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));

/** Wrap raw bytes the way validation would, using the detected type. */
function asScreenshot(bytes: Buffer): ValidatedScreenshot {
  const type = detectScreenshotType(bytes);
  if (!type) throw new Error("fixture is not a supported image");
  return { bytes: new Uint8Array(bytes), ...type };
}

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 0, g: 153, b: 255 } } });

let logged: () => string;
beforeEach(() => {
  vi.mocked(put).mockReset();
  vi.mocked(del).mockReset();
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  logged = () => [...out.mock.calls, ...err.mock.calls].flat().join(" ");
});
afterEach(() => vi.restoreAllMocks());

describe("sanitiseScreenshot", () => {
  it("removes EXIF metadata, including GPS location", async () => {
    const withGps = await solid(64, 48)
      .jpeg()
      .withExif({
        IFD0: { Make: "PhoneMaker", Copyright: "Jane Doe" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 51/1 0/1" },
      })
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();

    const clean = await sanitiseScreenshot(asScreenshot(withGps));
    const meta = await sharp(clean.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(clean.bytes.includes(Buffer.from("PhoneMaker"))).toBe(false);
    expect(clean.contentType).toBe("image/jpeg");
  });

  it("drops a payload appended after the image data (polyglot)", async () => {
    const png = await solid(16, 16).png().toBuffer();
    const polyglot = Buffer.concat([png, Buffer.from("<html><script>alert(1)</script></html>")]);
    const clean = await sanitiseScreenshot(asScreenshot(polyglot));
    expect(clean.bytes.includes(Buffer.from("<script>"))).toBe(false);
    expect((await sharp(clean.bytes).metadata()).format).toBe("png");
  });

  it("applies orientation before stripping it", async () => {
    // 40x20 stored with orientation 6 (rotate 90°) displays as 20x40.
    const rotated = await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const meta = await sharp((await sanitiseScreenshot(asScreenshot(rotated))).bytes).metadata();
    expect([meta.width, meta.height]).toEqual([20, 40]);
    expect(meta.orientation).toBeUndefined();
  });

  it("scales wide screenshots down to the maximum width", async () => {
    const wide = await solid(MAX_WIDTH * 2, 100)
      .webp()
      .toBuffer();
    const meta = await sharp((await sanitiseScreenshot(asScreenshot(wide))).bytes).metadata();
    expect(meta.width).toBe(MAX_WIDTH);
    expect(meta.format).toBe("webp");
  });

  it("keeps tall full-page captures at full height", async () => {
    const tall = await solid(1200, 9000).png().toBuffer();
    const meta = await sharp((await sanitiseScreenshot(asScreenshot(tall))).bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 9000]);
  });

  it("removes PNG text chunks and colour profiles", async () => {
    const tagged = await solid(16, 16)
      .withIccProfile("p3")
      .png()
      .withMetadata({ exif: { IFD0: { ImageDescription: "secret-office-plan" } } })
      .toBuffer();
    const meta = await sharp((await sanitiseScreenshot(asScreenshot(tagged))).bytes).metadata();
    expect(meta.icc).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it("keeps only the first frame of an animated image", async () => {
    const frames = await sharp({
      create: { width: 8, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    // Two stacked 8x8 frames presented as an animation.
    const animated = await sharp(frames, { pages: -1 }).webp().toBuffer();
    const meta = await sharp((await sanitiseScreenshot(asScreenshot(animated))).bytes).metadata();
    expect(meta.pages ?? 1).toBe(1);
  });

  it("rejects a truncated JPEG", async () => {
    const jpeg = await solid(64, 64).jpeg().toBuffer();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 2));
    await expect(sanitiseScreenshot(asScreenshot(truncated))).rejects.toMatchObject({
      status: 422,
    });
  });

  it("rejects images over the pixel limit and unreadable files with 422", async () => {
    const png = await solid(100, 100).png().toBuffer();
    await expect(sanitiseScreenshot(asScreenshot(png), 5_000)).rejects.toMatchObject({
      status: 422,
      details: { screenshot: expect.stringMatching(/couldn't be read/) },
    });
    // A valid signature followed by garbage.
    const broken = Buffer.concat([png.subarray(0, 16), Buffer.alloc(64, 7)]);
    await expect(sanitiseScreenshot(asScreenshot(broken))).rejects.toMatchObject({ status: 422 });
  });
});

describe("storeScreenshot", () => {
  it("uploads the re-encoded image under a random name with an explicit content type", async () => {
    vi.mocked(put).mockResolvedValue({ url: "https://blob.example/screenshots/x.png" } as Awaited<
      ReturnType<typeof put>
    >);
    const png = await solid(8, 8).png().toBuffer();
    const url = await storeScreenshot(asScreenshot(png), "blob-token-123");
    expect(url).toBe("https://blob.example/screenshots/x.png");
    const [pathname, body, options] = vi.mocked(put).mock.calls[0];
    expect(pathname).toMatch(/^screenshots\/[0-9a-f-]{36}\.png$/);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(options).toMatchObject({
      access: "public",
      token: "blob-token-123",
      contentType: "image/png",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
    });
    expect(options.abortSignal).toBeDefined();
  });

  it("maps upload failures to 502 without logging the token", async () => {
    vi.mocked(put).mockRejectedValue(new Error("store suspended"));
    const png = await solid(8, 8).png().toBuffer();
    await expect(storeScreenshot(asScreenshot(png), "blob-token-123")).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_ERROR",
    });
    expect(logged()).not.toContain("blob-token-123");
  });

  it("never uploads an unreadable image", async () => {
    const png = await solid(8, 8).png().toBuffer();
    const broken = Buffer.concat([png.subarray(0, 16), Buffer.alloc(32, 1)]);
    await expect(storeScreenshot(asScreenshot(broken), "t")).rejects.toMatchObject({ status: 422 });
    expect(put).not.toHaveBeenCalled();
  });
});

describe("discardScreenshot", () => {
  it("deletes by URL with the token", async () => {
    vi.mocked(del).mockResolvedValue(undefined);
    await discardScreenshot("https://blob.example/screenshots/x.png", "blob-token-123");
    expect(del).toHaveBeenCalledWith(
      "https://blob.example/screenshots/x.png",
      expect.objectContaining({ token: "blob-token-123" }),
    );
  });
});
