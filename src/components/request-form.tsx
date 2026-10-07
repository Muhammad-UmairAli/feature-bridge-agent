"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { BotCheck, type BotCheckHandle } from "@/components/bot-check";
import { Button } from "@/components/ui/button";
import {
  ACCEPTED_SCREENSHOT_TYPES,
  type FieldErrors,
  type SubmitOutcome,
  checkBeforeSubmit,
  postRequest,
} from "@/lib/requests/client";
import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  characterCount,
  normaliseDescription,
} from "@/lib/requests/validation";

type Status =
  | { state: "editing"; message: string | null; fields: FieldErrors }
  | { state: "submitting" }
  | { state: "done"; id: number; trackingUrl: string };

const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-foreground aria-[invalid=true]:border-destructive";
const linkButtonClass = "text-primary underline underline-offset-4";
const COMPLETE_CHECK = "Complete the verification check first.";
const GENERIC_FAILURE = "We couldn't submit your request. Please try again in a moment.";

/**
 * A short, debounced message for screen readers about the description length,
 * spoken only at meaningful thresholds rather than on every keystroke.
 */
function lengthAnnouncement(count: number): string {
  if (count > DESCRIPTION_MAX_LENGTH)
    return `${count - DESCRIPTION_MAX_LENGTH} characters over the limit.`;
  if (DESCRIPTION_MAX_LENGTH - count <= 200)
    return `${DESCRIPTION_MAX_LENGTH - count} characters left.`;
  if (count >= DESCRIPTION_MIN_LENGTH) return "Minimum length reached.";
  return "";
}

export function RequestForm({
  botCheckSiteKey,
  submit = postRequest,
}: {
  botCheckSiteKey: string | undefined;
  submit?: (form: FormData, botCheckToken: string) => Promise<SubmitOutcome>;
}) {
  const baseId = useId();
  const ids = {
    notice: `${baseId}-notice`,
    description: `${baseId}-description`,
    screenshot: `${baseId}-screenshot`,
    botCheckError: `${baseId}-botcheck-error`,
    done: `${baseId}-done`,
  };
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotConsent, setScreenshotConsent] = useState(false);
  const [status, setStatus] = useState<Status>({ state: "editing", message: null, fields: {} });
  const [announcement, setAnnouncement] = useState("");
  const [botCheckToken, setBotCheckToken] = useState<string | null>(null);
  const botCheckRef = useRef<BotCheckHandle>(null);
  const inFlight = useRef(false);
  const focusDescriptionNext = useRef(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const screenshotRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  const fields = status.state === "editing" ? status.fields : {};
  const message = status.state === "editing" ? status.message : null;
  const submitting = status.state === "submitting";
  const count = characterCount(normaliseDescription(description));

  // Announce length thresholds about a second after typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(lengthAnnouncement(count)), 1000);
    return () => clearTimeout(timer);
  }, [count]);

  // Move focus to whatever the user needs to read or fix next.
  useEffect(() => {
    if (status.state === "done") {
      doneRef.current?.focus();
      return;
    }
    if (status.state !== "editing") return;
    if (focusDescriptionNext.current) {
      focusDescriptionNext.current = false;
      descriptionRef.current?.focus();
    } else if (status.fields.description) {
      descriptionRef.current?.focus();
    } else if (status.fields.screenshot) {
      screenshotRef.current?.focus();
    } else if (status.message) {
      alertRef.current?.focus();
    }
  }, [status]);

  /** New token from the widget; it also clears an earlier "complete the check" error. */
  function onBotCheckToken(token: string | null) {
    setBotCheckToken(token);
    if (!token) return;
    setStatus((current) => {
      if (current.state !== "editing" || !current.fields.botCheckToken) return current;
      const remaining = { ...current.fields };
      delete remaining.botCheckToken;
      const message = Object.keys(remaining).length > 0 ? current.message : null;
      return { state: "editing", message, fields: remaining };
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return; // ignore double submits
    const formElement = event.currentTarget;

    const clientErrors = checkBeforeSubmit(description, screenshot, screenshotConsent);
    const fieldProblems = Object.keys(clientErrors).length > 0;
    if (!botCheckToken) clientErrors.botCheckToken = COMPLETE_CHECK;
    if (fieldProblems || !botCheckToken) {
      setStatus({
        state: "editing",
        message: fieldProblems ? "Please fix the highlighted fields." : COMPLETE_CHECK,
        fields: clientErrors,
      });
      return;
    }

    inFlight.current = true;
    setStatus({ state: "submitting" });
    let outcome: SubmitOutcome;
    try {
      outcome = await submit(new FormData(formElement), botCheckToken);
    } catch {
      outcome = { kind: "failed", message: GENERIC_FAILURE };
    } finally {
      inFlight.current = false;
    }

    if (outcome.kind === "created") {
      setStatus({ state: "done", id: outcome.id, trackingUrl: outcome.trackingUrl });
      return;
    }
    // Tokens are single-use: get a fresh one before the next attempt.
    botCheckRef.current?.reset();
    setStatus({
      state: "editing",
      message: outcome.message,
      fields: outcome.kind === "invalid" ? outcome.fields : {},
    });
  }

  function removeScreenshot() {
    setScreenshot(null);
    setScreenshotConsent(false);
    const input = screenshotRef.current;
    if (input) {
      // Clear the native file input too, so the file isn't submitted with the form.
      try {
        input.value = "";
      } catch {
        // Some environments refuse to reset file inputs; the state above still clears.
      }
      input.focus();
    }
  }

  function startAnother() {
    setDescription("");
    setScreenshot(null);
    setScreenshotConsent(false);
    setBotCheckToken(null);
    focusDescriptionNext.current = true;
    setStatus({ state: "editing", message: null, fields: {} });
  }

  if (status.state === "done") {
    return (
      <section aria-labelledby={ids.done} className="space-y-4 rounded-lg border border-border p-6">
        <h2
          id={ids.done}
          ref={doneRef}
          tabIndex={-1}
          className="text-xl font-semibold focus:outline-none"
        >
          Request submitted
        </h2>
        <p className="text-muted-foreground">
          Request #{status.id} is in. Follow its progress on its tracking page. Keep the link: there
          is no list of requests.
        </p>
        <p className="flex flex-wrap gap-4">
          <Link href={status.trackingUrl} className={linkButtonClass}>
            Track request #{status.id}
          </Link>
          <button type="button" onClick={startAnother} className={linkButtonClass}>
            Submit another request
          </button>
        </p>
      </section>
    );
  }

  // Error first, so screen readers hear the problem before the hints.
  const describedBy = (...parts: (string | false | undefined)[]) =>
    parts.filter(Boolean).join(" ") || undefined;

  return (
    <form onSubmit={onSubmit} noValidate aria-describedby={ids.notice} className="space-y-6">
      <p
        id={ids.notice}
        className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground"
      >
        Submissions are public. Don&apos;t include confidential information, personal data or
        secrets.
      </p>

      {message && (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="rounded-md border border-destructive p-3 text-sm focus:outline-none"
        >
          {message}
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor={ids.description} className="block font-medium">
          Describe the feature
        </label>
        <p id={`${ids.description}-hint`} className="text-sm text-muted-foreground">
          What should it do, and where have you seen it? {DESCRIPTION_MIN_LENGTH}–
          {DESCRIPTION_MAX_LENGTH} characters.
        </p>
        <textarea
          id={ids.description}
          ref={descriptionRef}
          name="description"
          rows={6}
          required
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          aria-invalid={fields.description ? true : undefined}
          aria-describedby={describedBy(
            fields.description && `${ids.description}-error`,
            `${ids.description}-hint`,
            `${ids.description}-count`,
          )}
          className={fieldClass}
        />
        <p id={`${ids.description}-count`} className="text-sm text-muted-foreground">
          {count} of {DESCRIPTION_MAX_LENGTH} characters
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        {fields.description && (
          <p id={`${ids.description}-error`} className="text-sm text-destructive">
            {fields.description}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label htmlFor={ids.screenshot} className="block font-medium">
          Screenshot <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <p id={`${ids.screenshot}-hint`} className="text-sm text-muted-foreground">
          PNG, JPEG or WebP, up to 4 MB. Screenshots are published with the request: blur personal
          or confidential details first. Image metadata such as location is removed.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            id={ids.screenshot}
            ref={screenshotRef}
            name="screenshot"
            type="file"
            accept={ACCEPTED_SCREENSHOT_TYPES.join(",")}
            onChange={(event) => setScreenshot(event.target.files?.[0] ?? null)}
            aria-invalid={fields.screenshot ? true : undefined}
            aria-describedby={describedBy(
              fields.screenshot && `${ids.screenshot}-error`,
              `${ids.screenshot}-hint`,
            )}
            className="block text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-foreground"
          />
          {screenshot && (
            <button
              type="button"
              onClick={removeScreenshot}
              className={`text-sm ${linkButtonClass}`}
            >
              Remove screenshot
            </button>
          )}
        </div>
        {screenshot && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="screenshotConsent"
              value="yes"
              checked={screenshotConsent}
              onChange={(event) => setScreenshotConsent(event.target.checked)}
              className="mt-1"
            />
            <span>
              I understand this screenshot will be public and contains nothing personal or
              confidential.
            </span>
          </label>
        )}
        {fields.screenshot && (
          <p id={`${ids.screenshot}-error`} className="text-sm text-destructive">
            {fields.screenshot}
          </p>
        )}
      </div>

      <BotCheck
        ref={botCheckRef}
        siteKey={botCheckSiteKey}
        onToken={onBotCheckToken}
        describedBy={fields.botCheckToken ? ids.botCheckError : undefined}
      />
      {fields.botCheckToken && (
        <p id={ids.botCheckError} className="text-sm text-destructive">
          {fields.botCheckToken}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled={submitting || !botCheckSiteKey}
          focusableWhenDisabled
          aria-describedby={fields.botCheckToken ? ids.botCheckError : undefined}
        >
          {submitting ? "Submitting…" : "Submit request"}
        </Button>
        <p className="sr-only" role="status" aria-live="polite">
          {submitting ? "Submitting your request…" : ""}
        </p>
      </div>
    </form>
  );
}
