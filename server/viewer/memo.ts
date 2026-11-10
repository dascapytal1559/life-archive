// Answers kept while what they were worked out from stays as it was: a tab's version (tab.ts) names that state, and a
// new one forgets everything kept under the old. The least recently used go first past `most`.

export class Memo {
  private version: string | null = null;
  private readonly kept = new Map<string, unknown>();
  private readonly most: number;

  constructor(most: number) {
    this.most = most;
  }

  /** What `key` was worked out as under `version`, if it is kept. */
  peek<T>(version: string, key: string): T | undefined {
    return version === this.version ? (this.kept.get(key) as T | undefined) : undefined;
  }

  /** What `key` was worked out as under `version`, or `work()` now (and kept). */
  get<T>(version: string, key: string, work: () => T): T {
    if (version !== this.version) {
      this.kept.clear();
      this.version = version;
    }
    if (this.kept.has(key)) {
      const value = this.kept.get(key) as T;
      this.kept.delete(key);
      this.kept.set(key, value);
      return value;
    }
    const value = work();
    this.kept.set(key, value);
    if (this.kept.size > this.most) this.kept.delete(this.kept.keys().next().value!);
    return value;
  }
}
