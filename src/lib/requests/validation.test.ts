// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  JPEG_BYTES,
  PNG_BYTES,
  VALID_DESCRIPTION,
  WEBP_BYTES,
  buildForm,
  validForm,
} from "@/test/fixtures";

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  SCREENSHOT_MAX_BYTES,
  characterCount,
  detectScreenshotType,
  normaliseDescription,
  validateSubmission,
} from "./validation";

describe("detectScreenshotType", () => {
  it("recognises PNG, JPEG and WebP by signature", () => {
    expect(detectScreenshotType(PNG_BYTES)?.contentType).toBe("image/png");
    expect(detectScreenshotType(JPEG_BYTES)?.extension).toBe("jpg");
    expect(detectScreenshotType(WEBP_BYTES)?.contentType).toBe("image/webp");
  });

  it("rejects truncated signatures and RIFF files that aren't WebP", () => {
    expect(detectScreenshotType(PNG_BYTES.slice(0, 7))).toBeNull();
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(detectScreenshotType(wav)).toBeNull();
  });

  it("rejects everything else, including SVG and GIF", () => {
    expect(detectScreenshotType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(detectScreenshotType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(detectScreenshotType(new Uint8Array())).toBeNull();
  });
});

describe("normaliseDescription", () => {
  it("trims, normalises line endings and drops NUL", () => {
    expect(normaliseDescription("  a\r\nb\rc\u0000  ")).toBe("a\nb\nc");
  });

  it("strips hidden characters a reviewer can't see but a model would read", () => {
    const hidden = "ok\u200B\u202Egnp.exe\u2066x\u{E0041}\u{E0042}\u0007\u0085\uFEFF";
    expect(normaliseDescription(hidden)).toBe("okgnp.exex");
  });

  it("keeps tabs and newlines and NFC-normalises", () => {
    expect(normaliseDescription("a\tb\nc")).toBe("a\tb\nc");
    expect(normaliseDescription("e\u0301")).toBe("\u00e9");
  });
});

describe("characterCount", () => {
  it("counts code points, so an emoji counts once", () => {
    expect(characterCount("😀😀")).toBe(2);
    expect("😀😀".length).toBe(4);
  });
});

describe("validateSubmission", () => {
  it("accepts a valid request without a screenshot", async () => {
    const result = await validateSubmission(validForm());
    expect(result).toEqual({
      ok: true,
      value: { description: VALID_DESCRIPTION, screenshot: null },
    });
  });

  it("accepts a valid screenshot and ignores the declared type", async () => {
    const file = new File([PNG_BYTES], "shot.jpg", { type: "image/jpeg" });
    const result = await validateSubmission(validForm({ screenshot: file }));
    expect(result.ok && result.value.screenshot?.contentType).toBe("image/png");
  });

  it("treats an empty file input as no screenshot", async () => {
    const result = await validateSubmission(validForm({ screenshot: new File([], "") }));
    expect(result.ok && result.value.screenshot).toBeNull();
  });

  it("reports every invalid field at once", async () => {
    const svg = new File(["<svg/>"], "x.png", { type: "image/png" });
    const result = await validateSubmission(
      buildForm({ description: "too short", screenshot: svg }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.details).sort()).toEqual(["description", "screenshot"]);
    }
  });

  it("enforces the description maximum and the screenshot size limit", async () => {
    const big = new File([new Uint8Array(SCREENSHOT_MAX_BYTES + 1)], "big.png");
    const result = await validateSubmission(
      buildForm({
        description: "x".repeat(DESCRIPTION_MAX_LENGTH + 1),
        botCheckToken: "t",
        screenshot: big,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details.description).toMatch(/under 5000/);
      expect(result.details.screenshot).toMatch(/4 MB/);
    }
  });

  it("accepts descriptions exactly at the limits", async () => {
    for (const length of [DESCRIPTION_MIN_LENGTH, DESCRIPTION_MAX_LENGTH]) {
      const result = await validateSubmission(
        buildForm({ description: "a".repeat(length), botCheckToken: "t" }),
      );
      expect(result.ok).toBe(true);
    }
    const tooShort = await validateSubmission(
      buildForm({ description: "a".repeat(DESCRIPTION_MIN_LENGTH - 1), botCheckToken: "t" }),
    );
    expect(tooShort.ok).toBe(false);
  });

  it("does not let zero-width or whitespace padding satisfy the minimum", async () => {
    for (const description of ["a" + "\u200B".repeat(30), " ".repeat(40), "\u202E".repeat(30)]) {
      const result = await validateSubmission(buildForm({ description, botCheckToken: "t" }));
      expect(result.ok).toBe(false);
    }
  });

  it("accepts a screenshot of exactly 4 MB", async () => {
    const bytes = new Uint8Array(SCREENSHOT_MAX_BYTES);
    bytes.set(PNG_BYTES);
    const result = await validateSubmission(validForm({ screenshot: new File([bytes], "s.png") }));
    expect(result.ok).toBe(true);
  });

  it("rejects duplicated fields", async () => {
    const form = validForm();
    form.append("description", VALID_DESCRIPTION);
    form.append("screenshot", new File([PNG_BYTES], "a.png"));
    form.append("screenshot", new File([PNG_BYTES], "b.png"));
    const result = await validateSubmission(form);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(Object.keys(result.details).sort()).toEqual(["description", "screenshot"]);
  });

  it("rejects a screenshot sent as text", async () => {
    const form = validForm();
    form.set("screenshot", "data:image/png;base64,AAAA");
    const result = await validateSubmission(form);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.details.screenshot).toMatch(/as a file/);
  });

  it("requires the publish acknowledgement for a screenshot", async () => {
    const file = new File([PNG_BYTES], "s.png");
    const result = await validateSubmission(
      validForm({ screenshot: file, screenshotConsent: false }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.details.screenshot).toMatch(/can be published/);
  });
});
