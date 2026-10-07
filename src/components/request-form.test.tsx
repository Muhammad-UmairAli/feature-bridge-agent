import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SubmitOutcome } from "@/lib/requests/client";
import { PNG_BYTES } from "@/test/fixtures";

import { RequestForm } from "./request-form";

type TurnstileOptions = { callback: (token: string) => void };

/** A stand-in for the Turnstile widget that issues a token as soon as it renders. */
function stubTurnstile({ issueToken = true } = {}) {
  const api = {
    render: vi.fn((_el: HTMLElement, options: TurnstileOptions) => {
      if (issueToken) options.callback("XXXX.DUMMY.TOKEN.XXXX");
      return "widget-1";
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = api;
  return api;
}

afterEach(() => {
  delete window.turnstile;
});

const VALID = "Add a dark mode toggle to the settings page, please.";

async function renderForm(outcome: SubmitOutcome | Promise<SubmitOutcome>) {
  const turnstile = stubTurnstile();
  const submit = vi.fn<(form: FormData, token: string) => Promise<SubmitOutcome>>(
    async () => outcome,
  );
  render(<RequestForm botCheckSiteKey="1x00000000000000000000AA" submit={submit} />);
  await act(async () => {}); // let the widget render and issue its token
  const description = screen.getByLabelText("Describe the feature");
  const submitButton = screen.getByRole("button", { name: "Submit request" });
  return { submit, description, submitButton, turnstile };
}

describe("RequestForm", () => {
  it("has labelled fields, a public-submission notice and a live character count", async () => {
    const { description } = await renderForm({
      kind: "created",
      id: 1,
      trackingUrl: "/requests/1",
    });
    expect(screen.getByLabelText(/Screenshot/)).toHaveAttribute("type", "file");
    expect(screen.getByText(/Submissions are public/)).toBeInTheDocument();
    fireEvent.change(description, { target: { value: "hello 😀" } });
    expect(screen.getByText("7 of 5000 characters")).toBeInTheDocument();
  });

  it("blocks a too-short description in the browser and focuses the field", async () => {
    const { submit, description, submitButton } = await renderForm({
      kind: "created",
      id: 1,
      trackingUrl: "/requests/1",
    });
    fireEvent.change(description, { target: { value: "too short" } });
    fireEvent.click(submitButton);
    expect(submit).not.toHaveBeenCalled();
    expect(description).toHaveAttribute("aria-invalid", "true");
    expect(description).toHaveAccessibleDescription(
      expect.stringMatching(/at least 20 characters/),
    );
    expect(description).toHaveFocus();
  });

  it("rejects an unsupported screenshot type before upload", async () => {
    const { submit, description, submitButton } = await renderForm({
      kind: "created",
      id: 1,
      trackingUrl: "/requests/1",
    });
    fireEvent.change(description, { target: { value: VALID } });
    const svg = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    fireEvent.change(screen.getByLabelText(/Screenshot/), { target: { files: [svg] } });
    fireEvent.click(submitButton);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Screenshot/)).toHaveAccessibleDescription(
      expect.stringMatching(/PNG, JPEG or WebP/),
    );
  });

  it("submits, shows a pending state, then the tracking link", async () => {
    let resolve!: (outcome: SubmitOutcome) => void;
    const pending = new Promise<SubmitOutcome>((r) => (resolve = r));
    const { submit, description, submitButton } = await renderForm(pending);
    fireEvent.change(description, { target: { value: VALID } });
    const png = new File([PNG_BYTES], "s.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Screenshot/), { target: { files: [png] } });
    fireEvent.click(submitButton);

    expect(await screen.findByRole("button", { name: "Submitting…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const [sent, token] = submit.mock.calls[0];
    expect(sent.get("description")).toBe(VALID);
    expect(token).toBe("XXXX.DUMMY.TOKEN.XXXX");

    await act(async () => resolve({ kind: "created", id: 42, trackingUrl: "/requests/42" }));
    expect(screen.getByRole("heading", { name: "Request submitted" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Track request #42" })).toHaveAttribute(
      "href",
      "/requests/42",
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit another request" }));
    expect(screen.getByLabelText("Describe the feature")).toHaveValue("");
  });

  it("shows server field errors on the matching field", async () => {
    const { description, submitButton } = await renderForm({
      kind: "invalid",
      message: "Please fix the highlighted fields.",
      fields: { description: "Keep the description under 5000 characters." },
    });
    fireEvent.change(description, { target: { value: VALID } });
    fireEvent.click(submitButton);
    await waitFor(() => expect(description).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByRole("alert")).toHaveTextContent("Please fix the highlighted fields.");
    expect(description).toHaveFocus();
  });

  it("shows general failures in a focused alert and keeps the input", async () => {
    const { description, submitButton } = await renderForm({
      kind: "failed",
      message: "Try again tomorrow.",
    });
    fireEvent.change(description, { target: { value: VALID } });
    fireEvent.click(submitButton);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Try again tomorrow.");
    expect(alert).toHaveFocus();
    expect(description).toHaveValue(VALID);
  });

  it("ignores a second submit while the first is in flight", async () => {
    let resolve!: (outcome: SubmitOutcome) => void;
    const { submit, description, submitButton } = await renderForm(
      new Promise<SubmitOutcome>((r) => (resolve = r)),
    );
    fireEvent.change(description, { target: { value: VALID } });
    const form = submitButton.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ kind: "failed", message: "x" }));
  });

  it("keeps focus on the button while submitting and announces progress", async () => {
    let resolve!: (outcome: SubmitOutcome) => void;
    const { description, submitButton } = await renderForm(
      new Promise<SubmitOutcome>((r) => (resolve = r)),
    );
    fireEvent.change(description, { target: { value: VALID } });
    submitButton.focus();
    fireEvent.click(submitButton);
    const busy = await screen.findByRole("button", { name: "Submitting…" });
    expect(busy).toHaveFocus();
    expect(screen.getByText("Submitting your request…")).toBeInTheDocument();
    await act(async () => resolve({ kind: "failed", message: "x" }));
  });

  it("recovers when submitting throws", async () => {
    const submit = vi.fn(async (): Promise<SubmitOutcome> => {
      throw new Error("boom");
    });
    stubTurnstile();
    render(<RequestForm botCheckSiteKey="key" submit={submit} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Describe the feature"), { target: { value: VALID } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't submit/);
    expect(screen.getByRole("button", { name: "Submit request" })).toBeEnabled();
  });

  it("moves focus to the description after starting another request", async () => {
    const { description, submitButton } = await renderForm({
      kind: "created",
      id: 3,
      trackingUrl: "/requests/3",
    });
    fireEvent.change(description, { target: { value: VALID } });
    fireEvent.click(submitButton);
    fireEvent.click(await screen.findByRole("button", { name: "Submit another request" }));
    expect(screen.getByLabelText("Describe the feature")).toHaveFocus();
  });

  it("lets the user remove an attached screenshot", async () => {
    await renderForm({ kind: "created", id: 1, trackingUrl: "/requests/1" });
    const png = new File([PNG_BYTES], "s.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Screenshot/), { target: { files: [png] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot" }));
    expect(screen.queryByRole("button", { name: "Remove screenshot" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Screenshot/)).toHaveFocus();
  });

  it("links the verification error and clears it once a token arrives", async () => {
    const api = stubTurnstile({ issueToken: false });
    const submit = vi.fn(async (): Promise<SubmitOutcome> => ({ kind: "failed", message: "x" }));
    render(<RequestForm botCheckSiteKey="key" submit={submit} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Describe the feature"), { target: { value: VALID } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Complete the verification check first.",
    );
    expect(screen.getByRole("group", { name: "Verification" })).toHaveAccessibleDescription(
      "Complete the verification check first.",
    );
    const { callback } = api.render.mock.calls[0][1];
    act(() => callback("XXXX.DUMMY.TOKEN.XXXX"));
    expect(screen.queryByText("Complete the verification check first.")).not.toBeInTheDocument();
  });

  it("disables submitting when verification isn't configured", async () => {
    render(<RequestForm botCheckSiteKey={undefined} submit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Submit request" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText(/isn't configured/)).toBeInTheDocument();
  });

  it("asks for the verification check when no token is available yet", async () => {
    stubTurnstile({ issueToken: false });
    const submit = vi.fn(async (): Promise<SubmitOutcome> => ({ kind: "failed", message: "x" }));
    render(<RequestForm botCheckSiteKey="key" submit={submit} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Describe the feature"), { target: { value: VALID } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(submit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Complete the verification check first.",
    );
  });

  it("resets the verification widget after a failed submission", async () => {
    const { description, submitButton, turnstile } = await renderForm({
      kind: "failed",
      message: "Try again.",
    });
    await act(async () => {});
    fireEvent.change(description, { target: { value: VALID } });
    fireEvent.click(submitButton);
    await screen.findByRole("alert");
    expect(turnstile.reset).toHaveBeenCalledWith("widget-1");
  });
});
