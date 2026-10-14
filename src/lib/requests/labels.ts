/**
 * Label names on request issues. Shared by the portal (which creates and reads
 * issues) and the automation that plans, approves and builds requests, so the
 * tracking page always understands the labels the workflows apply.
 */
export const LABELS = {
  /** Applied by the portal to every issue it creates. */
  portalRequest: "portal-request",
  /** The planning agent is working on a plan. */
  planning: "planning",
  /** A plan is posted and waits for a maintainer. */
  planReady: "plan-ready",
  /** A maintainer asked for a revised plan. */
  changesRequested: "changes-requested",
  /** A maintainer approved the plan; the coding agent may start. */
  approved: "approved-by-human",
  /** Planning stopped after repeated rejections. */
  needsHumanTriage: "needs-human-triage",
  /** The coding agent stopped (failing tests or too many review rounds). */
  escalatedToHuman: "escalated-to-human",
} as const;

export type LabelName = (typeof LABELS)[keyof typeof LABELS];
