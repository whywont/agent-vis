import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

const requests = new Map<symbol, number>();
let originalWidth: number | null = null;
let lastAppliedWidth: number | null = null;
let resizeQueue = Promise.resolve();

export function expandedPatchWindowWidth(
  viewportWidth: number,
  contentWidth: number,
  visibleWidth: number,
): number {
  const overflow = Math.max(0, contentWidth - visibleWidth);
  return overflow > 1 ? Math.ceil(viewportWidth - visibleWidth + contentWidth + 32) : 0;
}

export function requestPatchWindowWidth(token: symbol, width: number | null): void {
  if (width === null) requests.delete(token);
  else requests.set(token, width);
  resizeQueue = resizeQueue.then(applyPatchWindowWidth).catch(() => {});
}

async function applyPatchWindowWidth(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const appWindow = getCurrentWindow();
  const scaleFactor = await appWindow.scaleFactor();
  const current = await appWindow.innerSize();
  const currentWidth = current.width / scaleFactor;
  const currentHeight = current.height / scaleFactor;

  if (originalWidth === null && requests.size > 0) originalWidth = currentWidth;
  if (originalWidth === null) return;
  // Treat a size that did not come from this coordinator as the user's new
  // preferred width, so an open patch never fights a manual window resize.
  if (lastAppliedWidth !== null && Math.abs(currentWidth - lastAppliedWidth) > 2) {
    originalWidth = currentWidth;
  }

  const targetWidth = requests.size > 0
    ? Math.max(originalWidth, ...requests.values())
    : originalWidth;
  if (Math.abs(currentWidth - targetWidth) > 1) {
    await appWindow.setSize(new LogicalSize(targetWidth, currentHeight));
  }
  lastAppliedWidth = targetWidth;
  if (requests.size === 0) {
    originalWidth = null;
    lastAppliedWidth = null;
  }
}
