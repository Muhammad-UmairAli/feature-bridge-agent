import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SubmitOutcome } from "@/lib/requests/client";
import { PNG_BYTES } from "@/test/fixtures";

import { RequestForm } from "./request-form";

const VALID = "Add a dark mode toggle to the settings page, please.";

function renderForm(outcome: SubmitOutcome | Promise<SubmitOutcome>) {
  const submit = vi.fn(async () => outcome);
  render(<RequestForm submit={submit} />);
  const description = screen.getByLabelText("Describe the feature");
  const submitButton = screen.getByRole("button", { name: "Submit request" });
  return { submit, description, submitButton };
}

describe("RequestForm", () => {
  it("has labelled fields, a public-submission notice and a live character count", () => {
    const { description } = renderForm({ kind: "created", id: 1, trackingUrl: "/requests/1" });
    expect(screen.getByLabelText(/Screenshot/)).toHaveAttribute("type", "file");
    expect(screen.getByText(/Submissions are public/)).toBeInTheDocument();
    fireEvent.change(description, { target: { value: "hello 😀" } });
    expect(screen.getByText("7 of 5000 characters")).toBeInTheDocument();
  });

  it("blocks a too-short description in the browser and focuses the field", () => {
    const { submit, description, submitButton } = renderForm({
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

  it("rejects an unsupported screenshot type before upload", () => {
    const { submit, description, submitButton } = renderForm({
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
    const { submit, description, submitButton } = renderForm(pending);
    fireEvent.change(description, { target: { value: VALID } });
    const png = new File([PNG_BYTES], "s.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Screenshot/), { target: { files: [png] } });
    fireEvent.click(submitButton);

    expect(await screen.findByRole("button", { name: "Submitting…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const sent = (submit.mock.calls[0] as unknown as [FormData])[0];
    expect(sent.get("description")).toBe(VALID);

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
    const { description, submitButton } = renderForm({
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
    const { description, submitButton } = renderForm({
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
    const { submit, description, submitButton } = renderForm(
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
    const { description, submitButton } = renderForm(
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
    render(<RequestForm submit={submit} />);
    fireEvent.change(screen.getByLabelText("Describe the feature"), { target: { value: VALID } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't submit/);
    expect(screen.getByRole("button", { name: "Submit request" })).toBeEnabled();
  });

  it("moves focus to the description after starting another request", async () => {
    const { description, submitButton } = renderForm({
      kind: "created",
      id: 3,
      trackingUrl: "/requests/3",
    });
    fireEvent.change(description, { target: { value: VALID } });
    fireEvent.click(submitButton);
    fireEvent.click(await screen.findByRole("button", { name: "Submit another request" }));
    expect(screen.getByLabelText("Describe the feature")).toHaveFocus();
  });

  it("lets the user remove an attached screenshot", () => {
    renderForm({ kind: "created", id: 1, trackingUrl: "/requests/1" });
    const png = new File([PNG_BYTES], "s.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Screenshot/), { target: { files: [png] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot" }));
    expect(screen.queryByRole("button", { name: "Remove screenshot" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Screenshot/)).toHaveFocus();
  });

  it("shows and links a verification error from the server", async () => {
    const { description, submitButton } = renderForm({
      kind: "invalid",
      message: "Please fix the highlighted fields.",
      fields: { botCheckToken: "Complete the verification check and try again." },
    });
    fireEvent.change(description, { target: { value: VALID } });
    fireEvent.click(submitButton);
    expect(
      await screen.findByRole("button", { name: "Submit request" }),
    ).toHaveAccessibleDescription("Complete the verification check and try again.");
  });
});
