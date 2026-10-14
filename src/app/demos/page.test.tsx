import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DemosIndex from "./page";

describe("Demos index", () => {
  it("renders the empty state", () => {
    render(<DemosIndex />);
    expect(screen.getByRole("heading", { level: 1, name: "Demos" })).toBeInTheDocument();
    expect(screen.getByText(/none yet/i)).toBeInTheDocument();
  });
});
