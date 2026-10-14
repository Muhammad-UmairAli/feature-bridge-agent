import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CounterDemo from "./demo";

describe("CounterDemo", () => {
  it("displays initial value of 0", () => {
    render(<CounterDemo />);
    expect(screen.getByRole("status")).toHaveTextContent("0");
  });

  it("increments count when + button is clicked", () => {
    render(<CounterDemo />);
    const incrementButton = screen.getByLabelText("Increment");
    fireEvent.click(incrementButton);
    expect(screen.getByRole("status")).toHaveTextContent("1");
  });

  it("decrements count when - button is clicked", () => {
    render(<CounterDemo />);
    const decrementButton = screen.getByLabelText("Decrement");
    fireEvent.click(decrementButton);
    expect(screen.getByRole("status")).toHaveTextContent("-1");
  });

  it("updates count correctly after multiple clicks", () => {
    render(<CounterDemo />);
    const incrementButton = screen.getByLabelText("Increment");
    const decrementButton = screen.getByLabelText("Decrement");

    fireEvent.click(incrementButton);
    fireEvent.click(incrementButton);
    fireEvent.click(incrementButton);
    expect(screen.getByRole("status")).toHaveTextContent("3");

    fireEvent.click(decrementButton);
    expect(screen.getByRole("status")).toHaveTextContent("2");

    fireEvent.click(decrementButton);
    fireEvent.click(decrementButton);
    expect(screen.getByRole("status")).toHaveTextContent("0");
  });
});
