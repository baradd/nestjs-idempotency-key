export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

export interface StoredRecord {
  /** `in_progress` = a request holds the lock; `completed` = response is cached. */
  status: 'in_progress' | 'completed';
  /** Hash of method + url + body, used to detect key reuse with a different payload. */
  fingerprint: string;
  response?: StoredResponse;
}

export interface IdempotencyStore {
  /**
   * Atomically claim `key`. Must return true only for the single caller that
   * created it (e.g. Redis `SET key value PX ttl NX`). The lock must expire
   * after `lockTtlMs` so a crashed process cannot block a key forever.
   */
  startProcessing(key: string, fingerprint: string, lockTtlMs: number): Promise<boolean>;
  get(key: string): Promise<StoredRecord | null>;
  /** Replace the lock with the final response, kept for `ttlMs`. */
  complete(key: string, record: StoredRecord, ttlMs: number): Promise<void>;
  /** Remove the lock so the client can retry (used when the handler fails). */
  release(key: string): Promise<void>;
}

/** Minimal subset of the ioredis API we need, so ioredis stays an optional dependency. */
export interface RedisLike {
  set(key: string, value: string, ...args: any[]): Promise<any>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<any>;
}

export interface IdempotentOptions {
  /** How long completed responses are kept, in ms. Default: 24h. */
  ttl?: number;
  /** How long an in-flight request holds the lock, in ms. Default: 30s. */
  lockTtl?: number;
  /** Request header carrying the key. Default: `idempotency-key`. */
  headerName?: string;
  /** Reject requests without the header with 400. Default: true. */
  required?: boolean;
  /** Maximum accepted key length. Default: 255. */
  maxKeyLength?: number;
  /** Optional per-tenant/user scope so different users can reuse the same key. */
  scope?: (req: any) => string | undefined;
}

export interface IdempotencyModuleOptions extends IdempotentOptions {
  /** Custom store. Takes priority over `redis`. */
  store?: IdempotencyStore;
  /** An ioredis (or compatible) client. Without `store`/`redis`, an in-memory store is used. */
  redis?: RedisLike;
  /** Prefix for all storage keys. Default: `idempotency`. */
  keyPrefix?: string;
}

export type ResolvedOptions = Required<Omit<IdempotencyModuleOptions, 'store' | 'redis' | 'scope'>> &
  Pick<IdempotencyModuleOptions, 'scope'>;
