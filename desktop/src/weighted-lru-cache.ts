interface CacheEntry<T> {
  value: T;
  weight: number;
}

export class WeightedLruCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private totalWeight = 0;

  constructor(private readonly maxWeight: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, weight: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.totalWeight -= previous.weight;
      this.entries.delete(key);
    }

    const normalizedWeight = Math.max(0, weight);
    this.entries.set(key, { value, weight: normalizedWeight });
    this.totalWeight += normalizedWeight;

    // Keep the newest entry even if it alone exceeds the budget. In practice
    // the Rust loader rejects individual sessions above the same 512 MiB limit.
    while (this.totalWeight > this.maxWeight && this.entries.size > 1) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry<T>] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.totalWeight -= oldest[1].weight;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }
}
