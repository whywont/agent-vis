import type { AgentProviderRuntimeEvent } from "./desktop-api";

export function unappliedRuntimeEvents(
  currentSequence: number,
  events: readonly AgentProviderRuntimeEvent[],
): AgentProviderRuntimeEvent[] {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const unapplied: AgentProviderRuntimeEvent[] = [];
  let watermark = currentSequence;
  for (const event of ordered) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= watermark) continue;
    unapplied.push(event);
    watermark = event.sequence;
  }
  return unapplied;
}
