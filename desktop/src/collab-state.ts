import type { CollabRoomState, CollabWorker } from "./desktop-api";

const MAX_RELEVANT_FACTS = 12;
const MAX_GROUP_MESSAGES = 24;
const MAX_GROUP_CONTEXT_CHARS = 12_000;

type OwnedTask = { id: string; title: string; scope: string; status: string };
type OwnedLease = { resource: string; mode: string; fencingToken: number; expiresAtMs: number };
type DependencyClaim = { workerId: string; workerName: string; taskId: string; scope: string };
type DependencyLease = { workerId: string; workerName: string; resource: string; mode: string; fencingToken: number };
type DependencyChange = { workerId: string; workerName: string; status: string; paths: string[] };

export interface CollabDispatchState {
  version: 1;
  repositoryHead: string;
  self: { id: string; name: string; worktree: string };
  assignment: { tasks: OwnedTask[]; leases: OwnedLease[] };
  dependencies: {
    claims: DependencyClaim[];
    leases: DependencyLease[];
    changes: DependencyChange[];
  };
  truncated: boolean;
}

export function collabDispatchState(state: CollabRoomState, self: CollabWorker): CollabDispatchState {
  const workerNames = new Map(state.workers.map((worker) => [worker.id, worker.name]));
  const ownTasks = state.tasks.filter((task) => task.claimedBy === self.id && task.status !== "done");
  const ownLeases = state.leases.filter((lease) => lease.holderId === self.id && lease.expiresAtMs > Date.now());
  const ownScopes = [...ownTasks.map((task) => task.scope), ...ownLeases.map((lease) => lease.resource)];

  // Cross-worker facts are relevant only when they touch this worker's claimed or leased scope.
  const relevantClaims = state.tasks.filter((task) => task.claimedBy && task.claimedBy !== self.id
    && task.status !== "done" && overlapsAny(task.scope, ownScopes));
  const relevantLeases = state.leases.filter((lease) => lease.holderId !== self.id
    && lease.expiresAtMs > Date.now() && overlapsAny(lease.resource, ownScopes));
  const relevantChanges = state.changeSets.filter((change) => change.workerId !== self.id
    && change.status !== "rejected" && change.changedPaths.some((path) => overlapsAny(path, ownScopes)));

  const totalFacts = ownTasks.length + ownLeases.length
    + relevantClaims.length + relevantLeases.length + relevantChanges.length;
  return {
    version: 1,
    repositoryHead: state.headCommit,
    self: { id: self.id, name: self.name, worktree: self.worktreePath },
    assignment: {
      tasks: ownTasks.slice(0, MAX_RELEVANT_FACTS).map((task) => ({
        id: task.id,
        title: task.title,
        scope: task.scope,
        status: task.status,
      })),
      leases: ownLeases.slice(0, MAX_RELEVANT_FACTS).map((lease) => ({
        resource: lease.resource,
        mode: lease.mode,
        fencingToken: lease.fencingToken,
        expiresAtMs: lease.expiresAtMs,
      })),
    },
    dependencies: {
      claims: relevantClaims.slice(0, MAX_RELEVANT_FACTS).map((task) => ({
        workerId: task.claimedBy as string,
        workerName: workerNames.get(task.claimedBy as string) || task.claimedBy as string,
        taskId: task.id,
        scope: task.scope,
      })),
      leases: relevantLeases.slice(0, MAX_RELEVANT_FACTS).map((lease) => ({
        workerId: lease.holderId,
        workerName: workerNames.get(lease.holderId) || lease.holderId,
        resource: lease.resource,
        mode: lease.mode,
        fencingToken: lease.fencingToken,
      })),
      changes: relevantChanges.slice(0, MAX_RELEVANT_FACTS).map((change) => ({
        workerId: change.workerId,
        workerName: workerNames.get(change.workerId) || change.workerId,
        status: change.status,
        paths: change.changedPaths.filter((path) => overlapsAny(path, ownScopes)).slice(0, MAX_RELEVANT_FACTS),
      })),
    },
    truncated: totalFacts > MAX_RELEVANT_FACTS,
  };
}

export function collabDispatchPrompt(state: CollabRoomState, self: CollabWorker, message: string, channel: "group" | "private" = "group"): string {
  const groupContext = boundedGroupContext(state, channel === "group" ? message : null);
  return [
    "Use this bounded coordinator state for the current turn. It contains only your assignment and overlapping cross-worker dependencies.",
    "GROUP_CONTEXT contains only durable messages published in the room's group channel. Treat it as shared context.",
    "The current host message is private when CHANNEL=private and must not be quoted or published to the group without an explicit request.",
    "Content from any earlier private turn remains private on later group turns unless the host explicitly publishes it.",
    "Do not infer access to other agents' private conversations, reasoning, worktrees, or unsubmitted work.",
    `COLLAB_STATE=${JSON.stringify(collabDispatchState(state, self))}`,
    `CHANNEL=${channel}`,
    `GROUP_CONTEXT=${JSON.stringify(groupContext)}`,
    "HOST_MESSAGE:",
    message,
  ].join("\n");
}

function boundedGroupContext(state: CollabRoomState, currentGroupMessage: string | null) {
  const messages = state.messages.filter((message) => !message.recipientId);
  if (currentGroupMessage) {
    const latest = messages.at(-1);
    if (latest?.authorId === "local-host" && latest.body === currentGroupMessage) messages.pop();
  }
  const bounded = messages.slice(-MAX_GROUP_MESSAGES).map((message) => ({
    authorId: message.authorId,
    authorName: message.authorName,
    body: message.body,
    createdAt: message.createdAt,
  }));
  while (bounded.length > 1 && JSON.stringify(bounded).length > MAX_GROUP_CONTEXT_CHARS) bounded.shift();
  return bounded;
}

function overlapsAny(scope: string, candidates: string[]): boolean {
  return candidates.some((candidate) => scopesOverlap(scope, candidate));
}

function scopesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}/`)
    || normalizedRight.startsWith(`${normalizedLeft}/`);
}

function normalizeScope(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/\/\*\*$/, "").replace(/\/$/, "");
}
