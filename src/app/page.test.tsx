import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Home from "./page";

describe("Home page", () => {
  it("renders the project heading", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { level: 1, name: "feature-bridge-agent" }),
    ).toBeInTheDocument();
  });

  it("links to the demos index", () => {
    render(<Home />);
    expect(screen.getByRole("link", { name: "Browse demos" })).toHaveAttribute("href", "/demos");
  });
});
