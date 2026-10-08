/**
 * Turning the model's reply into a plan, and the plan into an issue comment.
 * The reply is untrusted: it is parsed as JSON, checked field by field and
 * shortened, and everything it says is shown inside a text fence, where
 * GitHub renders no mentions, issue links, markdown or HTML.
 */

/** What the model is asked to declare about the request (all false for a standard demo). */
export const NEEDS = {
  outsideDemoArea: "it needs changes outside the demo folder",
  newDependency: "it needs a new dependency",
  newIntegration: "it needs a new external integration or network access",
  authChange: "it needs authentication or permission changes",
  dataSchemaChange: "it needs a database, a data schema or server-side storage",
} as const;

export type Need = keyof typeof NEEDS;

export interface PlannedFile {
  path: string;
  /** `other` for anything the model wrote that isn't create or modify. */
  action: "create" | "modify" | "other";
  purpose: string;
}

/** What parsing had to leave out or change; any of it sends the plan to a maintainer. */
export interface ParseNotes {
  /** File entries that weren't usable or didn't fit, so they couldn't be checked. */
  droppedFiles: number;
  /** Steps, tests or concerns cut to fit. */
  droppedItems: number;
  /** Paths that changed when invisible characters were removed. */
  alteredPaths: number;
}

export interface Plan {
  title: string;
  summary: string;
  steps: string[];
  files: PlannedFile[];
  tests: string[];
  concerns: string[];
  /** What the model says the request needs beyond a standard demo. */
  needs: Need[];
  instructionsInRequest: boolean;
  parse: ParseNotes;
}

const MAX_TEXT = 300;
const MAX_ITEMS = 8;

/**
 * One line of plain text, at most `max` code points. Characters a reader can't
 * see (zero-width, bidi overrides, Unicode tags, private use) are dropped, so
 * the approver sees everything a later reader of the plan will.
 */
export function clean(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  const flat = value
    .normalize("NFC")
    .replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

/** Usable text items, and how many were dropped (unusable or over `max`). */
function list(value: unknown, max = MAX_ITEMS): { items: string[]; dropped: number } {
  if (!Array.isArray(value)) return { items: [], dropped: 0 };
  const usable = value.map((item) => clean(item)).filter(Boolean);
  return { items: usable.slice(0, max), dropped: value.length - Math.min(usable.length, max) };
}

const MAX_FILES = 12;

/** Parse `text` as JSON, or null. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The JSON object in a reply, tolerating reasoning (`<think>…</think>`), a
 * fenced block, or prose around it.
 */
function jsonObject(reply: string): unknown {
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, "");
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text);
  const fromFence = fenced ? tryJson(fenced[1]) : null;
  if (fromFence) return fromFence;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? null : tryJson(text.slice(start, end + 1));
}

/** The flags set to exactly `true`; anything else counts as not needed. */
function needsOf(value: unknown): Need[] {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return (Object.keys(NEEDS) as Need[]).filter((need) => raw[need] === true);
}

/** A usable plan, or null when the reply doesn't have one (title, summary, a step and a file). */
export function parsePlan(reply: string): Plan | null {
  const raw = jsonObject(reply) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const rawFiles = Array.isArray(raw.files) ? raw.files : [];
  let alteredPaths = 0;
  const usableFiles: PlannedFile[] = [];
  for (const item of rawFiles) {
    const file = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const path = clean(file.path, 200);
    if (!path) continue;
    if (typeof file.path === "string" && path !== file.path.trim()) alteredPaths += 1;
    usableFiles.push({
      path,
      action: file.action === "create" || file.action === "modify" ? file.action : "other",
      purpose: clean(file.purpose, 160),
    });
  }
  const files = usableFiles.slice(0, MAX_FILES);
  const steps = list(raw.steps, 10);
  const tests = list(raw.tests);
  const concerns = list(raw.concerns);

  const plan: Plan = {
    title: clean(raw.title, 80),
    summary: clean(raw.summary, 600),
    steps: steps.items,
    files,
    tests: tests.items,
    concerns: concerns.items,
    needs: needsOf(raw.needs),
    instructionsInRequest: raw.instructionsInRequest === true,
    parse: {
      droppedFiles: rawFiles.length - files.length,
      droppedItems: steps.dropped + tests.dropped + concerns.dropped,
      alteredPaths,
    },
  };
  return plan.title && plan.summary && plan.steps.length > 0 && plan.files.length > 0 ? plan : null;
}

/** A backtick fence longer than any backtick run inside the text (at least 3). */
function fenceFor(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/**
 * Hidden marker identifying the agent's plan comments: the revision number and
 * a hash of the request text the plan was made from, so later steps can tell
 * when a plan no longer matches an edited request.
 */
export const PLAN_MARKER =
  /^<!-- feature-bridge-agent:plan revision=(\d+)(?: request=([0-9a-f]{16}))? -->/;
export const planMarker = (revision: number, requestHash?: string) =>
  `<!-- feature-bridge-agent:plan revision=${revision}${requestHash ? ` request=${requestHash}` : ""} -->`;
/** Hidden marker on the comment posted when planning stops. */
export const STOPPED_MARKER = "<!-- feature-bridge-agent:planning-stopped -->";

export interface RenderInput {
  plan: Plan;
  revision: number;
  slug: string;
  /** From `requestHash` in request.mts. */
  requestHash: string;
  /** Notes written by the workflow itself (trusted text). */
  notes?: string[];
  /** True when the plan goes to a maintainer instead of waiting for approval. */
  triage: boolean;
}

export function renderPlanComment({
  plan,
  revision,
  slug,
  requestHash,
  notes = [],
  triage,
}: RenderInput): string {
  const section = (heading: string, items: string[], numbered = false) =>
    items.length === 0
      ? []
      : ["", heading, ...items.map((item, i) => `${numbered ? `${i + 1}.` : "-"} ${item}`)];
  const planText = [
    plan.title,
    "",
    plan.summary,
    ...section("Steps", plan.steps, true),
    ...section(
      "Files",
      plan.files.map(
        (file) =>
          `${file.path} (${file.action === "other" ? "unrecognised action" : file.action})${file.purpose ? `: ${file.purpose}` : ""}`,
      ),
    ),
    ...section("Tests", plan.tests),
    ...section("Concerns", plan.concerns),
  ].join("\n");
  const fence = fenceFor(planText);

  return [
    planMarker(revision, requestHash),
    `### Implementation plan${revision > 1 ? ` (revision ${revision})` : ""}`,
    "",
    `Drafted by the planning agent for the demo route \`/demos/${slug}\`. The plan text is generated and unreviewed.`,
    "",
    triage
      ? "It needs a maintainer before anything is built (see the note below)."
      : `Automated check: the ${plan.files.length} listed file${plan.files.length === 1 ? " is" : "s are"} allowed in the demo folder, and the plan text names nothing outside it. The model's own statements are not verified. A maintainer on the approver list can approve it with the \`approved-by-human\` label, or apply \`changes-requested\` and explain what to change in a comment.`,
    ...notes.flatMap((note) => ["", `> **Note:** ${note}`]),
    "",
    `${fence}text`,
    planText,
    fence,
  ].join("\n");
}
