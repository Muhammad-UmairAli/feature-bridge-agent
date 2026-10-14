import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Home from "./page";

describe("Home page", () => {
  it("renders the request heading and form", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Request a feature" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit request" })).toBeInTheDocument();
  });

  it("links to the demos index", () => {
    render(<Home />);
    expect(screen.getByRole("link", { name: "Browse demos" })).toHaveAttribute("href", "/demos");
  });
});
