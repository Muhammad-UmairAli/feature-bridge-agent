/** Shared test fixtures: minimal valid image headers and form builders. */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
export const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

export const VALID_DESCRIPTION =
  "Add a dark mode toggle to the settings page, like in the mobile app.";

export function buildForm(fields: {
  description?: string;
  botCheckToken?: string;
  screenshot?: File;
}): FormData {
  const form = new FormData();
  if (fields.description !== undefined) form.set("description", fields.description);
  if (fields.botCheckToken !== undefined) form.set("botCheckToken", fields.botCheckToken);
  if (fields.screenshot) form.set("screenshot", fields.screenshot);
  return form;
}

export const validForm = (extra: { screenshot?: File } = {}) =>
  buildForm({ description: VALID_DESCRIPTION, botCheckToken: "token-123", ...extra });
