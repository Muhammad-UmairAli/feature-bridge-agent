import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_THEME,
  THEME_CHANGE_EVENT,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  isThemeId,
  readStoredTheme,
  readTheme,
  setTheme,
} from "./theme";

const root = document.documentElement;

afterEach(() => {
  root.removeAttribute("data-theme");
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("isThemeId", () => {
  it("accepts known themes only", () => {
    expect(isThemeId("dark")).toBe(true);
    expect(isThemeId("light")).toBe(true);
    expect(isThemeId("solarized")).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });
});

describe("readTheme", () => {
  it("defaults to dark when unset or unknown", () => {
    expect(readTheme(root)).toBe(DEFAULT_THEME);
    root.dataset.theme = "neon";
    expect(readTheme(root)).toBe("dark");
  });

  it("returns the applied theme", () => {
    root.dataset.theme = "light";
    expect(readTheme(root)).toBe("light");
  });
});

describe("readStoredTheme", () => {
  it("returns a valid stored theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(readStoredTheme(localStorage)).toBe("light");
  });

  it("ignores invalid values and missing storage", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "<script>");
    expect(readStoredTheme(localStorage)).toBeNull();
    expect(readStoredTheme(undefined)).toBeNull();
  });

  it("returns null when storage throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredTheme(storage)).toBeNull();
  });
});

describe("setTheme", () => {
  it("applies, persists and announces the theme", () => {
    const listener = vi.fn();
    window.addEventListener(THEME_CHANGE_EVENT, listener);
    setTheme("light");
    window.removeEventListener(THEME_CHANGE_EVENT, listener);

    expect(root.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("still applies the theme when storage fails", () => {
    const storage = {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => setTheme("light", root, storage)).not.toThrow();
    expect(root.dataset.theme).toBe("light");
  });
});

describe("THEME_INIT_SCRIPT", () => {
  const runInitScript = () => new Function(THEME_INIT_SCRIPT)();

  it("applies a saved theme before paint", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    runInitScript();
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("ignores unknown saved values", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    runInitScript();
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(runInitScript).not.toThrow();
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});
