import type { CollabRoomState, CollabWorker } from "./desktop-api";

const MAX_RELEVANT_FACTS = 12;

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

export function collabDispatchPrompt(state: CollabRoomState, self: CollabWorker, message: string): string {
  return [
    "Use this bounded coordinator state for the current turn. It contains only your assignment and overlapping cross-worker dependencies.",
    "Do not infer access to other agents' conversations, reasoning, worktrees, or unsubmitted work.",
    `COLLAB_STATE=${JSON.stringify(collabDispatchState(state, self))}`,
    "HOST_MESSAGE:",
    message,
  ].join("\n");
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
