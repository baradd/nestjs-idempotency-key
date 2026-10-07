import { createHash } from 'crypto';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, catchError, from, mergeMap, of, throwError } from 'rxjs';
import { IDEMPOTENCY_OPTIONS, IDEMPOTENCY_STORE, IDEMPOTENT_METADATA } from './constants';
import {
  IdempotencyStore,
  IdempotentOptions,
  ResolvedOptions,
  StoredRecord,
} from './interfaces';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(IDEMPOTENCY_OPTIONS) private readonly defaults: ResolvedOptions,
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const handlerOptions = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    const opts = this.merge(handlerOptions);

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    // 1. Read and validate the key.
    const rawHeader = req.headers?.[opts.headerName.toLowerCase()];
    const idemKey: string | undefined = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!idemKey) {
      if (opts.required) {
        throw new BadRequestException(`Missing required header: ${opts.headerName}`);
      }
      return next.handle();
    }
    if (idemKey.length > opts.maxKeyLength) {
      throw new BadRequestException(
        `${opts.headerName} must be at most ${opts.maxKeyLength} characters`,
      );
    }

    // 2. Build the storage key and the request fingerprint.
    const url: string = req.originalUrl ?? req.url ?? '';
    const path = url.split('?')[0];
    const scope = opts.scope?.(req) ?? '';
    const storageKey = [this.defaults.keyPrefix, scope, req.method, path, idemKey].join(':');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([req.method, url, req.body ?? null]))
      .digest('hex');

    // 3. Try to claim the key atomically.
    const acquired = await this.store.startProcessing(storageKey, fingerprint, opts.lockTtl);
    if (acquired) {
      return this.execute(context, next, res, storageKey, fingerprint, opts);
    }

    // 4. Someone else already claimed it: replay or reject.
    const existing = await this.store.get(storageKey);
    if (!existing) {
      // The record expired between the two calls; ask the client to retry.
      throw new ConflictException('Request state changed, please retry');
    }
    if (existing.fingerprint !== fingerprint) {
      throw new UnprocessableEntityException(
        `${opts.headerName} was already used with a different request payload`,
      );
    }
    if (existing.status === 'in_progress') {
      this.setHeader(res, 'Retry-After', '1');
      throw new ConflictException('A request with this idempotency key is still being processed');
    }
    return this.replay(res, existing);
  }

  private execute(
    context: ExecutionContext,
    next: CallHandler,
    res: any,
    storageKey: string,
    fingerprint: string,
    opts: ResolvedOptions,
  ): Observable<unknown> {
    return next.handle().pipe(
      mergeMap(async (body) => {
        const record: StoredRecord = {
          status: 'completed',
          fingerprint,
          response: { statusCode: this.resolveStatus(context, res), body: body ?? null },
        };
        try {
          await this.store.complete(storageKey, record, opts.ttl);
        } catch (err) {
          // The work is already done; don't fail the client because caching failed.
          this.logger.error(`Failed to store idempotent response: ${(err as Error).message}`);
        }
        return body;
      }),
      catchError((err) =>
        // Failed requests are not cached: free the key so the client can retry.
        from(this.store.release(storageKey).catch(() => undefined)).pipe(
          mergeMap(() => throwError(() => err)),
        ),
      ),
    );
  }

  private replay(res: any, record: StoredRecord): Observable<unknown> {
    const stored = record.response!;
    this.setStatus(res, stored.statusCode);
    this.setHeader(res, 'Idempotent-Replayed', 'true');
    return of(stored.body);
  }

  /** Nest applies the final status after interceptors run, so work it out ourselves. */
  private resolveStatus(context: ExecutionContext, res: any): number {
    const explicit = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
    if (explicit) return explicit;
    if (res.statusCode && res.statusCode !== 200) return res.statusCode;
    return context.switchToHttp().getRequest().method === 'POST' ? 201 : 200;
  }

  private merge(handlerOptions?: IdempotentOptions): ResolvedOptions {
    const defined = Object.fromEntries(
      Object.entries(handlerOptions ?? {}).filter(([, v]) => v !== undefined),
    );
    return { ...this.defaults, ...defined };
  }

  // Works for both Express and Fastify.
  private setStatus(res: any, code: number): void {
    if (typeof res.status === 'function') res.status(code);
    else if (typeof res.code === 'function') res.code(code);
  }

  private setHeader(res: any, name: string, value: string): void {
    if (typeof res.header === 'function') res.header(name, value);
    else if (typeof res.setHeader === 'function') res.setHeader(name, value);
  }
}
