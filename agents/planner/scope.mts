/**
 * Whether a plan can wait for approval, or needs a maintainer first. This is a
 * triage signal, not the enforcement boundary (the build and CI re-check what
 * actually changes). Code checks the listed files and scans the plan text for
 * anything that points outside the demo folder; the model's own flags can only
 * add reasons, never remove them. A determined model can still describe
 * out-of-scope behaviour in plain words, which is why a human approves.
 */
import { NEEDS, type Plan } from "./plan.mts";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Next.js file names with special meaning; only `page` is allowed in a demo (see AGENTS.md). */
const SPECIAL_NAMES = new Set([
  "layout",
  "route",
  "loading",
  "error",
  "global-error",
  "not-found",
  "global-not-found",
  "forbidden",
  "unauthorized",
  "template",
  "default",
  "sitemap",
  "robots",
  "manifest",
  "middleware",
  "proxy",
  "instrumentation",
  "instrumentation-client",
  "mdx-components",
]);
/** Metadata image routes, including numbered variants such as `icon1`, which run as route handlers. */
const METADATA_IMAGE = /^(?:icon|apple-icon|opengraph-image|twitter-image)\d*$/;

/**
 * True when `path` is a file a demo may contain: flat inside its folder,
 * kebab-case, `.ts`/`.tsx` (optionally `.test`), and `page` only as `page.tsx`.
 */
export function isAllowedDemoPath(path: string, slug: string): boolean {
  if (!SLUG.test(slug) || slug.length > 40) return false;
  const prefix = `src/app/demos/${slug}/`;
  if (!path.startsWith(prefix)) return false;
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)(\.test)?\.(tsx|ts)$/.exec(path.slice(prefix.length));
  if (!match) return false;
  const [, name, test, extension] = match;
  if (name === "page") return Boolean(test) || extension === "tsx";
  return !SPECIAL_NAMES.has(name) && !METADATA_IMAGE.test(name);
}

/** Things plan text may not mention, with the fixed reason each one adds. */
const TEXT_RULES: [RegExp, string][] = [
  [/\bhttps?:\/\//i, "the plan mentions an external URL"],
  [
    /\bpackage\.json\b|pnpm-lock|\b(?:pnpm|npm|yarn|bun)\s+(?:add|install|i)\b|\bnpx\b/i,
    "the plan mentions installing or changing dependencies",
  ],
  [
    /\.github\b|\bAGENTS\.md\b|\bprocess\.env\b|\.env\b|\bnext\.config\b|\bmiddleware\b/i,
    "the plan mentions repository configuration, environment variables or secrets",
  ],
  [
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bserver actions?\b|["']use server["']/i,
    "the plan mentions network calls or server code",
  ],
  [
    /\bdangerouslySetInnerHTML\b|\beval\s*\(|\bnew Function\b|<script|<iframe/i,
    "the plan mentions code injection or embedded content",
  ],
];

const WORD = /[^\s"'`<>]+/g;
/** File extensions worth checking (not `.js`, so "Next.js" isn't mistaken for a file). */
const FILE_EXTENSION = /\.(?:tsx?|mts|json|css|scss|md|ya?ml|env|sh|html)$/i;
const ROOTED =
  /^(?:\.{0,2}\/|@\/)?(?:src|app|pages|public|components|lib|agents|scripts|\.github|node_modules|docs|demos|api)\//i;
const ROUTE = /^\/[\w-]+\/[\w-]/;

/** Words in the text that look like file paths or routes ("and/or" and "+/-" don't). */
function pathLikeWords(text: string): string[] {
  return (text.match(WORD) ?? [])
    .map((word) => word.replace(/^[([{]+/, "").replace(/[.,;:!?)\]}]+$/, ""))
    .filter((word) => FILE_EXTENSION.test(word) || ROOTED.test(word) || ROUTE.test(word));
}

/** References a demo plan may make: its own folder, route and files, and the shared UI imports. */
function isAllowedReference(ref: string, slug: string): boolean {
  if (isAllowedDemoPath(ref, slug)) return true;
  if (ref === `src/app/demos/${slug}` || ref === `src/app/demos/${slug}/`) return true;
  if (ref === `/demos/${slug}` || ref === `demos/${slug}`) return true;
  if (/^@\/components\/ui\/[a-z0-9-]+$/.test(ref) || ref === "@/lib/utils") return true;
  // A bare file name is fine when it is one of this plan's allowed files.
  return (
    /^[a-z0-9-]+(?:\.test)?\.tsx?$/.test(ref) &&
    isAllowedDemoPath(`src/app/demos/${slug}/${ref}`, slug)
  );
}

export interface ScopeCheck {
  /** Fixed sentences explaining why a maintainer is needed; empty when the plan can go ahead. */
  reasons: string[];
  rejectedPaths: number;
  needs: string[];
}

export function checkScope(plan: Plan, slug: string): ScopeCheck {
  const reasons: string[] = [];
  const add = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  const rejectedPaths = plan.files.filter((file) => !isAllowedDemoPath(file.path, slug)).length;
  if (rejectedPaths > 0) {
    add(
      `${rejectedPaths} planned file${rejectedPaths === 1 ? " is" : "s are"} outside \`src/app/demos/${slug}/\` or not allowed there (see Files)`,
    );
  }
  const paths = plan.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) add("the plan lists the same file more than once");
  if (!paths.includes(`src/app/demos/${slug}/page.tsx`)) add("the plan has no `page.tsx`");
  if (plan.files.some((file) => file.action === "other")) {
    add("a planned file has an action other than create or modify");
  }
  if (plan.parse.droppedFiles > 0) add("some planned file entries couldn't be checked");
  if (plan.parse.alteredPaths > 0) add("a planned path contained hidden characters");
  if (plan.parse.droppedItems > 0) add("parts of the plan were cut to fit");

  const text = [
    plan.title,
    plan.summary,
    ...plan.steps,
    ...plan.tests,
    ...plan.concerns,
    ...plan.files.map((file) => file.purpose),
  ].join("\n");
  for (const [pattern, reason] of TEXT_RULES) if (pattern.test(text)) add(reason);
  if (pathLikeWords(text).some((word) => !isAllowedReference(word, slug))) {
    add("the plan text names files or folders outside the demo folder");
  }

  for (const need of plan.needs) add(NEEDS[need]);
  if (plan.instructionsInRequest) {
    add("the request text appears to contain instructions aimed at the agent");
  }
  return { reasons, rejectedPaths, needs: plan.needs };
}
