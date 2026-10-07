/**
 * Request status, derived from the issue's labels and its linked pull request.
 * The same label names are applied by the planning and building workflows, so
 * this mapping is the single place that turns them into what visitors see.
 */
import { LABELS } from "./labels";

export type RequestStatus =
  | "submitted"
  | "planning"
  | "awaiting-approval"
  | "changes-requested"
  | "building"
  | "in-review"
  | "preview-ready"
  | "needs-human"
  | "merged"
  | "closed";

export interface StatusInput {
  issueState: "open" | "closed";
  labels: string[];
  pullRequest: { state: "open" | "closed"; merged: boolean } | null;
  previewUrl: string | null;
}

/** Most decisive signal first: a merged PR, then a stop, then progress. */
export function deriveStatus({
  issueState,
  labels,
  pullRequest,
  previewUrl,
}: StatusInput): RequestStatus {
  const has = (label: string) => labels.includes(label);
  if (pullRequest?.merged) return "merged";
  if (issueState === "closed") return "closed";
  if (has(LABELS.needsHumanTriage) || has(LABELS.escalatedToHuman)) return "needs-human";
  if (pullRequest?.state === "open") return previewUrl ? "preview-ready" : "in-review";
  if (has(LABELS.approved)) return "building";
  if (has(LABELS.changesRequested)) return "changes-requested";
  if (has(LABELS.planReady)) return "awaiting-approval";
  if (has(LABELS.planning)) return "planning";
  return "submitted";
}

export const STATUS_TEXT: Record<RequestStatus, { label: string; description: string }> = {
  submitted: {
    label: "Submitted",
    description: "Your request was received and is waiting for a plan.",
  },
  planning: { label: "Planning", description: "An AI agent is drafting an implementation plan." },
  "awaiting-approval": {
    label: "Awaiting approval",
    description: "A plan is ready and waiting for a maintainer to review it.",
  },
  "changes-requested": {
    label: "Changes requested",
    description: "A maintainer asked for a revised plan.",
  },
  building: {
    label: "Building",
    description: "The plan was approved and the feature is being built with tests.",
  },
  "in-review": {
    label: "In review",
    description: "The feature is built and its pull request is being reviewed.",
  },
  "preview-ready": {
    label: "Preview ready",
    description: "You can try the feature on its preview link.",
  },
  "needs-human": {
    label: "Needs a person",
    description: "Automation paused; a maintainer will take it from here.",
  },
  merged: { label: "Live", description: "The feature was merged and is live." },
  closed: { label: "Closed", description: "This request was closed." },
};

/** The happy path, for the step list. */
export const STATUS_STEPS: RequestStatus[] = [
  "submitted",
  "planning",
  "awaiting-approval",
  "building",
  "in-review",
  "preview-ready",
  "merged",
];

/** Where a status sits on the happy path (side states map to the nearest step). */
export function stepIndex(status: RequestStatus): number {
  if (status === "changes-requested") return STATUS_STEPS.indexOf("planning");
  return STATUS_STEPS.indexOf(status);
}
