/** Shared test fixtures: minimal valid image headers and form builders. */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
export const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

/** A syntactically valid public Blob URL for a stored screenshot. */
export const BLOB_SCREENSHOT_URL =
  "https://abc123.public.blob.vercel-storage.com/screenshots/1b4e28ba-2fa1-41d2-883f-0016d3cca427.png";

export const VALID_DESCRIPTION =
  "Add a dark mode toggle to the settings page, like in the mobile app.";

export function buildForm(fields: {
  description?: string;
  botCheckToken?: string;
  screenshot?: File;
  screenshotConsent?: boolean;
}): FormData {
  const form = new FormData();
  if (fields.description !== undefined) form.set("description", fields.description);
  if (fields.botCheckToken !== undefined) form.set("botCheckToken", fields.botCheckToken);
  if (fields.screenshot) form.set("screenshot", fields.screenshot);
  // Attaching a screenshot implies the publish acknowledgement unless a test says otherwise.
  if (fields.screenshot && fields.screenshotConsent !== false) form.set("screenshotConsent", "yes");
  return form;
}

export const validForm = (extra: { screenshot?: File; screenshotConsent?: boolean } = {}) =>
  buildForm({ description: VALID_DESCRIPTION, botCheckToken: "token-123", ...extra });
