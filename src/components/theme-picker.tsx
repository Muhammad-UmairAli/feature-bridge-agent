"use client";

import { useId, useSyncExternalStore } from "react";

import {
  DEFAULT_THEME,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  THEMES,
  isThemeId,
  readTheme,
  setTheme,
} from "@/lib/theme";

/** Re-render on local theme changes and on changes made in other tabs. */
function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    // key is null when another tab clears all storage.
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    const root = document.documentElement;
    if (isThemeId(event.newValue)) {
      root.dataset.theme = event.newValue;
    } else {
      // Preference removed elsewhere: fall back to the default theme.
      delete root.dataset.theme;
    }
    onChange();
  };
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const getSnapshot = () => readTheme(document.documentElement);
// The server can't know the saved theme; React reconciles after hydration.
const getServerSnapshot = () => DEFAULT_THEME;

export function ThemePicker() {
  const id = useId();
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="text-muted-foreground">
        Theme
      </label>
      <select
        id={id}
        value={theme}
        onChange={(event) => {
          if (isThemeId(event.target.value)) setTheme(event.target.value);
        }}
        className="h-8 rounded-md border border-input bg-background px-2 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {THEMES.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
