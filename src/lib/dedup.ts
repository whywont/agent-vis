import type { AppEvent } from "./types";

/**
 * Check if an images array contains data URIs (vs file paths).
 */
function hasDataUriImages(images: string[] | undefined): boolean {
  return !!(images && images.length > 0 && images[0].startsWith("data:"));
}

/**
 * Deduplicate user messages: response_item and event_msg both produce
 * user_message events. Merge images from one into the other and remove
 * the duplicate.
 */
export function deduplicateUserMessages(events: (AppEvent | null)[]): void {
  for (let i = 0; i < events.length; i++) {
    const ei = events[i];
    if (!ei || ei.kind !== "user_message") continue;
    for (let j = i + 1; j < events.length; j++) {
      const ej = events[j];
      if (!ej || ej.kind !== "user_message") continue;
      const t1 = new Date(ei.ts).getTime();
      const t2 = new Date(ej.ts).getTime();
      if (Math.abs(t1 - t2) > 3000) break;

      const iHasXml = (ei.text || "").includes("<image name=");
      const jHasXml = (ej.text || "").includes("<image name=");
      const iImages = ei.images || [];
      const jImages = ej.images || [];

      let keep: number, remove: number;
      if (iHasXml && !jHasXml) {
        keep = j; remove = i;
      } else if (jHasXml && !iHasXml) {
        keep = i; remove = j;
      } else {
        keep = i; remove = j;
      }

      const keepEvent = events[keep] as { kind: "user_message"; ts: string; text: string; images?: string[] };
      const removeEvent = events[remove] as { kind: "user_message"; ts: string; text: string; images?: string[] };
      const keepImgs = keepEvent.images || [];
      const removeImgs = removeEvent.images || [];
      if (hasDataUriImages(removeImgs) && !hasDataUriImages(keepImgs)) {
        keepEvent.images = removeImgs;
      } else if (removeImgs.length > keepImgs.length && !hasDataUriImages(keepImgs)) {
        keepEvent.images = removeImgs;
      }

      events[remove] = null;
      break;
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] === null) events.splice(i, 1);
  }

  for (const evt of events) {
    if (!evt) continue;
    if (evt.kind === "user_message" && evt.text) {
      evt.text = evt.text.replace(/<image name=[^>]*>\s*<\/image>\s*/g, "");
      evt.text = evt.text.trim();
    }
    if (evt.kind === "user_message" && evt.images) {
      evt.images = evt.images.map((img) => {
        if (img.startsWith("/")) {
          return "/api/image?path=" + encodeURIComponent(img);
        }
        return img;
      });
    }
  }
}

/**
 * Deduplicate agent messages: event_msg agent_message and response_item
 * assistant message create duplicates.
 */
export function deduplicateAgentMessages(events: (AppEvent | null)[]): void {
  for (let i = 0; i < events.length; i++) {
    const ei = events[i];
    if (!ei || ei.kind !== "agent_message") continue;
    for (let j = i + 1; j < events.length; j++) {
      const ej = events[j];
      if (!ej) continue;
      const t1 = new Date(ei.ts).getTime();
      const t2 = new Date(ej.ts).getTime();
      if (Math.abs(t1 - t2) > 5000) break;
      if (ej.kind !== "agent_message") continue;

      if (Math.abs(t1 - t2) > 2000) continue;

      const textA = (ei.text || "").slice(0, 200);
      const textB = (ej.text || "").slice(0, 200);
      const similar =
        textA === textB ||
        textA.startsWith(textB.slice(0, 80)) ||
        textB.startsWith(textA.slice(0, 80));

      if (similar) {
        const iHasPhase = ei.phase && ei.phase !== "final";
        const jHasPhase = ej.phase && ej.phase !== "final";
        if (jHasPhase && !iHasPhase) {
          events[i] = null;
        } else if (iHasPhase && !jHasPhase) {
          events[j] = null;
        } else {
          const iLen = (ei.text || "").length;
          const jLen = (ej.text || "").length;
          if (jLen >= iLen) {
            events[i] = null;
          } else {
            events[j] = null;
          }
        }
        break;
      }
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] === null) events.splice(i, 1);
  }
}
