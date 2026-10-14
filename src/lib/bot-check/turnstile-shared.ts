/** The action the request form's widget uses; the server rejects tokens for any other action. */
export const TURNSTILE_ACTION = "submit-request";
/** Header that carries the token, so the server verifies it before reading the body. */
export const BOT_CHECK_HEADER = "x-bot-check-token";
