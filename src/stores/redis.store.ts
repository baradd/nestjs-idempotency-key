import { IdempotencyStore, RedisLike, StoredRecord } from '../interfaces';

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisLike) {}

  async startProcessing(key: string, fingerprint: string, lockTtlMs: number): Promise<boolean> {
    const record: StoredRecord = { status: 'in_progress', fingerprint };
    // NX makes this atomic: only one concurrent caller gets 'OK'.
    const result = await this.redis.set(key, JSON.stringify(record), 'PX', lockTtlMs, 'NX');
    return result === 'OK';
  }

  async get(key: string): Promise<StoredRecord | null> {
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as StoredRecord) : null;
  }

  async complete(key: string, record: StoredRecord, ttlMs: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(record), 'PX', ttlMs);
  }

  async release(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
