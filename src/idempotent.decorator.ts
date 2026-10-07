import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { IDEMPOTENT_METADATA } from './constants';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotentOptions } from './interfaces';

/**
 * Make a route (or a whole controller) idempotent.
 *
 *   @Post()
 *   @Idempotent()
 *   create(@Body() dto: CreatePaymentDto) { ... }
 */
export function Idempotent(options: IdempotentOptions = {}): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(IDEMPOTENT_METADATA, options),
    UseInterceptors(IdempotencyInterceptor),
  ) as MethodDecorator & ClassDecorator;
}
