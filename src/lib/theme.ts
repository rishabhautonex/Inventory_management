/**
 * Where the chosen colour scheme is remembered.
 *
 * This lives in a plain module rather than beside the toggle, because the
 * toggle is a `"use client"` file: a Server Component importing a value from
 * one gets a client reference proxy, not the string, and the pre-paint script
 * in the root layout was reading `localStorage.getItem(undefined)` — silently
 * leaving a light-mode user with a dark flash on every load.
 */
export const THEME_STORAGE_KEY = "labstock-theme";
