import { z } from 'zod';

const schema = z.object({
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  // Required in every environment - there are no weak fallbacks.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be base64 of exactly 32 bytes'),
  // Shared secret the worker presents to run scheduled jobs. Unset => the internal endpoint is disabled.
  INTERNAL_JOB_TOKEN: z.string().min(32, 'INTERNAL_JOB_TOKEN must be at least 32 characters').optional(),
  // Optional AI answers. Unset => the AI features report themselves as off; nothing else depends on them.
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  AI_MODEL: z.string().min(3).optional(),
  // Staging convenience: lets an inviting admin see a new staff member's one-time setup token (there is no email delivery yet).
  // Never honoured in production.
  ALLOW_SETUP_TOKEN_IN_RESPONSE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  CUSTOMER_SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  STAFF_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(12),
});

export type Env = z.infer<typeof schema>;
export const ENV = Symbol('ENV');

/** Parses and validates process.env. Throws with a readable message (never echoes secret values). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Container platforms pass an unset optional variable as an empty string; for optional settings that means "not configured".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration - ${msg}`);
  }
  return parsed.data;
}
