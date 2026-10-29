export type ThemePreference = "system" | "light" | "dark";

/** Storage is best-effort: privacy settings must not disable theme controls. */
export function applyThemePreference(preference: ThemePreference): void {
  const resolved =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolved;
  try {
    if (preference === "system")
      window.localStorage.removeItem("voxelspy-theme");
    else window.localStorage.setItem("voxelspy-theme", preference);
  } catch {
    // The current tab still honors the choice when persistence is unavailable.
  }
}

/** Follow OS changes only while the current choice is System. */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => {
    if (document.documentElement.dataset.themePreference === "system")
      document.documentElement.dataset.theme = media.matches ? "dark" : "light";
  };
  // Also reconcile an OS change between the early theme guard and hydration.
  update();
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}
