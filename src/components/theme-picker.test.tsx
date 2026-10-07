import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { THEME_STORAGE_KEY, setTheme } from "@/lib/theme";

import { ThemePicker } from "./theme-picker";

const root = document.documentElement;

afterEach(() => {
  root.removeAttribute("data-theme");
  localStorage.clear();
});

describe("ThemePicker", () => {
  it("is a labelled control offering Dark and Light, Dark by default", () => {
    render(<ThemePicker />);
    const select = screen.getByRole("combobox", { name: "Theme" });
    expect(select).toHaveValue("dark");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Dark",
      "Light",
    ]);
  });

  it("switches the page theme and remembers the choice", () => {
    render(<ThemePicker />);
    fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), {
      target: { value: "light" },
    });
    expect(root.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("light");
  });

  it("reflects a theme already applied by the init script", () => {
    root.dataset.theme = "light";
    render(<ThemePicker />);
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("light");
  });

  it("stays in sync with changes made elsewhere on the page", () => {
    render(<ThemePicker />);
    act(() => setTheme("light"));
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("light");
  });

  it("follows a change made in another tab", () => {
    render(<ThemePicker />);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "light" }),
      );
    });
    expect(root.dataset.theme).toBe("light");
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("light");
  });

  it("falls back to Dark when another tab clears storage", () => {
    root.dataset.theme = "light";
    render(<ThemePicker />);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
    });
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
  });

  it("ignores unrelated storage keys", () => {
    root.dataset.theme = "light";
    render(<ThemePicker />);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "x" }));
    });
    expect(root.dataset.theme).toBe("light");
  });
});
