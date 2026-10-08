/**
 * The two demo files the workflow writes itself, never the model: the page
 * (a server component with only a title and a heading) and a loader that
 * mounts the model's `demo.tsx` in the browser only. Demo code therefore never
 * runs on the server or during the build, where production secrets live. The
 * write-scope check in CI compares both files with these templates exactly.
 */

export const PAGE_FILE = "page.tsx";
export const LOADER_FILE = "demo-loader.tsx";
export const DEMO_FILE = "demo.tsx";

/** Titles go into a string and JSX text: plain characters only, nothing that needs escaping. */
const SAFE_TITLE = /^[A-Za-z0-9][A-Za-z0-9 ,.:;!?()-]{0,59}$/;

export const isSafeTitle = (title: string) => SAFE_TITLE.test(title) && !/ {2}| $/.test(title);

/** A safe title from the approved plan's title, or a neutral fallback. */
export function titleFrom(planText: string): string {
  const first = planText.split("\n", 1)[0] ?? "";
  const title = first
    .replace(/[^A-Za-z0-9 ,.:;!?()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 60)
    .trim();
  return isSafeTitle(title) ? title : "Demo";
}

export function pageTemplate(title: string): string {
  if (!isSafeTitle(title)) throw new Error("unsafe demo title");
  return `import type { Metadata } from "next";

import DemoLoader from "./demo-loader";

export const metadata: Metadata = { title: "${title}" };

export default function Page() {
  return (
    <section className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">${title}</h1>
      <DemoLoader />
    </section>
  );
}
`;
}

export function loaderTemplate(): string {
  return `"use client";

import dynamic from "next/dynamic";

// The demo runs in the browser only, never on the server.
const Demo = dynamic(() => import("./demo"), {
  ssr: false,
  loading: () => <p className="text-muted-foreground">Loading the demo...</p>,
});

export default function DemoLoader() {
  return <Demo />;
}
`;
}

/** The title of a page that matches the template exactly, or null. */
export function templateTitle(page: string): string | null {
  const match = /export const metadata: Metadata = \{ title: "([^"\n]*)" \};/.exec(page);
  if (!match || !isSafeTitle(match[1])) return null;
  return page === pageTemplate(match[1]) ? match[1] : null;
}
