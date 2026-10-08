/**
 * The files the coding agent proposes for a demo: parsed from a simple
 * delimited format (no JSON escaping of code) and checked before anything is
 * committed. The model writes `demo.tsx` (a client component), helpers and
 * tests; the page and loader come from templates (template.mts).
 *
 * These checks are tripwires, not the boundary: demo code only ever runs in
 * the browser (see template.mts), CI runs its own write-scope check, lint and
 * tests without secrets, and a human reviews the pull request.
 */
import { isAllowedDemoPath } from "../planner/scope.mts";
import { checkContent, shown } from "../scope-check/check.mts";
import { DEMO_FILE, LOADER_FILE, PAGE_FILE } from "./template.mts";

export interface GeneratedFile {
  path: string;
  content: string;
}

export const FILE_END = "<<<END FILE>>>";
export const CANNOT_BUILD = "<<<CANNOT BUILD>>>";
const FILE_START = /^<<<FILE ([^\s<>]{1,200})>>>$/;
const MAX_FILES = 12;
const MAX_FILE_BYTES = 30_000;
const MAX_TOTAL_BYTES = 150_000;
const MAX_LINE = 300;

export type Parsed =
  | { kind: "files"; files: GeneratedFile[] }
  | { kind: "declined" }
  | { kind: "error"; problem: string };

/** Drop one Markdown fence pair wrapped around a whole file, a common model habit. */
function unfence(lines: string[]): string[] {
  const first = lines.findIndex((line) => line.trim() !== "");
  const last = lines.findLastIndex((line) => line.trim() !== "");
  if (first === -1 || first === last) return lines;
  return /^```[\w-]*$/.test(lines[first].trim()) && lines[last].trim() === "```"
    ? lines.slice(first + 1, last)
    : lines;
}

/** Files from a reply. Prose outside blocks is ignored; malformed blocks are an error, never guessed. */
export function parseFiles(reply: string): Parsed {
  const lines = reply
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*<think>[\s\S]*?<\/think>/, "")
    .split("\n");
  const files: GeneratedFile[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of lines) {
    const marker = line.trim();
    if (marker === CANNOT_BUILD && !current) return { kind: "declined" };
    const start = FILE_START.exec(marker);
    if (current) {
      if (marker === FILE_END) {
        const body = unfence(current.lines).join("\n").replace(/\n*$/, "");
        files.push({ path: current.path, content: `${body}\n` });
        current = null;
      } else if (start || marker.startsWith("<<<FILE")) {
        return { kind: "error", problem: "a file block wasn't closed before the next one started" };
      } else {
        current.lines.push(line);
      }
      continue;
    }
    if (start) current = { path: start[1], lines: [] };
    else if (marker === FILE_END) {
      return { kind: "error", problem: "an end marker appeared outside a file block" };
    } else if (marker.startsWith("<<<FILE")) {
      return { kind: "error", problem: "a file marker was malformed" };
    }
  }
  if (current) return { kind: "error", problem: "a file block wasn't closed" };
  return { kind: "files", files };
}

/** Imports demo code may use (named imports from next/navigation are checked separately). */
const ALLOWED_IMPORTS = [
  /^react$/,
  /^next\/link$/,
  /^next\/navigation$/,
  /^@\/components\/ui\/[a-z0-9-]+$/,
  /^@\/lib\/utils$/,
];
const TEST_IMPORTS = [/^vitest$/, /^@testing-library\/react$/];
const OWN_FILE = /^\.\/([a-z0-9]+(?:-[a-z0-9]+)*(?:\.test)?)(?:\.tsx?)?$/;
const NAVIGATION = new Set(["useRouter", "usePathname", "useSearchParams"]);
/** The only `vi` helpers demo tests may use (no module mocking or loading). */
const VI_ALLOWED = new Set([
  "fn",
  "spyOn",
  "useFakeTimers",
  "useRealTimers",
  "advanceTimersByTime",
  "runAllTimers",
  "runOnlyPendingTimers",
  "setSystemTime",
  "clearAllMocks",
  "resetAllMocks",
  "restoreAllMocks",
]);

/** Patterns from AGENTS.md "Not allowed in demo code" and related escapes, with the reason each gives. */
const FORBIDDEN: [RegExp, string][] = [
  [
    /\bprocess\s*(?:\.\s*env\b|\[)|\brequire\s*\(\s*["'`]|\bmodule\s*\.\s*exports\b/,
    "uses Node APIs or the environment",
  ],
  [/["']use server["']/, "defines server actions"],
  [
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/,
    "makes network calls",
  ],
  [
    /\bnavigator\s*\.\s*serviceWorker\b|\bindexedDB\b|\bcaches\s*\.|\bdocument\s*\.\s*cookie\b/,
    "uses storage other than prefixed localStorage or sessionStorage",
  ],
  [
    /\blocation\s*\.\s*(?:assign|replace)\s*\(|\blocation\s*(?:\.\s*href\s*)?=(?!=)|\bwindow\s*\.\s*open\s*\(/,
    "navigates away or opens windows",
  ],
  [
    /(?<![\w$.\])])<(?:script|iframe|object|embed|base|meta|link)\b|\bcreateElement\s*\(/,
    "embeds scripts or external content",
  ],
  [
    /\bdangerouslySetInnerHTML\b|\b(?:inner|outer)HTML\b|\binsertAdjacentHTML\b|\bdocument\s*\.\s*write/,
    "injects HTML",
  ],
  [
    /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bsetTimeout\s*\(\s*["'`]|\bsetInterval\s*\(\s*["'`]/,
    "evaluates strings as code",
  ],
  [/\bimport\s*\(|\bimport\s*\.\s*meta\b/, "loads modules dynamically"],
  [
    /\bglobalThis\b|\bReflect\b|\.\s*constructor\b|\b(?:window|self|document)\s*\[/,
    "reaches globals indirectly",
  ],
  [/\batob\s*\(|\bfromCharCode\b|\bfromCodePoint\b|\\[ux][0-9a-fA-F{]/, "builds hidden strings"],
  [
    /\b(?:https?|wss?):\/\/(?!www\.w3\.org\/)|[("'=`]\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/i,
    "points outside the site",
  ],
  [/@vitest-environment|@jsx|\/\/\/\s*</, "changes how the file is compiled or tested"],
];

/** import/export statements only, so text like `"Hamlet"` in JSX isn't mistaken for an import. */
const IMPORT =
  /^\s*(?:import\s+(?:type\s+)?([^;"'`]*?)\s*from|import|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from)\s*["']([^"']+)["']/gm;

/** Characters people can't see or that read differently from how they compile. */
const HIDDEN_CODE_POINTS = new Set([0x115f, 0x1160, 0x3164, 0xffa0]);
function hasHiddenCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n" || char === "\t") continue;
    if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(char)) return true;
    if (HIDDEN_CODE_POINTS.has(code)) return true;
    if ((code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef)) return true;
  }
  return false;
}

function checkFile(file: GeneratedFile, dir: string, slug: string, own: Set<string>): string[] {
  const problems: string[] = [];
  const where = shown(file.path);
  const name = file.path.slice(dir.length);
  if (!isAllowedDemoPath(file.path, slug)) return [`${where}: not an allowed file in ${dir}`];
  if (name === PAGE_FILE || name === LOADER_FILE)
    return [`${where}: written by the workflow, not the agent`];
  const bytes = new TextEncoder().encode(file.content);
  if (bytes.byteLength > MAX_FILE_BYTES) return [`${where}: larger than ${MAX_FILE_BYTES} bytes`];
  problems.push(...checkContent(file.path, bytes));
  if (hasHiddenCharacters(file.content)) problems.push(`${where}: contains hidden characters`);
  if (file.content.split("\n").some((line) => line.length > MAX_LINE)) {
    problems.push(`${where}: has a line longer than ${MAX_LINE} characters`);
  }

  for (const [pattern, reason] of FORBIDDEN) {
    if (pattern.test(file.content)) problems.push(`${where}: ${reason}`);
  }
  problems.push(...checkStorage(file.content, slug).map((problem) => `${where}: ${problem}`));

  const isTest = /\.test\.tsx?$/.test(file.path);
  for (const match of file.content.matchAll(IMPORT)) {
    const [, clause = "", specifier] = match;
    const ownFile = OWN_FILE.exec(specifier);
    if (ownFile) {
      if (!own.has(ownFile[1]) && ownFile[1] !== LOADER_FILE.replace(/\.tsx$/, "")) {
        problems.push(`${where}: imports a file it doesn't create`);
      }
      continue;
    }
    if (
      ![...ALLOWED_IMPORTS, ...(isTest ? TEST_IMPORTS : [])].some((rule) => rule.test(specifier))
    ) {
      problems.push(`${where}: imports a module demos may not use`);
    } else if (specifier === "next/navigation") {
      const names = /^\{([^}]*)\}$/
        .exec(clause.trim())?.[1]
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean);
      if (!names || names.some((imported) => !NAVIGATION.has(imported))) {
        problems.push(
          `${where}: imports from next/navigation other than useRouter, usePathname or useSearchParams`,
        );
      }
    }
  }
  if (isTest) {
    for (const match of file.content.matchAll(/\bvi\s*\.\s*(\w+)/g)) {
      if (!VI_ALLOWED.has(match[1])) {
        problems.push(`${where}: uses vi.${match[1]} (tests may only use simple mocks and timers)`);
        break;
      }
    }
  }
  if (name === DEMO_FILE) {
    if (!/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["'];?/.test(file.content)) {
      problems.push(`${where}: must start with "use client"`);
    }
    if (!/\bexport\s+default\s+function\b/.test(file.content)) {
      problems.push(`${where}: needs a default export function (the demo component)`);
    }
  }
  if (
    /\bexport\s+(?:const|async\s+function|function)\s+(?:metadata|generateMetadata|dynamic|revalidate|runtime)\b/.test(
      file.content,
    )
  ) {
    problems.push(`${where}: exports page settings (the page is written by the workflow)`);
  }
  return problems;
}

/** Browser storage: literal keys with the demo's prefix only; no clearing or index access. */
function checkStorage(content: string, slug: string): string[] {
  const prefix = `demo:${slug}:`;
  const problems: string[] = [];
  const calls = /\b(?:localStorage|sessionStorage)\s*\.\s*(\w+)\s*(\()?\s*(?:(["'])([^"'\n]*)\3)?/g;
  for (const match of content.matchAll(calls)) {
    const [, method, call, , key] = match;
    if (!["getItem", "setItem", "removeItem"].includes(method) || !call) {
      problems.push(`uses ${method} on browser storage (only getItem, setItem and removeItem)`);
    } else if (key === undefined || !key.startsWith(prefix)) {
      problems.push(`browser storage keys must be literal strings starting with ${prefix}`);
    }
  }
  if (/\b(?:localStorage|sessionStorage)\s*\[/.test(content)) {
    problems.push("uses index access on browser storage");
  }
  return [...new Set(problems)];
}

/** Problems with the proposed files, in fixed words plus quoted paths. */
export function validateFiles(files: GeneratedFile[], slug: string): string[] {
  const dir = `src/app/demos/${slug}/`;
  if (files.length === 0) return ["no files were returned"];
  const problems: string[] = [];
  if (files.length > MAX_FILES) problems.push(`more than ${MAX_FILES} files`);
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) problems.push("the same file appears more than once");
  if (!paths.includes(`${dir}${DEMO_FILE}`)) problems.push(`no ${dir}${DEMO_FILE}`);
  if (!paths.some((path) => /\.test\.tsx?$/.test(path))) problems.push("no test file");
  const own = new Set(paths.map((path) => path.slice(dir.length).replace(/\.tsx?$/, "")));
  const total = files.reduce(
    (sum, file) => sum + new TextEncoder().encode(file.content).byteLength,
    0,
  );
  if (total > MAX_TOTAL_BYTES) problems.push(`more than ${MAX_TOTAL_BYTES} bytes in total`);
  for (const file of files) problems.push(...checkFile(file, dir, slug, own));
  return problems;
}
