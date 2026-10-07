import { DynamicModule, Global, Module, ModuleMetadata, Provider } from '@nestjs/common';
import { IDEMPOTENCY_OPTIONS, IDEMPOTENCY_STORE } from './constants';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyModuleOptions, ResolvedOptions } from './interfaces';
import { MemoryIdempotencyStore } from './stores/memory.store';
import { RedisIdempotencyStore } from './stores/redis.store';

export interface IdempotencyModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: any[];
  useFactory: (...args: any[]) => IdempotencyModuleOptions | Promise<IdempotencyModuleOptions>;
}

const DEFAULTS = {
  ttl: 24 * 60 * 60 * 1000,
  lockTtl: 30 * 1000,
  headerName: 'idempotency-key',
  required: true,
  maxKeyLength: 255,
  keyPrefix: 'idempotency',
};

function resolve(options: IdempotencyModuleOptions): ResolvedOptions {
  const { store, redis, ...rest } = options;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return { ...DEFAULTS, ...defined } as ResolvedOptions;
}

function createStore(options: IdempotencyModuleOptions) {
  if (options.store) return options.store;
  if (options.redis) return new RedisIdempotencyStore(options.redis);
  return new MemoryIdempotencyStore();
}

@Global()
@Module({})
export class IdempotencyModule {
  static forRoot(options: IdempotencyModuleOptions = {}): DynamicModule {
    return {
      module: IdempotencyModule,
      providers: [
        { provide: IDEMPOTENCY_OPTIONS, useValue: resolve(options) },
        { provide: IDEMPOTENCY_STORE, useValue: createStore(options) },
        IdempotencyInterceptor,
      ],
      exports: [IDEMPOTENCY_OPTIONS, IDEMPOTENCY_STORE, IdempotencyInterceptor],
    };
  }

  static forRootAsync(options: IdempotencyModuleAsyncOptions): DynamicModule {
    const RAW = Symbol('IDEMPOTENCY_RAW_OPTIONS');
    const providers: Provider[] = [
      { provide: RAW, useFactory: options.useFactory, inject: options.inject ?? [] },
      {
        provide: IDEMPOTENCY_OPTIONS,
        useFactory: (raw: IdempotencyModuleOptions) => resolve(raw),
        inject: [RAW],
      },
      {
        provide: IDEMPOTENCY_STORE,
        useFactory: (raw: IdempotencyModuleOptions) => createStore(raw),
        inject: [RAW],
      },
      IdempotencyInterceptor,
    ];
    return {
      module: IdempotencyModule,
      imports: options.imports ?? [],
      providers,
      exports: [IDEMPOTENCY_OPTIONS, IDEMPOTENCY_STORE, IdempotencyInterceptor],
    };
  }
}
