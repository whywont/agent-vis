import { useEffect, RefObject } from "react";

/**
 * Attach mouse-drag resize behaviour to an element.
 * edge: "right" means dragging the right edge resizes the element width.
 */
export function useResizable(
  targetRef: RefObject<HTMLElement | null>,
  edge: "right" | "left" = "right"
) {
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    // Find or create the resize handle inside the target
    let handle = target.querySelector<HTMLElement>(`.resize-handle.${edge}`);
    if (!handle) return;

    function onMouseDown(e: MouseEvent) {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = target!.getBoundingClientRect().width;

      document.body.classList.add("resizing");
      handle!.classList.add("dragging");

      function onMove(e: MouseEvent) {
        const dx = e.clientX - startX;
        const newWidth = Math.max(100, Math.min(startWidth + dx, 700));
        target!.style.width = newWidth + "px";
      }

      function onUp() {
        document.body.classList.remove("resizing");
        handle!.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }

    handle.addEventListener("mousedown", onMouseDown);
    return () => {
      handle!.removeEventListener("mousedown", onMouseDown);
    };
  });
}
