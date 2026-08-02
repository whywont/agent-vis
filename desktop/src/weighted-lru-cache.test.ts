import { describe, expect, it } from "vitest";
import { WeightedLruCache } from "./weighted-lru-cache";

describe("WeightedLruCache", () => {
  it("evicts the least recently used entries until the cache is within budget", () => {
    const cache = new WeightedLruCache<string>(100);
    cache.set("a", "A", 40);
    cache.set("b", "B", 40);
    cache.set("c", "C", 40);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("refreshes recency when an entry is read", () => {
    const cache = new WeightedLruCache<string>(100);
    cache.set("a", "A", 40);
    cache.set("b", "B", 40);
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C", 40);

    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("C");
  });

  it("keeps a newly loaded entry even when it alone reaches the full budget", () => {
    const cache = new WeightedLruCache<string>(100);
    cache.set("small", "small", 30);
    cache.set("large", "large", 100);

    expect(cache.get("small")).toBeUndefined();
    expect(cache.get("large")).toBe("large");
  });

  it("updates the accounted weight when replacing an entry", () => {
    const cache = new WeightedLruCache<string>(100);
    cache.set("a", "old", 80);
    cache.set("a", "new", 20);
    cache.set("b", "B", 70);

    expect(cache.get("a")).toBe("new");
    expect(cache.get("b")).toBe("B");
  });
});
