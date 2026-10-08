/**
 * The build after an accepted approval, in three jobs that never share secrets:
 *
 * - generate (model key only, Node standard library only): re-verify the
 *   approval without side effects, record that this approval is being built
 *   (so it builds at most once), generate and validate the demo, and hand the
 *   files on as a compressed bundle tied to the approval, with its SHA-256.
 * - check (no secrets, read-only token): lint the files with the
 *   repository's own ESLint config. ESLint's plugins run there, never next to
 *   a key.
 * - publish (agent App key only): check the bundle, re-verify the approval,
 *   publish the files as a pull request, and report on the request.
 *
 * No job runs generated code. A withdrawn or superseded approval stops
 * quietly; anything else that stops a build hands the request to a maintainer
 * (`escalated-to-human`) with fixed text. The bundle is passed through job
 * outputs, so the generated files appear in the public run logs (they become
 * public in the pull request anyway); comments and log lines otherwise carry
 * kinds and statuses only.
 */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  type ExpectedApproval,
  type GateSettings,
  buildMarker,
  verifyApproval,
} from "../gate/gate.mts";
import { GitHubApiError, type GitHubClient } from "../lib/github.mts";
import { type LlmClient, LlmError } from "../lib/llm.mts";
import type { Log } from "../planner/planner.mts";
import { LABELS } from "../planner/request.mts";
import type { GeneratedFile } from "./files.mts";
import { GenerationFailure, generateDemo } from "./generate.mts";
import {
  PublishIncomplete,
  type Published,
  PublishRefused,
  type PublishInput,
} from "./publish.mts";

export const BUILD_STOPPED_MARKER = "<!-- feature-bridge-agent:build-stopped -->";
export const BUILD_CANCELLED_MARKER = "<!-- feature-bridge-agent:build-cancelled -->";
export const PULL_OPENED_MARKER = "<!-- feature-bridge-agent:pull-opened -->";
/** Leaves room under the operating system's limit for one environment variable (128 KiB). */
export const MAX_BUNDLE_CHARS = 100_000;
const MAX_UNZIPPED_BYTES = 512 * 1024;

export interface BuildSettings extends GateSettings {
  expected: ExpectedApproval;
}

export interface Bundle {
  issueNumber: number;
  slug: string;
  /** The approval and plan the files were built from. */
  approvalEventId: number;
  planSha256: string;
  files: GeneratedFile[];
}

/** gzip + base64, small enough for a job output and an environment variable. */
export function encodeBundle(bundle: Bundle): { bundle: string; sha256: string } {
  const encoded = gzipSync(Buffer.from(JSON.stringify(bundle))).toString("base64");
  return { bundle: encoded, sha256: createHash("sha256").update(encoded).digest("hex") };
}

/** The bundle, or null if it was changed or isn't one. */
export function decodeBundle(encoded: string, sha256: string): Bundle | null {
  if (encoded.length > MAX_BUNDLE_CHARS || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) return null;
  if (createHash("sha256").update(encoded).digest("hex") !== sha256) return null;
  try {
    const raw = JSON.parse(
      gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength: MAX_UNZIPPED_BYTES }).toString(
        "utf8",
      ),
    ) as Bundle;
    const files = Array.isArray(raw.files) ? raw.files : [];
    const valid =
      Number.isSafeInteger(raw.issueNumber) &&
      Number.isSafeInteger(raw.approvalEventId) &&
      typeof raw.slug === "string" &&
      typeof raw.planSha256 === "string" &&
      files.length > 0 &&
      files.every((file) => typeof file?.path === "string" && typeof file?.content === "string");
    return valid
      ? {
          issueNumber: raw.issueNumber,
          slug: raw.slug,
          approvalEventId: raw.approvalEventId,
          planSha256: raw.planSha256,
          files,
        }
      : null;
  } catch {
    return null;
  }
}

/** Fixed hand-over: a comment and `escalated-to-human`, each attempted even if the other fails. */
async function handOver(
  github: GitHubClient,
  log: Log,
  number: number,
  text: string,
): Promise<void> {
  for (const step of [
    () =>
      github.createComment(
        number,
        `${BUILD_STOPPED_MARKER}\n### Build stopped\n\n${text} A maintainer will take it from here.`,
      ),
    () => github.addLabels(number, [LABELS.escalatedToHuman]),
  ]) {
    try {
      await step();
    } catch (error) {
      log("error", "build.handover_failed", {
        issue: number,
        ...(error instanceof GitHubApiError ? { status: error.status } : {}),
      });
    }
  }
}

const NOT_CURRENT =
  "The approval no longer passes the checks (for example the plan, the request or its labels changed), so it wasn't built.";

function generationText(error: unknown): { reason: string; text: string } {
  if (error instanceof GenerationFailure) {
    const texts: Record<GenerationFailure["reason"], string> = {
      plan_refused: "The approved plan contains code or markers, so it wasn't built automatically.",
      declined: "The coding agent couldn't build this plan within the demo rules.",
      reply_truncated: "The coding agent's answer was too long.",
      unusable_reply: "The coding agent didn't return usable files.",
      invalid_files: "The coding agent's files didn't pass the demo checks.",
    };
    return { reason: error.reason, text: texts[error.reason] };
  }
  if (error instanceof LlmError) {
    return error.kind === "cap_exceeded"
      ? {
          reason: "cap_exceeded",
          text: "The coding agent stopped because this request reached its token budget.",
        }
      : { reason: `llm_${error.kind}`, text: "The coding agent couldn't reach the model." };
  }
  return { reason: "unexpected", text: "The coding agent hit an unexpected error." };
}

export interface GenerateJobDeps {
  github: GitHubClient;
  log: Log;
  createLlm: () => LlmClient;
  readContext: () => Promise<{ agentsGuide: string; context: GeneratedFile[] }>;
}

export type GenerateJobResult =
  | { kind: "built"; bundle: string; sha256: string; files: number }
  | { kind: "stopped" }
  | { kind: "failed" };

export async function runGenerate(
  settings: BuildSettings,
  deps: GenerateJobDeps,
): Promise<GenerateJobResult> {
  const { github, log } = deps;
  const number = settings.issueNumber;
  const verified = await verifyApproval(settings, { github, log }, settings.expected);
  if (!verified.ok) {
    // Withdrawn, superseded or already built: nothing to do here. A refusal
    // would otherwise leave the request "building" with no explanation.
    if (verified.reason === "refused") {
      await handOver(github, log, number, NOT_CURRENT);
      return { kind: "failed" };
    }
    return { kind: "stopped" };
  }
  const { approval } = verified;
  // Recorded before any model call: re-running this approval can't build twice.
  await github.createComment(
    number,
    `${buildMarker(settings.expected.approvalEventId)}\n### Building\n\nThe approved plan is being built into a pull request.`,
  );

  let llm: LlmClient | null = null;
  try {
    const { agentsGuide, context } = await deps.readContext();
    llm = deps.createLlm();
    const files = await generateDemo(llm, {
      slug: approval.slug,
      planText: approval.planText,
      agentsGuide,
      context,
    });
    const { bundle, sha256 } = encodeBundle({
      issueNumber: number,
      slug: approval.slug,
      approvalEventId: approval.approvalEventId,
      planSha256: approval.planSha256,
      files,
    });
    if (bundle.length > MAX_BUNDLE_CHARS) {
      throw new GenerationFailure("invalid_files", ["the files are too large to hand on"]);
    }
    log("info", "build.generated", { issue: number, files: files.length, tokens: llm.tokensUsed });
    return { kind: "built", bundle, sha256, files: files.length };
  } catch (error) {
    const { reason, text } = generationText(error);
    log("error", "build.failed", {
      issue: number,
      reason,
      ...(error instanceof GenerationFailure ? { problems: error.problems.length } : {}),
      ...(llm ? { tokens: llm.tokensUsed } : {}),
    });
    await handOver(github, log, number, text);
    return { kind: "failed" };
  }
}

/**
 * The check job: lint the bundle's files with the repository's own rules.
 * Returns the problems (rule ids and quoted paths only); an empty list passes.
 */
export async function runCheck(
  bundleText: string,
  sha256: string,
  lint: (files: GeneratedFile[]) => Promise<string[]>,
): Promise<string[]> {
  const bundle = decodeBundle(bundleText, sha256);
  if (!bundle) return ["the generated files didn't arrive intact"];
  return lint(bundle.files);
}

export interface PublishJobDeps {
  github: GitHubClient;
  log: Log;
  /** An agent App installation token (contents and pull requests write). */
  token: () => Promise<string>;
  revoke: (token: string) => Promise<void>;
  publish: (token: string, input: PublishInput) => Promise<Published>;
}

export type PublishJobResult =
  { kind: "published"; pullNumber: number } | { kind: "stopped" } | { kind: "failed" };

function publishText(error: unknown): { reason: string; text: string } {
  if (error instanceof PublishRefused) {
    const texts: Record<PublishRefused["reason"], string> = {
      branch_exists: "A branch for this request already exists.",
      pull_exists: "A pull request for this request already exists.",
      folder_exists: "A demo for this request already exists.",
      invalid_files: "The generated files didn't pass the final checks.",
    };
    return { reason: error.reason, text: texts[error.reason] };
  }
  if (error instanceof PublishIncomplete) {
    return {
      reason: "pull_not_opened",
      text: "The branch was pushed, but the pull request couldn't be opened.",
    };
  }
  return { reason: "unexpected", text: "The demo couldn't be published." };
}

export async function runPublish(
  settings: BuildSettings,
  deps: PublishJobDeps,
  repo: string,
  bundleText: string,
  sha256: string,
): Promise<PublishJobResult> {
  const { github, log } = deps;
  const number = settings.issueNumber;
  const bundle = decodeBundle(bundleText, sha256);
  const matches =
    bundle !== null &&
    bundle.issueNumber === number &&
    bundle.approvalEventId === settings.expected.approvalEventId &&
    bundle.planSha256 === settings.expected.planSha256;
  if (!bundle || !matches) {
    log("error", "build.failed", { issue: number, reason: "bad_bundle" });
    await handOver(github, log, number, "The generated files didn't arrive intact.");
    return { kind: "failed" };
  }
  // The approval must still be the one that was built: it may have been
  // withdrawn, replaced or invalidated while the model was working.
  const verified = await verifyApproval(
    settings,
    { github, log, allowBuilt: true },
    settings.expected,
  );
  if (!verified.ok || verified.approval.slug !== bundle.slug) {
    const reason = verified.ok ? "refused" : verified.reason;
    log("info", "build.stopped", { issue: number, reason });
    if (reason === "superseded") return { kind: "stopped" }; // the newer approval's run takes over
    if (reason === "withdrawn") {
      await github
        .createComment(
          number,
          `${BUILD_CANCELLED_MARKER}\n### Build cancelled\n\nThe approval was withdrawn while the demo was being built, so nothing was published.`,
        )
        .catch(() => log("error", "build.comment_failed", { issue: number }));
      return { kind: "stopped" };
    }
    await handOver(
      github,
      log,
      number,
      NOT_CURRENT.replace("it wasn't built", "nothing was published"),
    );
    return { kind: "failed" };
  }

  let token: string | null = null;
  try {
    token = await deps.token();
    const published = await deps.publish(token, {
      repo,
      issueNumber: number,
      slug: bundle.slug,
      files: bundle.files,
    });
    log("info", "build.published", { issue: number, pull: published.pullNumber });
    try {
      await github.createComment(
        number,
        `${PULL_OPENED_MARKER}\n### Pull request opened\n\nThe demo is in #${published.pullNumber}. CI runs the tests, lint and the write-scope check, an automated review follows, and a maintainer reviews it before anything is merged.`,
      );
    } catch {
      log("error", "build.comment_failed", { issue: number });
    }
    return { kind: "published", pullNumber: published.pullNumber };
  } catch (error) {
    const { reason, text } = publishText(error);
    log("error", "build.failed", {
      issue: number,
      reason,
      name: error instanceof Error ? error.name : "unknown",
      ...(error instanceof GitHubApiError ? { status: error.status } : {}),
    });
    await handOver(github, log, number, text);
    return { kind: "failed" };
  } finally {
    if (token) await deps.revoke(token);
  }
}
