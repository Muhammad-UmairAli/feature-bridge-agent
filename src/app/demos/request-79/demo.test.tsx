import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Demo from "./demo";

describe("counter demo", () => {
  it("starts at zero when no value is stored", () => {
    window.localStorage.removeItem("demo:request-79:counter");

    render(<Demo />);

    expect(screen.getByRole("status", { name: "Counter value" })).toHaveTextContent("0");
  });

  it("increments the counter", () => {
    window.localStorage.removeItem("demo:request-79:counter");

    render(<Demo />);
    fireEvent.click(screen.getByRole("button", { name: "Increment counter" }));

    expect(screen.getByRole("status", { name: "Counter value" })).toHaveTextContent("1");
  });

  it("decrements the counter", () => {
    window.localStorage.removeItem("demo:request-79:counter");

    render(<Demo />);
    fireEvent.click(screen.getByRole("button", { name: "Decrement counter" }));

    expect(screen.getByRole("status", { name: "Counter value" })).toHaveTextContent("-1");
  });

  it("persists the updated value to local storage", () => {
    window.localStorage.removeItem("demo:request-79:counter");

    render(<Demo />);
    fireEvent.click(screen.getByRole("button", { name: "Increment counter" }));

    expect(window.localStorage.getItem("demo:request-79:counter")).toBe("1");
  });

  it("initializes from the stored value", () => {
    window.localStorage.setItem("demo:request-79:counter", "7");

    render(<Demo />);

    expect(screen.getByRole("status", { name: "Counter value" })).toHaveTextContent("7");
  });
});
