// @vitest-environment node
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Runs the project's real ESLint config on code placed in a demo folder.
const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIds(code: string, filePath = "src/app/demos/request-1/widget.tsx") {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((message) => message.ruleId);
}

describe("demo code lint rules", () => {
  it("allow an ordinary client component", async () => {
    const code = `"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function Counter() {
  const [count, setCount] = useState(0);
  return <Button onClick={() => setCount(count + 1)}>Count {count}</Button>;
}
`;
    expect(await ruleIds(code)).toEqual([]);
  });

  it.each([
    [
      "a Node import",
      `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`,
      "no-restricted-imports",
    ],
    [
      "child_process",
      `import { exec } from "child_process";\nexport const x = exec;\n`,
      "no-restricted-imports",
    ],
    [
      "next/headers",
      `import { cookies } from "next/headers";\nexport const x = cookies;\n`,
      "no-restricted-imports",
    ],
    [
      "next/script",
      `import Script from "next/script";\nexport const x = Script;\n`,
      "no-restricted-imports",
    ],
    ["fetch", `export const load = () => fetch("/x");\n`, "no-restricted-globals"],
    ["WebSocket", `export const s = () => new WebSocket("wss://x");\n`, "no-restricted-globals"],
    ["process.env", `export const k = process.env.SECRET;\n`, "no-restricted-globals"],
    ["window.fetch", `export const load = () => window.fetch("/x");\n`, "no-restricted-syntax"],
    [
      "sendBeacon",
      `export const ping = () => navigator.sendBeacon("/x");\n`,
      "no-restricted-syntax",
    ],
    ["a server action", `"use server";\nexport async function save() {}\n`, "no-restricted-syntax"],
    [
      "dangerouslySetInnerHTML",
      `export const X = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n`,
      "no-restricted-syntax",
    ],
    [
      "innerHTML",
      `export const set = (el: HTMLElement) => { el.innerHTML = "x"; };\n`,
      "no-restricted-syntax",
    ],
    ["eval", `export const run = (s: string) => eval(s);\n`, "no-restricted-syntax"],
    [
      "new Function",
      `export const run = (s: string) => new Function(s);\n`,
      "no-restricted-syntax",
    ],
    ["dynamic import", `export const load = () => import("./x");\n`, "no-restricted-syntax"],
    [
      "an iframe",
      `export const X = () => <iframe title="x" src="/x" />;\n`,
      "no-restricted-syntax",
    ],
  ])("refuse %s", async (_name, code) => {
    const restricted = (await ruleIds(code)).filter((id) => id?.startsWith("no-restricted-"));
    expect(restricted.length).toBeGreaterThan(0);
  });

  it.each([
    ["an inline disable", `/* eslint-disable */\nexport const load = () => fetch("/x");\n`],
    ["computed access", `export const load = () => window["fetch"]("/x");\n`],
    ["destructuring", `const { fetch: f } = window;\nexport const load = () => f("/x");\n`],
    ["top", `export const t = () => top?.location;\n`],
    ["a bare open", `export const go = () => open("/x");\n`],
    ["createElement script", `export const s = () => document.createElement("script");\n`],
    [
      "spread dangerouslySetInnerHTML",
      `const p = { dangerouslySetInnerHTML: { __html: "x" } };\nexport const X = () => <div {...p} />;\n`,
    ],
    ["a constructor escape", `export const run = (s: string) => (() => {}).constructor(s);\n`],
    ["require", `export const r = () => require("child_process");\n`],
    ["vm", `import vm from "vm";\nexport const x = vm;\n`],
    [
      "redirect",
      `import { redirect } from "next/navigation";\nexport const go = () => redirect("/");\n`,
    ],
    ["an internal import", `import { log } from "@/lib/log";\nexport const x = log;\n`],
    ["a parent import", `import x from "../other/thing";\nexport const y = x;\n`],
    ["new Image", `export const ping = () => { new Image().src = "/x"; };\n`],
  ])("refuse %s", async (_name, code) => {
    expect((await ruleIds(code)).length).toBeGreaterThan(0);
  });

  it("allow the shared UI primitives, helpers and the demo's own files", async () => {
    const code = `import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCounter } from "./use-counter";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function X() {
  const [open, setOpen] = [false, (v: boolean) => v];
  useRouter();
  return <Link href="/demos" className={cn(open && "x")} onClick={() => setOpen(true)}><Button>{useCounter()}</Button></Link>;
}
`;
    expect(await ruleIds(code)).toEqual([]);
  });

  it("don't apply outside the demo area", async () => {
    expect(await ruleIds(`export const load = () => fetch("/x");\n`, "src/lib/load.ts")).toEqual(
      [],
    );
  });
});
