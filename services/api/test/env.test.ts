import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const key = Buffer.alloc(32, 7).toString('base64');
const base = {
  DATABASE_URL: 'postgresql://x',
  REDIS_URL: 'redis://x',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  DATA_ENCRYPTION_KEY: key,
};

describe('loadEnv', () => {
  it('accepts a complete configuration', () => {
    expect(loadEnv({ ...base }).API_PORT).toBe(3000);
  });
  it('requires strong secrets in every environment and never echoes values', () => {
    const bad = { ...base, JWT_ACCESS_SECRET: 'short-secret-value' };
    expect(() => loadEnv(bad)).toThrowError(/JWT_ACCESS_SECRET must be at least 32/);
    try {
      loadEnv(bad);
    } catch (e) {
      expect(String(e)).not.toContain('short-secret-value');
    }
  });
  it('rejects a wrong-length encryption key', () => {
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrowError(/32 bytes/);
  });
  it('rejects missing DATABASE_URL', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    expect(() => loadEnv(rest)).toThrowError(/DATABASE_URL/);
  });
});
