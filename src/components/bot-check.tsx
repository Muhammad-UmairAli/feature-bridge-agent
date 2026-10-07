"use client";

import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";

import { TURNSTILE_ACTION } from "@/lib/bot-check/turnstile-shared";

/** The subset of the Turnstile browser API this component uses. */
interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "light" | "dark";
      size: "flexible";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<TurnstileApi> | null = null;

/** Load the Turnstile script once per page; a failed load can be retried. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    const fail = (reason: string) => {
      // Forget the failure and the dead tag, so the next mount retries cleanly.
      scriptPromise = null;
      script.remove();
      reject(new Error(reason));
    };
    script.onload = () => {
      if (!window.turnstile) return fail("missing API");
      scriptPromise = null; // window.turnstile is the source of truth from now on
      resolve(window.turnstile);
    };
    script.onerror = () => fail("script failed to load");
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface BotCheckHandle {
  /** Get a fresh token: tokens are single-use, so call after every failed submit. */
  reset(): void;
}

export function BotCheck({
  siteKey,
  onToken,
  describedBy,
  ref,
}: {
  siteKey: string | undefined;
  onToken: (token: string | null) => void;
  /** Id of an error message about the check, linked to the widget group. */
  describedBy?: string;
  ref?: Ref<BotCheckHandle>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const api = useRef<TurnstileApi | null>(null);
  const onTokenRef = useRef(onToken);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useImperativeHandle(ref, () => ({
    reset() {
      onTokenRef.current(null);
      if (api.current && widgetId.current) api.current.reset(widgetId.current);
    },
  }));

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        api.current = turnstile;
        widgetId.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
          size: "flexible",
          callback: (token) => onTokenRef.current(token),
          // Expired tokens are cleared; Turnstile then refreshes automatically.
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
      if (api.current && widgetId.current) api.current.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  if (!siteKey) {
    return (
      <p className="text-sm text-muted-foreground">
        Verification isn&apos;t configured on this deployment, so requests can&apos;t be submitted.
      </p>
    );
  }
  return (
    <div
      role="group"
      aria-label="Verification"
      aria-describedby={describedBy}
      className="space-y-2"
    >
      <div ref={containerRef} />
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          The verification check couldn&apos;t load. Check your connection or content blockers, then
          reload the page.
        </p>
      )}
    </div>
  );
}
