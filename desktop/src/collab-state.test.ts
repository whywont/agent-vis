import { describe, expect, it } from "vitest";
import { collabDispatchPrompt, collabDispatchState } from "./collab-state";
import type { CollabRoomState, CollabWorker } from "./desktop-api";

const alpha: CollabWorker = {
  id: "worker-a", name: "Alpha", provider: "codex", role: "agent worker",
  worktreePath: "/tmp/alpha", branch: "agent-vis/alpha", createdAt: "",
  sessionKey: "alpha-session", threadId: "alpha-thread", runtimeStatus: "running", runtimeError: "",
};
const beta = { ...alpha, id: "worker-b", name: "Beta", worktreePath: "/tmp/beta" };
const gamma = { ...alpha, id: "worker-c", name: "Gamma", worktreePath: "/tmp/gamma" };

const state: CollabRoomState = {
  roomId: "room-1", repository: "/repo", headCommit: "abc123", workers: [alpha, beta, gamma],
  tasks: [
    { id: "task-a", title: "Timeline", scope: "desktop/src/**", status: "claimed", claimedBy: "worker-a", createdAt: "", updatedAt: "" },
    { id: "task-b", title: "Timeline component", scope: "desktop/src/DesktopTimeline.tsx", status: "claimed", claimedBy: "worker-b", createdAt: "", updatedAt: "" },
    { id: "task-c", title: "Native mesh", scope: "desktop/src-tauri/src/mesh.rs", status: "claimed", claimedBy: "worker-c", createdAt: "", updatedAt: "" },
  ],
  leases: [
    { id: "lease-a", resource: "desktop/src", mode: "exclusive", holderId: "worker-a", taskId: "task-a", fencingToken: 6, expiresAtMs: Date.now() + 60_000, createdAt: "" },
    { id: "lease-b", resource: "desktop/src/DesktopTimeline.tsx", mode: "exclusive", holderId: "worker-b", taskId: "task-b", fencingToken: 7, expiresAtMs: Date.now() + 60_000, createdAt: "" },
    { id: "lease-c", resource: "desktop/src-tauri", mode: "exclusive", holderId: "worker-c", taskId: "task-c", fencingToken: 8, expiresAtMs: Date.now() + 60_000, createdAt: "" },
  ],
  changeSets: [
    { id: "change-b", workerId: "worker-b", title: "Timeline", summary: "", baseCommit: "abc", changedPaths: ["desktop/src/DesktopTimeline.tsx"], status: "review", reviewerId: null, reviewNote: "", createdAt: "", updatedAt: "", integratedAt: null },
    { id: "change-c", workerId: "worker-c", title: "Mesh", summary: "", baseCommit: "abc", changedPaths: ["desktop/src-tauri/src/mesh.rs"], status: "approved", reviewerId: null, reviewNote: "", createdAt: "", updatedAt: "", integratedAt: null },
  ],
  messages: [{ id: "secret", authorId: "worker-b", authorName: "Beta", body: "private transcript text", createdAt: "", recipientId: null }],
};

describe("collab dispatch state", () => {
  it("includes own assignment and only overlapping facts from another agent", () => {
    const snapshot = collabDispatchState(state, alpha);
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.assignment.tasks.map((task) => task.id)).toEqual(["task-a"]);
    expect(snapshot.dependencies.claims.map((claim) => claim.workerId)).toEqual(["worker-b"]);
    expect(snapshot.dependencies.leases.map((lease) => lease.fencingToken)).toEqual([7]);
    expect(snapshot.dependencies.changes[0].paths).toEqual(["desktop/src/DesktopTimeline.tsx"]);
    expect(serialized).not.toContain("worker-c");
    expect(serialized).not.toContain("/tmp/beta");
    expect(serialized).not.toContain("private transcript text");
  });

  it("sends no cross-agent facts when this worker has no assigned scope", () => {
    const unassigned = { ...alpha, id: "worker-new", name: "New" };
    const snapshot = collabDispatchState({ ...state, workers: [...state.workers, unassigned] }, unassigned);
    expect(snapshot.assignment.tasks).toEqual([]);
    expect(snapshot.dependencies).toEqual({ claims: [], leases: [], changes: [] });
  });

  it("keeps the host message outside the state and excludes room history", () => {
    const prompt = collabDispatchPrompt(state, alpha, "Inspect the timeline.");
    expect(prompt).toContain("HOST_MESSAGE:\nInspect the timeline.");
    expect(prompt).not.toContain("private transcript text");
  });
});
