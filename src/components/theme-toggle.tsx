"use client";

import { MoonIcon, SunIcon } from "@/components/icons";

export const THEME_STORAGE_KEY = "labstock-theme";

/**
 * Dark / light switch.
 *
 * Deliberately stateless. The current theme lives in one place — the
 * `data-theme` attribute on `<html>` — and CSS decides which of the two icons
 * is visible, so there is nothing for React to hold, nothing to synchronise on
 * mount, and no frame where the server's guess is showing the wrong glyph.
 *
 * Dark is the default and lives on bare `:root`, so an unset preference needs
 * no attribute at all. The choice is persisted to localStorage and re-applied
 * before first paint by the inline script in the root layout.
 */
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;

    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private browsing with storage disabled: the toggle still works for
      // this page view, it just will not be remembered.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Switch between dark and light theme"
      className="flex h-11 w-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
    >
      <MoonIcon className="theme-icon-dark" />
      <SunIcon className="theme-icon-light" />
    </button>
  );
}
