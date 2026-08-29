// Mirrors Owlbear's current theme onto CSS custom properties so the
// extension's UI blends in instead of looking like a foreign iframe.
import OBR from "@owlbear-rodeo/sdk";

type Theme = Awaited<ReturnType<typeof OBR.theme.getTheme>>;

function apply(theme: Theme) {
  const root = document.documentElement;
  root.dataset.mode = theme.mode === "DARK" ? "dark" : "light";
  root.style.setProperty("--ob-primary", theme.primary.main);
  root.style.setProperty("--ob-primary-contrast", theme.primary.contrastText);
  root.style.setProperty("--ob-secondary", theme.secondary.main);
  root.style.setProperty("--ob-bg", theme.background.default);
  root.style.setProperty("--ob-bg-paper", theme.background.paper);
  root.style.setProperty("--ob-text", theme.text.primary);
  root.style.setProperty("--ob-text-secondary", theme.text.secondary);
}

export function initTheme(): void {
  OBR.theme.getTheme().then(apply);
  OBR.theme.onChange(apply);
}
