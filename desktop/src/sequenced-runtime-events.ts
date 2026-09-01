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

/**
 * Return only the uninterrupted sequence immediately after the current
 * watermark. Live delivery must not jump over a missing event because doing so
 * would make a later replay start after the gap and permanently lose it.
 */
export function contiguousRuntimeEvents(
  currentSequence: number,
  events: readonly AgentProviderRuntimeEvent[],
): AgentProviderRuntimeEvent[] {
  const ordered = unappliedRuntimeEvents(currentSequence, events);
  const contiguous: AgentProviderRuntimeEvent[] = [];
  let expected = currentSequence + 1;
  for (const event of ordered) {
    if (event.sequence !== expected) break;
    contiguous.push(event);
    expected += 1;
  }
  return contiguous;
}
