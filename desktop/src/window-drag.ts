import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent } from "react";

const INTERACTIVE_SELECTOR = "button, input, select, textarea, a, [role='button'], [data-window-no-drag]";

export function startWindowDrag(event: ReactMouseEvent<HTMLElement>): void {
  if (event.button !== 0) return;
  const target = event.target;
  if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;
  void getCurrentWindow().startDragging().catch(() => {});
}
