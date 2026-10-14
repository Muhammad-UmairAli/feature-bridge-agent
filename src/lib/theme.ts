/**
 * Runtime theme support: the available themes, persistence, and the script that
 * applies the saved theme before first paint. Dark is the default and needs no
 * attribute; other themes are selected with data-theme on <html>.
 */

export const THEMES = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "dark";
export const THEME_STORAGE_KEY = "feature-bridge-agent:theme";
/** Dispatched on window after setTheme(), so subscribers can re-read the theme. */
export const THEME_CHANGE_EVENT = "themechange";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

/** The theme currently applied to the root element (the default when unset or unknown). */
export function readTheme(root: HTMLElement): ThemeId {
  const value = root.dataset.theme;
  return isThemeId(value) ? value : DEFAULT_THEME;
}

/** The saved preference, or null when absent, invalid, or storage is unavailable. */
export function readStoredTheme(storage: Pick<Storage, "getItem"> | undefined): ThemeId | null {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : null;
  } catch {
    return null;
  }
}

/** localStorage, or undefined when the browser blocks access (e.g. disabled site data). */
function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Apply a theme and remember it. The theme always applies to the current page,
 * even when storage is unavailable; only persistence is skipped then.
 */
export function setTheme(
  theme: ThemeId,
  root: HTMLElement = document.documentElement,
  storage: Pick<Storage, "setItem"> | undefined = safeLocalStorage(),
): void {
  root.dataset.theme = theme;
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage full or blocked: keep the theme for this page without persisting it.
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/**
 * Inline script for the root layout. It runs before first paint and applies the
 * saved theme so the page never flashes the wrong one. Dependency-free and
 * wrapped in try/catch because storage access can throw.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(${JSON.stringify(THEMES.map((theme) => theme.id))}.indexOf(t)!==-1){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;
