/**
 * Structured JSON logging to stdout/stderr (the platform collects it).
 *
 * Fields are limited to primitives on purpose: never pass request text, file
 * contents, tokens, keys or upstream response bodies.
 */
type Level = "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | null | undefined>;

function write(level: Level, event: string, fields: LogFields = {}): void {
  // Caller fields first so they can never overwrite level, event or time.
  const line = JSON.stringify({ ...fields, level, event, time: new Date().toISOString() });
  if (level === "info") {
    console.log(line);
  } else {
    console.error(line);
  }
}

export const log = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
};
