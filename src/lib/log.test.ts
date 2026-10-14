// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { log } from "./log";

afterEach(() => vi.restoreAllMocks());

describe("log", () => {
  it("writes one JSON line per event, info to stdout", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("thing.happened", { id: 7 });
    const entry = JSON.parse(out.mock.calls[0][0] as string);
    expect(entry).toMatchObject({ level: "info", event: "thing.happened", id: 7 });
    expect(typeof entry.time).toBe("string");
  });

  it("sends warnings and errors to stderr", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    log.warn("careful");
    log.error("broken", { code: "X" });
    expect(err).toHaveBeenCalledTimes(2);
    expect(JSON.parse(err.mock.calls[1][0] as string)).toMatchObject({ level: "error", code: "X" });
  });
});
