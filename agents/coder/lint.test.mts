// @vitest-environment node
import { describe, expect, it } from "vitest";

import { lintFiles } from "./lint.mts";
import { loaderTemplate, pageTemplate } from "./template.mts";

const dir = "src/app/demos/request-7/";

describe("lintFiles", () => {
  it("passes the workflow's templates and an ordinary demo", async () => {
    const files = [
      { path: `${dir}page.tsx`, content: pageTemplate("Counter demo") },
      { path: `${dir}demo-loader.tsx`, content: loaderTemplate() },
      {
        path: `${dir}demo.tsx`,
        content: '"use client";\n\nexport default function Demo() {\n  return <p>Hi</p>;\n}\n',
      },
    ];
    expect(await lintFiles(files)).toEqual([]);
  });

  it("reports rule ids and lines without quoting the code", async () => {
    const problems = await lintFiles([
      {
        path: `${dir}demo.tsx`,
        content: '"use client";\nexport const secret = process.env.SECRET_VALUE;\n',
      },
    ]);
    expect(problems).toContain(`"${dir}demo.tsx": lint no-restricted-globals at line 2`);
    expect(problems.join(" ")).not.toContain("SECRET_VALUE");
  });

  it("reports code that doesn't parse", async () => {
    const problems = await lintFiles([{ path: `${dir}demo.tsx`, content: "export const = ;\n" }]);
    expect(problems[0]).toMatch(/lint parse error at line 1$/);
  });
});
