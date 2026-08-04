import { describe, expect, it } from "vitest";
import {
  detailedDiffExplanationKey,
  diffExplanationKey,
  loadDiffExplanation,
  removeDiffExplanation,
  saveDiffExplanation,
} from "./diff-explanation-cache";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function identity(patch: string, contextText = "fix the sidebar") {
  return {
    workspaceRoot: "/workspace/agent-vis",
    filepath: "desktop/src/App.tsx",
    action: "update",
    patch,
    contextText,
  };
}

describe("desktop diff explanation cache", () => {
  it("restores a saved explanation for the exact patch", () => {
    const storage = memoryStorage();
    const key = diffExplanationKey(identity("@@ -1 +1 @@\n-old\n+new"));

    saveDiffExplanation(key, "The sidebar now stays open.", storage);

    expect(loadDiffExplanation(key, storage)).toBe("The sidebar now stays open.");
  });

  it("keeps different patches and request contexts separate", () => {
    expect(diffExplanationKey(identity("+first"))).not.toBe(diffExplanationKey(identity("+second")));
    expect(diffExplanationKey(identity("+first", "request one"))).not.toBe(
      diffExplanationKey(identity("+first", "request two")),
    );
  });

  it("stores detailed follow-up explanations separately", () => {
    const key = diffExplanationKey(identity("+more context"));

    expect(detailedDiffExplanationKey(key)).toBe(`${key}:detailed`);
  });

  it("removes a dismissed explanation", () => {
    const storage = memoryStorage();
    const key = diffExplanationKey(identity("+persist me"));
    saveDiffExplanation(key, "Saved", storage);

    removeDiffExplanation(key, storage);

    expect(loadDiffExplanation(key, storage)).toBeNull();
  });
});
