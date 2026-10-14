import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readGitHubAppConfig } from "@/lib/config";
import { getRequestStatus } from "@/lib/github/request-status";

import RequestPage, { generateMetadata, parseRequestId } from "./page";

vi.mock("@/lib/config", () => ({ readGitHubAppConfig: vi.fn(() => ({})) }));
vi.mock("@/lib/github/request-status", () => ({ getRequestStatus: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const props = (id: string) => ({ params: Promise.resolve({ id }) }) as PageProps<"/requests/[id]">;
const renderPage = async (id: string) => render(await RequestPage(props(id)));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("parseRequestId", () => {
  it("accepts positive integers only", () => {
    expect(parseRequestId("42")).toBe(42);
    for (const bad of ["0", "-1", "abc", "4.2", "01", "99999999999"])
      expect(parseRequestId(bad)).toBeNull();
  });
});

describe("request tracking page", () => {
  it("shows the status, progress and links", async () => {
    vi.mocked(getRequestStatus).mockResolvedValue({
      id: 5,
      title: "Feature request: Add dark mode",
      status: "preview-ready",
      createdAt: "2026-10-07T09:00:00Z",
      issueUrl: "https://github.com/octo-org/requests/issues/5",
      pullRequest: { number: 9, url: "https://github.com/octo-org/requests/pull/9" },
      previewUrl: "https://preview.example",
    });
    await renderPage("5");
    expect(screen.getByRole("heading", { level: 1, name: "Request #5" })).toBeInTheDocument();
    expect(screen.getAllByText("Preview ready")).toHaveLength(2); // status box and current step
    const current = screen.getByRole("listitem", { current: "step" });
    expect(current).toHaveTextContent("Preview ready");
    expect(screen.getByRole("link", { name: /Try the preview/ })).toHaveAttribute(
      "href",
      "https://preview.example",
    );
    expect(screen.getByRole("link", { name: "Pull request #9" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Discussion on GitHub" })).toBeInTheDocument();
  });

  it("returns not found for malformed ids without calling GitHub", async () => {
    await expect(RequestPage(props("abc"))).rejects.toThrow("NOT_FOUND");
    expect(getRequestStatus).not.toHaveBeenCalled();
  });

  it("returns not found for requests that don't exist", async () => {
    vi.mocked(getRequestStatus).mockResolvedValue(null);
    await expect(RequestPage(props("12"))).rejects.toThrow("NOT_FOUND");
  });

  it("shows a friendly message when GitHub or configuration is unavailable", async () => {
    vi.mocked(readGitHubAppConfig).mockImplementationOnce(() => {
      throw new Error("not configured");
    });
    await renderPage("5");
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load this request/);
  });

  it("keeps tracking pages out of search results", async () => {
    expect(await generateMetadata(props("5"))).toMatchObject({
      robots: { index: false, follow: false },
    });
  });

  it("titles a malformed id as not found", async () => {
    expect(await generateMetadata(props("<b>x</b>"))).toMatchObject({ title: "Request not found" });
  });

  it("keeps progress visible while a plan is being revised", async () => {
    vi.mocked(getRequestStatus).mockResolvedValue({
      id: 5,
      title: "Feature request: Add dark mode",
      status: "changes-requested",
      createdAt: "",
      issueUrl: "https://github.com/octo-org/requests/issues/5",
      pullRequest: null,
      previewUrl: null,
    });
    await renderPage("5");
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Planning");
    expect(screen.getByText("Changes requested")).toBeInTheDocument();
  });
});
