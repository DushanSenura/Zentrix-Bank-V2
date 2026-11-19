export interface PushItem { userId: string; category: string; title: string; body: string }

/**
 * Optional push delivery through a configurable HTTP gateway (PUSH_WEBHOOK_URL, optional PUSH_WEBHOOK_TOKEN).
 * The in-app notification row is already stored before this runs, so a gateway failure never loses a notification;
 * it only means no push was sent. Pushes are best-effort and are NOT retried. Without PUSH_WEBHOOK_URL this does nothing.
 * Only generic text is sent (title, body, category and the user id), never balances or account numbers.
 */
export async function pushNotifications(items: PushItem[], env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<{ sent: number; failed: number }> {
  const url = env.PUSH_WEBHOOK_URL;
  if (!url || items.length === 0) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  for (const i of items) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(env.PUSH_WEBHOOK_TOKEN ? { authorization: `Bearer ${env.PUSH_WEBHOOK_TOKEN}` } : {}) },
        body: JSON.stringify({ userId: i.userId, category: i.category, title: i.title, body: i.body }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) sent++; else failed++;
    } catch {
      failed++;
    }
  }
  return { sent, failed };
}
