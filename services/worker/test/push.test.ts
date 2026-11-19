import { describe, expect, it } from 'vitest';
import { pushNotifications } from '../src/push';

const item = { userId: 'u1', category: 'SECURITY', title: 'New device added', body: 'Check it' };

describe('push gateway', () => {
  it('does nothing when no gateway is configured', async () => {
    const calls: string[] = [];
    const r = await pushNotifications([item], {}, (async (u: string) => { calls.push(u); return new Response('ok'); }) as never);
    expect(r).toEqual({ sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  it('posts only generic text with the bearer token, and counts failures without throwing', async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    let n = 0;
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      if (++n === 2) throw new Error('network down');
      return new Response('ok', { status: n === 3 ? 500 : 200 });
    }) as never;
    const r = await pushNotifications([item, item, item], { PUSH_WEBHOOK_URL: 'https://push.example/test', PUSH_WEBHOOK_TOKEN: 'tok' }, fake);
    expect(r).toEqual({ sent: 1, failed: 2 });
    expect(seen[0]!.headers.authorization).toBe('Bearer tok');
    expect(Object.keys(seen[0]!.body).sort()).toEqual(['body', 'category', 'title', 'userId']);
  });
});
