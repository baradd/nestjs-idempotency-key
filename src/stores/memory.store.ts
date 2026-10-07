import { IdempotencyStore, StoredRecord } from '../interfaces';

interface Entry {
  record: StoredRecord;
  expiresAt: number;
}

/** Single-process store. Fine for tests and local dev; use Redis in production. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly data = new Map<string, Entry>();

  private read(key: string): StoredRecord | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.record;
  }

  async startProcessing(key: string, fingerprint: string, lockTtlMs: number): Promise<boolean> {
    if (this.read(key)) return false;
    this.data.set(key, {
      record: { status: 'in_progress', fingerprint },
      expiresAt: Date.now() + lockTtlMs,
    });
    return true;
  }

  async get(key: string): Promise<StoredRecord | null> {
    return this.read(key);
  }

  async complete(key: string, record: StoredRecord, ttlMs: number): Promise<void> {
    this.data.set(key, { record, expiresAt: Date.now() + ttlMs });
  }

  async release(key: string): Promise<void> {
    this.data.delete(key);
  }
}
