// Note: 有界会话、单次授权与讨论分页，见 .agents/notes/implemented/architecture/2026-09-15-admin-resource-bounds.md。
export class ExpiringStore<T> {
  private values = new Map<string, { value: T; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  constructor(private ttlMs: number, private capacity: number) {}
  get size() { return this.values.size; }
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (entry && entry.expiresAt <= Date.now()) { this.delete(key); return undefined; }
    return entry?.value;
  }
  set(key: string, value: T): boolean {
    if (!this.values.has(key) && this.values.size >= this.capacity) return false;
    this.delete(key);
    const timer = setTimeout(() => this.delete(key), this.ttlMs);
    timer.unref();
    this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs, timer });
    return true;
  }
  delete(key: string) {
    const entry = this.values.get(key);
    if (entry) clearTimeout(entry.timer);
    this.values.delete(key);
  }
}
