// @vitest-environment node
import { getFileInfo } from "prettier";
import { describe, expect, it } from "vitest";

// Agent-written demos are not reformatted (the build job that holds the model
// key installs nothing, so it can't run Prettier). Everything else still is.
const ignored = async (path: string) =>
  (await getFileInfo(path, { ignorePath: ".prettierignore" })).ignored;

describe(".prettierignore", () => {
  it("skips files in agent demo folders", async () => {
    expect(await ignored("src/app/demos/request-67/demo.tsx")).toBe(true);
    expect(await ignored("src/app/demos/request-67/page.tsx")).toBe(true);
    expect(await ignored("src/app/demos/request-1/demo.test.tsx")).toBe(true);
  });

  it("keeps the earlier ignore entries", async () => {
    expect(await ignored("pnpm-lock.yaml")).toBe(true);
    expect(await ignored(".github/workflows/ci.yml")).toBe(true);
  });

  it("still formats everything else, including the demos index and other code", async () => {
    expect(await ignored("src/app/demos/page.tsx")).toBe(false);
    expect(await ignored("src/app/demos/example/demo.tsx")).toBe(false);
    expect(await ignored("src/app/demos/requests/demo.tsx")).toBe(false);
    expect(await ignored("src/app/demos/request-abc/demo.tsx")).toBe(false);
    expect(await ignored("src/app/demos/x/request-1/demo.tsx")).toBe(false);
    expect(await ignored("src/app/demos/request-1.tsx")).toBe(false);
    expect(await ignored("src/lib/config.ts")).toBe(false);
    expect(await ignored("agents/coder/generate.mts")).toBe(false);
  });
});
