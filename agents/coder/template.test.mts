// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  isSafeTitle,
  loaderTemplate,
  pageTemplate,
  templateTitle,
  titleFrom,
} from "./template.mts";

describe("titleFrom", () => {
  it("keeps plain titles and cleans everything else", () => {
    expect(titleFrom("Counter demo\n\nsummary")).toBe("Counter demo");
    expect(titleFrom('Tip "calculator" <b>{x}</b>')).toBe("Tip calculator b x b");
    expect(titleFrom("")).toBe("Demo");
    expect(titleFrom("<<<>>>")).toBe("Demo");
    expect(titleFrom("x".repeat(80))).toHaveLength(60);
  });
});

describe("isSafeTitle", () => {
  it.each(["Counter", "Tip calculator (v2): fast!"])("accepts %j", (title) => {
    expect(isSafeTitle(title)).toBe(true);
  });

  it.each([
    "",
    " lead",
    "trail ",
    "two  spaces",
    'quote"',
    "brace{",
    "angle<",
    "back\\slash",
    "x".repeat(61),
  ])("refuses %j", (title) => {
    expect(isSafeTitle(title)).toBe(false);
  });
});

describe("templates", () => {
  it("render the page with the title and recognise it again", () => {
    const page = pageTemplate("Counter demo");
    expect(page).toContain('export const metadata: Metadata = { title: "Counter demo" };');
    expect(page).toContain(">Counter demo</h1>");
    expect(templateTitle(page)).toBe("Counter demo");
    expect(() => pageTemplate('bad"title')).toThrow("unsafe demo title");
  });

  it("refuse anything that differs from the template", () => {
    const page = pageTemplate("Counter demo");
    expect(templateTitle(`${page}export const x = 1;\n`)).toBeNull();
    expect(templateTitle(page.replace("<DemoLoader />", "<DemoLoader />{1}"))).toBeNull();
    expect(templateTitle(page.replace("Counter demo", 'x" + process.env.K + "'))).toBeNull();
  });

  it("load the demo in the browser only", () => {
    expect(loaderTemplate()).toContain('dynamic(() => import("./demo"), {\n  ssr: false,');
    expect(loaderTemplate().startsWith('"use client";')).toBe(true);
  });
});
