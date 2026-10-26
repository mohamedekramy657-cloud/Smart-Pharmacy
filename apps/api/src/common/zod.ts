import { Body, Param, ParseUUIDPipe, PipeTransform, Query } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z, ZodType } from 'zod';
import { Errors } from './errors';

export class ZodPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw Errors.validation(
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      );
    }
    return result.data;
  }
}

function toOpenApi(schema: ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

/** Validates the JSON body with a strict zod schema AND documents it in OpenAPI. */
export function ZBody(schema: ZodType): ParameterDecorator {
  return (target, key, index) => {
    if (key) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
      ApiBody({ schema: toOpenApi(schema) as never })(target, key, descriptor);
    }
    Body(new ZodPipe(schema))(target, key, index);
  };
}

/** Validates query parameters and documents each field in OpenAPI. */
export function ZQuery(schema: z.ZodObject): ParameterDecorator {
  return (target, key, index) => {
    if (key) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
      const json = toOpenApi(schema) as { properties?: Record<string, object>; required?: string[] };
      for (const [name, prop] of Object.entries(json.properties ?? {})) {
        ApiQuery({ name, required: json.required?.includes(name) ?? false, schema: prop as never })(target, key, descriptor);
      }
    }
    Query(new ZodPipe(schema))(target, key, index);
  };
}

/** UUID path parameter (rejects malformed ids with 400 before hitting the database). */
export const UuidParam = (name: string) => Param(name, new ParseUUIDPipe({ version: undefined, exceptionFactory: () => Errors.badRequest(`Invalid ${name}`) }));

// Reusable primitives
export const zId = z.uuid();
export const zQty = z.number().int().min(1).max(100000);
export const zNonNegQty = z.number().int().min(0).max(1000000);
export const zText = (max = 500) => z.string().trim().max(max);
export const zMoney = z.union([z.string(), z.number()]).transform((v) => String(v)).pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Invalid amount'));
export const zPage = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const zLat = z.number().min(-90).max(90);
export const zLng = z.number().min(-180).max(180);
