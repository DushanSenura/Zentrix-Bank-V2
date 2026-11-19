import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE } from '../src/modules/ai/knowledge';
import { redact } from '../src/modules/ai/ai.service';
import { retrieve } from '../src/modules/ai/retrieval';
import { AnthropicProvider, createProvider } from '../src/modules/ai/provider';
import { shiftMonth, monthLabel } from '../src/modules/analytics/analytics.service';
import { detectRecurring } from '../src/modules/analytics/recurring';
import { evaluate, payeeKey, RISK_DEFAULTS, type PaymentFacts } from '../src/modules/risk/risk.service';

const DAY = 86_400_000;
const pay = (amount: number, payee: string | null = 'acct:1'): PaymentFacts => ({ id: 'p', initiatorId: 'u', amountMinor: BigInt(amount), postedAt: new Date(), payee });
const ctx = (over: Partial<Parameters<typeof evaluate>[1]> = {}) => ({ cfg: RISK_DEFAULTS, recentCount: 1, knownPayees: new Set(['acct:1']), newDeviceAt: null, history: [] as number[], ...over });

describe('risk rules', () => {
  it('stay quiet for an ordinary payment', () => { expect(evaluate(pay(100_000), ctx())).toEqual([]); });

  it('raise HIGH_VALUE at the threshold, HIGH severity at five times it, with the numbers that triggered them', () => {
    const t = RISK_DEFAULTS.highValueMinor;
    expect(evaluate(pay(t - 1), ctx())).toEqual([]);
    const mid = evaluate(pay(t), ctx());
    expect(mid).toHaveLength(1);
    expect(mid[0]).toMatchObject({ ruleCode: 'HIGH_VALUE', severity: 'MEDIUM', details: { amountMinor: t, thresholdMinor: t } });
    expect(evaluate(pay(t * 5), ctx())[0]!.severity).toBe('HIGH');
  });

  it('flag a velocity burst once (when the count reaches the threshold), not on every later payment', () => {
    const n = RISK_DEFAULTS.velocityCount;
    expect(evaluate(pay(100), ctx({ recentCount: n - 1 }))).toEqual([]);
    expect(evaluate(pay(100), ctx({ recentCount: n })).map((h) => h.ruleCode)).toEqual(['VELOCITY']);
    expect(evaluate(pay(100), ctx({ recentCount: n + 1 }))).toEqual([]);
  });

  it('flag only LARGE payments to a new payee, and only new-device activity above its threshold', () => {
    const big = RISK_DEFAULTS.newPayeeMinor;
    expect(evaluate(pay(big - 1, 'acct:new'), ctx())).toEqual([]);
    expect(evaluate(pay(big, 'acct:new'), ctx()).map((h) => h.ruleCode)).toEqual(['NEW_PAYEE_LARGE']);
    expect(evaluate(pay(big, 'acct:1'), ctx())).toEqual([]); // known payee
    const dev = evaluate(pay(RISK_DEFAULTS.newDeviceMinor), ctx({ newDeviceAt: new Date() }));
    expect(dev.map((h) => h.ruleCode)).toEqual(['NEW_DEVICE_ACTIVITY']);
    expect(evaluate(pay(RISK_DEFAULTS.newDeviceMinor - 1), ctx({ newDeviceAt: new Date() }))).toEqual([]);
  });

  it('anomaly experiment is off by default, needs history, and is low severity with its working shown', () => {
    const history = [10_000, 11_000, 9_500, 10_500, 10_200, 9_800, 10_100, 10_300, 9_900, 10_400];
    expect(evaluate(pay(500_000), ctx({ history }))).toEqual([]); // disabled
    const on = { ...RISK_DEFAULTS, anomalyEnabled: true, highValueMinor: 10 ** 9, newPayeeMinor: 10 ** 9 };
    expect(evaluate(pay(500_000), ctx({ cfg: on, history: history.slice(0, 5) }))).toEqual([]); // too little history
    const hits = evaluate(pay(500_000), ctx({ cfg: on, history }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ruleCode: 'ANOMALY_EXPERIMENT', severity: 'LOW' });
    expect(hits[0]!.details).toHaveProperty('robustZ');
    expect(JSON.stringify(hits[0]!.details)).toContain('Not a certified control');
    expect(evaluate(pay(10_600), ctx({ cfg: on, history }))).toEqual([]); // ordinary amount
  });

  it('identify payees by resolved destination, never by display name', () => {
    expect(payeeKey({ toAccountId: 'a1', name: 'Kamal' })).toBe('acct:a1');
    expect(payeeKey({ bankCode: 'X', accountNumber: '123', name: 'Same Name' })).not.toBe(payeeKey({ bankCode: 'X', accountNumber: '456', name: 'Same Name' }));
    expect(payeeKey({ name: 'only a name' })).toBeNull();
  });
});

describe('recurring detection and month helpers', () => {
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 30 * DAY);
  const rows = (amt: bigint, n: number, gap = 30) => Array.from({ length: n }, (_, i) => ({ destination: { billerCode: 'TEL-01', billerName: 'Mobile' }, amountMinor: amt, postedAt: new Date(Date.UTC(2026, 0, 1) + i * gap * DAY) }));
  it('needs three payments of the same amount at a regular interval', () => {
    expect(detectRecurring(rows(1_000n, 2))).toEqual([]);
    expect(detectRecurring(rows(1_000n, 3, 12))).toEqual([]); // not weekly or monthly
    const r = detectRecurring(rows(1_990n, 3));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ frequency: 'MONTHLY', amountMinor: 1_990, annualCostMinor: 1_990 * 12, monthlyEquivalentMinor: 1_990 });
    expect(detectRecurring(rows(700n, 4, 7))[0]).toMatchObject({ frequency: 'WEEKLY', annualCostMinor: 700 * 52 });
    expect(at(1).getTime()).toBeGreaterThan(at(0).getTime());
  });
  it('different amounts to the same recipient are not one subscription', () => {
    const mixed = [1000n, 1100n, 1200n].map((a, i) => ({ destination: { billerCode: 'X' }, amountMinor: a, postedAt: new Date(Date.UTC(2026, 0, 1) + i * 30 * DAY) }));
    expect(detectRecurring(mixed)).toEqual([]);
  });
  it('month arithmetic crosses year boundaries and uses Sri Lanka time', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-03', -14)).toBe('2025-01');
    expect(monthLabel(new Date('2026-03-31T19:00:00Z'))).toBe('2026-04'); // already 00:30 on 1 April in Colombo
  });
});

describe('help retrieval and AI plumbing', () => {
  it('finds the right approved passage for plain questions', () => {
    expect(retrieve('How do I freeze my card?', KNOWLEDGE)[0]!.passage.id).toBe('cards');
    expect(retrieve('what happens if I close my fixed deposit early', KNOWLEDGE)[0]!.passage.id).toBe('deposits');
    expect(retrieve('report a payment problem', KNOWLEDGE)[0]!.passage.id).toBe('disputes');
  });
  it('returns nothing for questions the documents do not cover, instead of guessing', () => {
    expect(retrieve('qwerty zzzz', KNOWLEDGE)).toEqual([]);
    expect(retrieve('the and of', KNOWLEDGE)).toEqual([]);
  });
  it('redacts long digit runs (account or card numbers) before anything leaves the server', () => {
    expect(redact('my card 4111 1111 1111 1111 is lost')).toBe('my card [number] is lost');
    expect(redact('account 12345678901 please')).toBe('account [number] please');
    expect(redact('I have 3 cards')).toBe('I have 3 cards');
  });
  it('is off without a key, and the provider surfaces failures without leaking response bodies', async () => {
    expect(createProvider({})).toBeNull();
    const p = createProvider({ ANTHROPIC_API_KEY: 'sk-test-1234567890' })!;
    expect(p.name).toBe('anthropic');
    const bad = new AnthropicProvider('k', 'm', (async () => new Response('prompt echo: secret', { status: 500 })) as never);
    await expect(bad.complete({ system: 's', user: 'u', maxTokens: 10 })).rejects.toThrow('AI provider responded 500');
    await expect(bad.complete({ system: 's', user: 'u', maxTokens: 10 })).rejects.not.toThrow(/secret/);
    const good = new AnthropicProvider('k', 'm', (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: ' hello ' }] }))) as never);
    expect(await good.complete({ system: 's', user: 'u', maxTokens: 10 })).toBe('hello');
  });
});

describe('AI isolation from payment authority', () => {
  const FORBIDDEN = /from '\.\.\/(payments|ledger|cards|loans|deposits|savings|accounts|auth|admin|support|documents|customers)\//;
  const dir = join(__dirname, '..', 'src', 'modules', 'ai');
  it('the AI module imports no banking service, no database client and no HTTP controller; only read-only analytics', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(FORBIDDEN);
      expect(src, f).not.toMatch(/PrismaService|@prisma\/client|PrismaClient/);
      expect(src, f).not.toMatch(/queueNotifications|outboxEvent/);
    }
    expect(readFileSync(join(dir, 'ai.service.ts'), 'utf8')).toMatch(/from '\.\.\/analytics\/analytics\.service'/);
  });
  it('the analytics service never writes', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'modules', 'analytics', 'analytics.service.ts'), 'utf8');
    expect(src).not.toMatch(/\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/);
    expect(src).not.toMatch(/INSERT|UPDATE "|DELETE FROM/i);
  });
});
