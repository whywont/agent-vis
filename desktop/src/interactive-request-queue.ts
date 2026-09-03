import type { InteractiveAgentRequest } from "./interactive-agent-requests";

export function enqueueInteractiveRequest(
  queue: readonly InteractiveAgentRequest[],
  request: InteractiveAgentRequest,
): InteractiveAgentRequest[] {
  return queue.some((candidate) => sameInteractiveRequest(candidate, request))
    ? [...queue]
    : [...queue, request];
}

export function removeInteractiveRequest(
  queue: readonly InteractiveAgentRequest[],
  request: InteractiveAgentRequest,
): InteractiveAgentRequest[] {
  return queue.filter((candidate) => !sameInteractiveRequest(candidate, request));
}

function sameInteractiveRequest(
  left: InteractiveAgentRequest,
  right: InteractiveAgentRequest,
): boolean {
  return left.method === right.method && left.requestId === right.requestId;
}
