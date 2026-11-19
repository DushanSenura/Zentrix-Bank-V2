import { z } from 'zod';

const schema = z
  .object({
    APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    API_CORS_ORIGINS: z.string().default('http://localhost:5173'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
    JWT_ACCESS_SECRET: z.string().optional(),
    JWT_REFRESH_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Outside development, secrets must be present and strong. No weak fallbacks.
    if (env.APP_ENV !== 'development') {
      for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
        if (!env[k] || env[k]!.length < 32) {
          ctx.addIssue({ code: 'custom', path: [k], message: `${k} must be at least 32 characters` });
        }
      }
    }
  });

export type Env = z.infer<typeof schema>;

/** Parses and validates process.env. Throws with a readable message (never echoes secret values). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration - ${msg}`);
  }
  return parsed.data;
}
