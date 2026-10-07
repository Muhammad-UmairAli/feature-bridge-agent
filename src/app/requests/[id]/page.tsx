import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readGitHubAppConfig } from "@/lib/config";
import { type RequestView, getRequestStatus } from "@/lib/github/request-status";
import { log } from "@/lib/log";
import { STATUS_STEPS, STATUS_TEXT, stepIndex } from "@/lib/requests/status";

// Status changes as the request moves on; never prerender.
export const dynamic = "force-dynamic";

/** Request ids are public issue numbers, but tracking pages shouldn't be indexed. */
export async function generateMetadata({ params }: PageProps<"/requests/[id]">): Promise<Metadata> {
  const id = parseRequestId((await params).id);
  return {
    title: id === null ? "Request not found" : `Request #${id}`,
    robots: { index: false, follow: false },
  };
}

const linkClass = "text-primary underline underline-offset-4";

/** Positive integer ids only; anything else can't be a request. */
export function parseRequestId(raw: string): number | null {
  return /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
}

async function load(id: number): Promise<RequestView | null | "unavailable"> {
  try {
    return await getRequestStatus(readGitHubAppConfig(), id);
  } catch (error) {
    log.warn("tracking_page.unavailable", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return "unavailable";
  }
}

export default async function RequestPage({ params }: PageProps<"/requests/[id]">) {
  const id = parseRequestId((await params).id);
  if (id === null) notFound();
  const view = await load(id);
  if (view === null) notFound();

  if (view === "unavailable") {
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">Request #{id}</h1>
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm">
          We couldn&apos;t load this request&apos;s status right now. Please try again in a few
          minutes.
        </p>
      </section>
    );
  }

  const status = STATUS_TEXT[view.status];
  const currentStep = stepIndex(view.status);

  return (
    <section className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Request #{view.id}</h1>
        <p className="text-muted-foreground">{view.title}</p>
      </header>

      <div className="space-y-1 rounded-lg border border-border p-4">
        <p className="text-sm text-muted-foreground">Status</p>
        <p className="text-xl font-semibold">{status.label}</p>
        <p className="text-muted-foreground">{status.description}</p>
      </div>

      {currentStep >= 0 && (
        <ol className="space-y-2" aria-label="Progress">
          {STATUS_STEPS.map((step, index) => (
            <li
              key={step}
              aria-current={index === currentStep ? "step" : undefined}
              className={
                index === currentStep
                  ? "font-semibold"
                  : index < currentStep
                    ? ""
                    : "text-muted-foreground"
              }
            >
              <span aria-hidden="true">
                {index < currentStep ? "✓ " : index === currentStep ? "→ " : "○ "}
              </span>
              {STATUS_TEXT[step].label}
              {index < currentStep && <span className="sr-only"> (done)</span>}
            </li>
          ))}
        </ol>
      )}

      <ul className="space-y-2">
        {view.previewUrl && (
          <li>
            <a
              href={view.previewUrl}
              className={linkClass}
              rel="noopener noreferrer"
              target="_blank"
            >
              Try the preview (opens in a new tab)
            </a>
          </li>
        )}
        {view.pullRequest && (
          <li>
            <a href={view.pullRequest.url} className={linkClass} rel="noopener noreferrer">
              Pull request #{view.pullRequest.number}
            </a>
          </li>
        )}
        {view.issueUrl && (
          <li>
            <a href={view.issueUrl} className={linkClass} rel="noopener noreferrer">
              Discussion on GitHub
            </a>
          </li>
        )}
      </ul>
    </section>
  );
}
