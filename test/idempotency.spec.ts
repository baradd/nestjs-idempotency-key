import { Body, Controller, HttpCode, INestApplication, Post, BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  Idempotent,
  IdempotencyModule,
  IdempotencyStore,
  MemoryIdempotencyStore,
  RedisIdempotencyStore,
  RedisLike,
} from '../src';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Controller('payments')
class PaymentsController {
  calls = 0;

  @Post()
  @Idempotent()
  create(@Body() body: { amount: number }) {
    this.calls++;
    return { id: this.calls, amount: body.amount };
  }

  @Post('accepted')
  @HttpCode(202)
  @Idempotent()
  accepted() {
    this.calls++;
    return { queued: true };
  }

  @Post('slow')
  @Idempotent()
  async slow() {
    await sleep(200);
    this.calls++;
    return { ok: true };
  }

  @Post('fail')
  @Idempotent()
  fail() {
    this.calls++;
    throw new BadRequestException('nope');
  }

  @Post('optional')
  @Idempotent({ required: false })
  optional() {
    this.calls++;
    return { n: this.calls };
  }
}

/** Tiny in-memory fake that mimics the ioredis calls we use (SET ... PX ... NX, GET, DEL). */
class FakeRedis implements RedisLike {
  private data = new Map<string, { v: string; exp: number }>();
  async set(key: string, value: string, ...args: any[]) {
    const ttl = args[0] === 'PX' ? args[1] : Infinity;
    const nx = args.includes('NX');
    const cur = this.data.get(key);
    if (nx && cur && cur.exp > Date.now()) return null;
    this.data.set(key, { v: value, exp: Date.now() + ttl });
    return 'OK';
  }
  async get(key: string) {
    const cur = this.data.get(key);
    return cur && cur.exp > Date.now() ? cur.v : null;
  }
  async del(key: string) {
    return this.data.delete(key) ? 1 : 0;
  }
}

describe.each<[string, () => IdempotencyStore]>([
  ['memory store', () => new MemoryIdempotencyStore()],
  ['redis store', () => new RedisIdempotencyStore(new FakeRedis())],
])('Idempotency (%s)', (_name, makeStore) => {
  let app: INestApplication;
  let controller: PaymentsController;
  let key = 0;
  const nextKey = () => `key-${++key}`;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({ store: makeStore() })],
      controllers: [PaymentsController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    controller = moduleRef.get(PaymentsController);
  });

  afterEach(() => app.close());

  const post = (path: string, body: object, k?: string) => {
    const r = request(app.getHttpServer()).post(path).send(body);
    return k ? r.set('Idempotency-Key', k) : r;
  };

  it('rejects requests without a key (400)', async () => {
    await post('/payments', { amount: 100 }).expect(400);
    expect(controller.calls).toBe(0);
  });

  it('runs the handler once and replays the response on retry', async () => {
    const k = nextKey();
    const first = await post('/payments', { amount: 100 }, k).expect(201);
    const second = await post('/payments', { amount: 100 }, k).expect(201);

    expect(controller.calls).toBe(1);
    expect(second.body).toEqual(first.body);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('keeps custom status codes on replay', async () => {
    const k = nextKey();
    await post('/payments/accepted', {}, k).expect(202);
    await post('/payments/accepted', {}, k).expect(202);
    expect(controller.calls).toBe(1);
  });

  it('returns 422 when the key is reused with a different body', async () => {
    const k = nextKey();
    await post('/payments', { amount: 100 }, k).expect(201);
    await post('/payments', { amount: 999 }, k).expect(422);
    expect(controller.calls).toBe(1);
  });

  it('treats different keys as different requests', async () => {
    await post('/payments', { amount: 100 }, nextKey()).expect(201);
    await post('/payments', { amount: 100 }, nextKey()).expect(201);
    expect(controller.calls).toBe(2);
  });

  it('returns 409 for a concurrent request with the same key', async () => {
    const k = nextKey();
    const [a, b] = await Promise.all([
      post('/payments/slow', {}, k),
      sleep(50).then(() => post('/payments/slow', {}, k)),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(controller.calls).toBe(1);
  });

  it('does not cache failures: the client can retry after an error', async () => {
    const k = nextKey();
    await post('/payments/fail', {}, k).expect(400);
    await post('/payments/fail', {}, k).expect(400);
    expect(controller.calls).toBe(2); // handler ran again, key was released
  });

  it('allows the header to be optional per route', async () => {
    await post('/payments/optional', {}).expect(201);
    await post('/payments/optional', {}).expect(201);
    expect(controller.calls).toBe(2);
  });
});
