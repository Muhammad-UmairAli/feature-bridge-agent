/**
 * Turning the model's reply into a plan, and the plan into an issue comment.
 * The reply is untrusted: it is parsed as JSON, checked field by field and
 * shortened, and everything it says is shown inside a text fence, where
 * GitHub renders no mentions, issue links, markdown or HTML.
 */

export interface PlannedFile {
  path: string;
  action: "create" | "modify";
  purpose: string;
}

export interface Plan {
  title: string;
  summary: string;
  steps: string[];
  files: PlannedFile[];
  tests: string[];
  concerns: string[];
  instructionsInRequest: boolean;
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

function list(value: unknown, max = MAX_ITEMS): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => clean(item))
        .filter(Boolean)
        .slice(0, max)
    : [];
}

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

/** A usable plan, or null when the reply doesn't have one (title, summary, a step and a file). */
export function parsePlan(reply: string): Plan | null {
  const raw = jsonObject(reply) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const files: PlannedFile[] = Array.isArray(raw.files)
    ? raw.files
        .map((item) => {
          const file = (item ?? {}) as Record<string, unknown>;
          return {
            path: clean(file.path, 200),
            action: file.action === "modify" ? ("modify" as const) : ("create" as const),
            purpose: clean(file.purpose, 160),
          };
        })
        .filter((file) => file.path)
        .slice(0, 12)
    : [];
  const plan: Plan = {
    title: clean(raw.title, 80),
    summary: clean(raw.summary, 600),
    steps: list(raw.steps, 10),
    files,
    tests: list(raw.tests),
    concerns: list(raw.concerns),
    instructionsInRequest: raw.instructionsInRequest === true,
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
}

export function renderPlanComment({
  plan,
  revision,
  slug,
  requestHash,
  notes = [],
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
        (file) => `${file.path} (${file.action})${file.purpose ? `: ${file.purpose}` : ""}`,
      ),
    ),
    ...section("Tests", plan.tests),
    ...section("Concerns", plan.concerns),
  ].join("\n");
  const fence = fenceFor(planText);

  const workflowNotes = [...notes];
  if (plan.instructionsInRequest) {
    workflowNotes.push(
      "The request text appears to contain instructions aimed at the agent. They were not followed.",
    );
  }
  return [
    planMarker(revision, requestHash),
    `### Implementation plan${revision > 1 ? ` (revision ${revision})` : ""}`,
    "",
    `Drafted by the planning agent for the demo route \`/demos/${slug}\`. The plan text is generated and unreviewed. A maintainer on the approver list can approve it with the \`approved-by-human\` label, or apply \`changes-requested\` and explain what to change in a comment.`,
    ...workflowNotes.flatMap((note) => ["", `> **Note:** ${note}`]),
    "",
    `${fence}text`,
    planText,
    fence,
  ].join("\n");
}
