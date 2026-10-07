# nestjs-idempotency-key

Stripe-style `Idempotency-Key` support for NestJS. Retried requests (timeouts, flaky mobile networks, queue workers) run your handler **once** and get the original response back.

```bash
npm install nestjs-idempotency-key
```

## Quick start

```ts
// app.module.ts
import Redis from 'ioredis';
import { IdempotencyModule } from 'nestjs-idempotency-key';

@Module({
  imports: [
    IdempotencyModule.forRoot({ redis: new Redis(process.env.REDIS_URL) }),
  ],
})
export class AppModule {}
```

```ts
// payments.controller.ts
import { Idempotent } from 'nestjs-idempotency-key';

@Controller('payments')
export class PaymentsController {
  @Post()
  @Idempotent()
  create(@Body() dto: CreatePaymentDto) {
    return this.payments.charge(dto); // runs once per Idempotency-Key
  }
}
```

```bash
curl -X POST localhost:3000/payments \
  -H 'Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7' \
  -H 'Content-Type: application/json' \
  -d '{"amount":100}'
```

## Behaviour

| Situation                                   | Result                                                       |
| ------------------------------------------- | ------------------------------------------------------------ |
| First request with a key                    | Handler runs, response is stored                             |
| Same key + same payload, after completion   | Stored response replayed, `Idempotent-Replayed: true` header |
| Same key while the first request is running | `409 Conflict` + `Retry-After: 1`                            |
| Same key, different payload                 | `422 Unprocessable Entity`                                   |
| Handler throws                              | Nothing cached, key released, client can retry               |
| Header missing                              | `400` (or pass through with `required: false`)               |

Keys are scoped by HTTP method and path, so one key can't collide across endpoints.

## Options

Set globally in `forRoot()` / `forRootAsync()` and override per route with `@Idempotent({ ... })`.

| Option            | Default           | Description                                                           |
| ----------------- | ----------------- | --------------------------------------------------------------------- |
| `ttl`             | 24h               | How long completed responses are kept (ms)                            |
| `lockTtl`         | 30s               | Max time an in-flight request holds the key (ms)                      |
| `headerName`      | `idempotency-key` | Header carrying the key                                               |
| `required`        | `true`            | Reject requests without the header                                    |
| `maxKeyLength`    | 255               | Longest accepted key                                                  |
| `scope`           | none              | `(req) => string`, e.g. user id, so users can't see each other's keys |
| `keyPrefix`       | `idempotency`     | Prefix for storage keys (module-level)                                |
| `store` / `redis` | in-memory         | Custom `IdempotencyStore`, or an ioredis client                       |

## Custom stores

Implement `IdempotencyStore` (`startProcessing`, `get`, `complete`, `release`). `startProcessing` must be atomic, like Redis `SET NX PX`.

## Limitations

- Responses must be JSON-serializable (no streams or file downloads).
- Set `lockTtl` above your handler's worst-case duration, otherwise a slow request can lose its lock.
- The in-memory store is per-process; use Redis with more than one instance.
- Works with Express and Fastify; tested on Express.

## License

MIT
