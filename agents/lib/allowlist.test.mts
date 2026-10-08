// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { isAllowlisted, parseAllowlist, readAllowlist } from "./allowlist.mts";

afterEach(() => vi.unstubAllEnvs());

const user = (login: unknown) => ({ login, type: "User" });

describe("parseAllowlist", () => {
  it("accepts comma or whitespace separated names, with or without @, case-insensitively", () => {
    const { logins, rejected } = parseAllowlist(" Alice, @bob\r\ncarol-d\tdave ,, ALICE @alice ");
    expect([...logins]).toEqual(["alice", "bob", "carol-d", "dave"]);
    expect(rejected).toBe(0);
  });

  it("accepts the longest valid name", () => {
    expect(parseAllowlist("a".repeat(39)).logins.size).toBe(1);
  });

  it("drops and counts entries that aren't usable GitHub usernames", () => {
    const entries = [
      "portal[bot]",
      "github-actions[bot]",
      "-lead",
      "trail-",
      "dou--ble",
      "a".repeat(40),
      "alice;bob",
      "@@carol",
      "a@b",
      "@",
      "ghost",
      "\u212Aate", // Kelvin sign, a look-alike of "K"
      "\u017Fam", // long s
      "\uFF42\uFF4F\uFF42", // fullwidth "bob"
      "dave\u200b", // zero-width space
    ];
    const { logins, rejected } = parseAllowlist(entries.join(","));
    expect(logins.size).toBe(0);
    expect(rejected).toBe(entries.length);
  });

  it("allows nobody when the variable is missing or empty", () => {
    expect(parseAllowlist(undefined)).toEqual({ logins: new Set(), rejected: 0 });
    expect(parseAllowlist("  , ").logins.size).toBe(0);
    expect(readAllowlist({}).logins.size).toBe(0);
    expect([...readAllowlist({ APPROVER_ALLOWLIST: "Maintainer" }).logins]).toEqual(["maintainer"]);
  });

  it("reads APPROVER_ALLOWLIST from the process environment by default", () => {
    vi.stubEnv("APPROVER_ALLOWLIST", "lead");
    expect([...readAllowlist().logins]).toEqual(["lead"]);
  });
});

describe("isAllowlisted", () => {
  const list = parseAllowlist("Maintainer, reviewer-2");

  it("matches listed humans regardless of case", () => {
    expect(isAllowlisted(list, user("maintainer"))).toBe(true);
    expect(isAllowlisted(list, user("REVIEWER-2"))).toBe(true);
  });

  it("refuses unlisted, missing and malformed names", () => {
    expect(isAllowlisted(list, user("someone"))).toBe(false);
    expect(isAllowlisted(list, null)).toBe(false); // deleted account
    expect(isAllowlisted(list, undefined)).toBe(false);
    expect(isAllowlisted(list, user(null))).toBe(false);
    expect(isAllowlisted(list, user(""))).toBe(false);
    expect(isAllowlisted(list, user(42))).toBe(false);
    expect(isAllowlisted(list, user("maintainer "))).toBe(false);
    expect(isAllowlisted(list, user("maintainer\n"))).toBe(false);
    expect(isAllowlisted(parseAllowlist("kate"), user("\u212Aate"))).toBe(false);
  });

  it("refuses anything that isn't explicitly a User account", () => {
    expect(isAllowlisted(list, { login: "maintainer" })).toBe(false);
    expect(isAllowlisted(list, { login: "maintainer", type: null })).toBe(false);
    expect(isAllowlisted(list, { login: "maintainer", type: "" })).toBe(false);
    expect(isAllowlisted(list, { login: "maintainer", type: "Bot" })).toBe(false);
    expect(isAllowlisted(list, { login: "maintainer", type: "Organization" })).toBe(false);
    expect(isAllowlisted(list, { login: "maintainer", type: "Mannequin" })).toBe(false);
    expect(isAllowlisted(parseAllowlist("maintainer"), user("maintainer[bot]"))).toBe(false);
  });

  it("allows nobody with an empty list", () => {
    expect(isAllowlisted(parseAllowlist(""), user("maintainer"))).toBe(false);
  });
});
