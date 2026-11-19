import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const base = { DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x' };

describe('loadEnv', () => {
  it('allows missing JWT secrets in development', () => {
    expect(loadEnv({ ...base, APP_ENV: 'development' }).API_PORT).toBe(3000);
  });
  it('requires strong secrets in production and never echoes values', () => {
    expect(() => loadEnv({ ...base, APP_ENV: 'production', JWT_ACCESS_SECRET: 'short-secret-value' })).toThrowError(
      /JWT_ACCESS_SECRET must be at least 32/,
    );
    try {
      loadEnv({ ...base, APP_ENV: 'production', JWT_ACCESS_SECRET: 'short-secret-value' });
    } catch (e) {
      expect(String(e)).not.toContain('short-secret-value');
    }
  });
  it('rejects missing DATABASE_URL', () => {
    expect(() => loadEnv({ REDIS_URL: 'redis://x' })).toThrowError(/DATABASE_URL/);
  });
});
