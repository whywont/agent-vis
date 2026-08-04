export const desktopAppearances = ["warm-dark", "blue-dark", "light"] as const;

export type DesktopAppearance = (typeof desktopAppearances)[number];

export function applyDesktopAppearance(appearance: DesktopAppearance) {
  document.documentElement.dataset.desktopAppearance = appearance;
}
