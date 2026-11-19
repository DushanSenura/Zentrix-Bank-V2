import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { AiService } from '../src/modules/ai/ai.service';
import type { AiProvider } from '../src/modules/ai/provider';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import { RemindersService } from '../src/modules/risk/reminders.service';
import { RiskService } from '../src/modules/risk/risk.service';
import { bearer, boot, makeLedgerAccount, makePayer, makeStaff, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

const DAY = 86_400_000;

describe.skipIf(!TEST_DB)('risk, analytics, AI and reminders (real database)', () => {
  let ctx: Ctx;
  let risk: RiskService;
  let n = 0;
  const runId = randomBytes(3).toString('hex');
  const nm = (p: string) => `${p}${n++}${runId}`;
  const keys = ['risk.highValueMinor', 'risk.velocityCount', 'risk.newPayeeMinor', 'risk.newDeviceMinor', 'risk.anomalyEnabled'];

  beforeAll(async () => { ctx = await boot(); risk = ctx.app.get(RiskService); });
  afterAll(async () => { await ctx.prisma.systemConfiguration.deleteMany({ where: { key: { in: keys } } }); await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  const setCfg = async (v: Record<string, number | boolean>) => { for (const [k, value] of Object.entries(v)) await ctx.prisma.systemConfiguration.upsert({ where: { key: `risk.${k}` }, update: { value }, create: { key: `risk.${k}`, value } }); };
  const pay = async (from: Payer, destination: object, amountMinor: number, note?: string) => {
    const d = await ctx.http.post('/api/v1/payments').set(bearer(from.token)).set('Idempotency-Key', randomBytes(8).toString('hex')).send({ sourceAccountId: from.accountId, destination, amountMinor, note });
    expect(d.status).toBe(201);
    const done = await ctx.http.post(`/api/v1/payments/${d.body.id}/authorize`).set(bearer(from.token)).send({ pin: PIN });
    expect(done.body.status).toBe('POSTED');
    return done.body as { id: string };
  };
  const toZ = (b: Payer) => ({ type: 'ZENTRIX', accountNumber: b.number });
  const alertsFor = (customerId: string) => ctx.prisma.riskAlert.findMany({ where: { customerId } });
  const ledgerBalance = async (p: Payer) => (await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: p.ledgerId } })).balanceMinor;

  it('risk scan raises explainable alerts for review, never touches the payment, and is safe to repeat', async () => {
    await setCfg({ highValueMinor: 10_000, newPayeeMinor: 15_000, velocityCount: 100, newDeviceMinor: 10 ** 11, anomalyEnabled: false });
    const a = await makePayer(ctx, nm('rka'), 5_000_000n);
    const b = await makePayer(ctx, nm('rkb'), 0n);
    const p = await pay(a, toZ(b), 20_000, 'rent');
    const before = await ledgerBalance(a);

    const first = await risk.scan();
    expect(first.raised).toBeGreaterThanOrEqual(2);
    const rules = (await alertsFor(a.id)).map((x) => x.ruleCode).sort();
    expect(rules).toEqual(['HIGH_VALUE', 'NEW_PAYEE_LARGE']);
    const hv = (await alertsFor(a.id)).find((x) => x.ruleCode === 'HIGH_VALUE')!;
    expect(hv).toMatchObject({ severity: 'MEDIUM', status: 'OPEN', paymentId: p.id });
    expect(hv.details).toMatchObject({ amountMinor: 20_000, thresholdMinor: 10_000 });

    expect((await risk.scan()).raised).toBe(0); // repeat: unique per (rule, payment)
    expect(await alertsFor(a.id)).toHaveLength(2);

    // Alerts never block, reverse or restrict anything.
    expect((await ctx.prisma.paymentInstruction.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('POSTED');
    expect(await ledgerBalance(a)).toBe(before);
    expect((await ctx.prisma.account.findUniqueOrThrow({ where: { id: a.accountId } })).status).toBe('ACTIVE');
    // Paying the same person again is no longer a "new payee".
    await pay(a, toZ(b), 20_000);
    await risk.scan();
    expect((await alertsFor(a.id)).filter((x) => x.ruleCode === 'NEW_PAYEE_LARGE')).toHaveLength(1);
  });

  it('staff workflow: queue, take, resolve with a note; permissions; high severity notifies reviewers', async () => {
    await setCfg({ highValueMinor: 1_000, newPayeeMinor: 10 ** 11, velocityCount: 100 });
    const a = await makePayer(ctx, nm('rsa'), 5_000_000n);
    const b = await makePayer(ctx, nm('rsb'), 0n);
    const officer = await makeStaff(ctx, nm('comp'), 'COMPLIANCE_OFFICER');
    const service = await makeStaff(ctx, nm('cs'), 'CUSTOMER_SERVICE');
    await pay(a, toZ(b), 20_000); // 20x the threshold -> HIGH
    await risk.scan();
    const alert = (await alertsFor(a.id)).find((x) => x.ruleCode === 'HIGH_VALUE')!;
    expect(alert.severity).toBe('HIGH');

    const get = (t: string, path: string) => ctx.http.get(`/api/v1/admin/risk/${path}`).set(bearer(t));
    expect((await get(a.token, 'alerts')).status).toBe(403); // customers
    expect((await get(service.token, 'alerts')).status).toBe(403); // staff without risk.review
    const q = await get(officer.token, 'alerts?status=OPEN');
    expect(q.status).toBe(200);
    const row = q.body.items.find((i: { id: string }) => i.id === alert.id);
    expect(row).toMatchObject({ severity: 'HIGH', ruleCode: 'HIGH_VALUE' });
    expect(row.customerName).toBeTruthy();

    await relayOutboxBatch(ctx.prisma as never, 1000);
    const inbox = await ctx.http.get('/api/v1/admin/notifications').set(bearer(officer.token));
    expect(inbox.status).toBe(200);
    const notes = inbox.body.items;
    expect((await ctx.http.get('/api/v1/admin/notifications').set(bearer(a.token))).status).toBe(403); // customers use /notifications
    expect(notes.some((x: { title: string }) => x.title === 'High-severity risk alert')).toBe(true);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(a.token))).body.items.some((x: { title: string }) => x.title.includes('risk'))).toBe(false); // the customer is not told

    const act = (path: string, body: object = {}) => ctx.http.post(`/api/v1/admin/risk/alerts/${alert.id}/${path}`).set(bearer(officer.token)).send(body);
    expect((await act('resolve', { status: 'CLEARED', note: 'ok' })).status).toBe(400); // note too short
    expect((await act('resolve', { status: 'BLOCKED', note: 'block them' })).status).toBe(400); // no such action exists
    expect((await act('take')).body.status).toBe('INVESTIGATING');
    expect((await act('take')).status).toBe(409);
    expect((await act('resolve', { status: 'CLEARED', note: 'Customer confirmed the rent payment by phone' })).status).toBe(201);
    expect((await act('resolve', { status: 'ESCALATED', note: 'changed my mind please' })).status).toBe(409);
    expect((await get(officer.token, 'alerts?status=CLEARED')).body.items.some((i: { id: string }) => i.id === alert.id)).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { subjectId: alert.id, actorId: officer.id } })).toBe(2);
    expect((await get(officer.token, 'summary')).status).toBe(200);
  });

  it('velocity and new-device rules fire from real data', async () => {
    await setCfg({ highValueMinor: 10 ** 11, newPayeeMinor: 10 ** 11, velocityCount: 3, newDeviceMinor: 1_000 });
    const a = await makePayer(ctx, nm('rva'), 5_000_000n);
    const b = await makePayer(ctx, nm('rvb'), 0n);
    for (let i = 0; i < 3; i++) await pay(a, toZ(b), 500);
    await risk.scan();
    expect((await alertsFor(a.id)).filter((x) => x.ruleCode === 'VELOCITY')).toHaveLength(1);

    // A first device is onboarding, not suspicious; a second, fresh device followed by a payment is.
    const c = await makePayer(ctx, nm('rdc'), 5_000_000n);
    await ctx.prisma.trustedDevice.create({ data: { userId: c.id, fingerprint: `old-${runId}`, trustedAt: new Date(Date.now() - 10 * DAY) } });
    await ctx.prisma.trustedDevice.create({ data: { userId: c.id, fingerprint: `new-${runId}`, trustedAt: new Date(Date.now() - 60_000) } });
    await pay(c, toZ(b), 2_000);
    const d = await makePayer(ctx, nm('rdd'), 5_000_000n);
    await ctx.prisma.trustedDevice.create({ data: { userId: d.id, fingerprint: `only-${runId}`, trustedAt: new Date(Date.now() - 60_000) } });
    await pay(d, toZ(b), 2_000);
    await risk.scan();
    expect((await alertsFor(c.id)).map((x) => x.ruleCode)).toContain('NEW_DEVICE_ACTIVITY');
    expect((await alertsFor(d.id)).map((x) => x.ruleCode)).not.toContain('NEW_DEVICE_ACTIVITY');
  });

  it('settings drive the thresholds and are validated', async () => {
    const admin = await makeStaff(ctx, nm('setadm'), 'BANK_ADMIN');
    const put = (key: string, value: unknown) => ctx.http.put(`/api/v1/admin/settings/${key}`).set(bearer(admin.token)).send({ value });
    expect((await put('risk.highValueMinor', 5)).status).toBe(400); // below minimum
    expect((await put('risk.anomalyEnabled', 'yes')).status).toBe(400);
    expect((await put('risk.velocityCount', 7)).status).toBeLessThan(300);
    expect((await risk.config()).velocityCount).toBe(7);
    await ctx.prisma.systemConfiguration.deleteMany({ where: { key: 'risk.velocityCount' } });
    expect((await risk.config()).velocityCount).toBe(5); // back to default
  });

  it('analytics: month summary from real payments; own transfers are not spending; zero-history comparisons are null', async () => {
    const a = await makePayer(ctx, nm('ana'), 2_000_000n);
    const b = await makePayer(ctx, nm('anb'), 500_000n);
    const own = await makeLedgerAccount(ctx, a.id, 0n);
    const get = (path: string) => ctx.http.get(`/api/v1/analytics/${path}`).set(bearer(a.token));

    await pay(a, toZ(b), 100_000, 'gift');
    await pay(a, { type: 'BILL', billerCode: 'ELEC-01', billRef: 'ACC1234' }, 25_050);
    const before = (await get('summary')).body;
    await pay(a, { type: 'OWN', accountId: own.id }, 40_000);
    await pay(b, toZ(a), 7_000, 'thanks');
    const s = (await get('summary')).body;

    expect(s.spentMinor).toBe(125_050);
    expect(s.spentMinor).toBe(before.spentMinor); // the own-account move did not count
    expect(s.categories.map((c: { category: string; spentMinor: number }) => [c.category, c.spentMinor])).toEqual([['Transfers', 100_000], ['Electricity', 25_050]]);
    expect(s.categories[0].sharePercent).toBe(80);
    expect(s.categories[0].changePercent).toBeNull(); // nothing last month to compare with
    expect(s.spentChangePercent).toBeNull();
    expect(s.moneyInMinor - before.moneyInMinor).toBe(7_000); // only b's payment; the own move is not income
    expect(s.netMinor).toBe(s.moneyInMinor - s.spentMinor);
    expect(s.largestPayments[0]).toMatchObject({ category: 'Transfers', amountMinor: 100_000 });
    expect(JSON.stringify(s)).not.toContain(b.number); // no counterparty identifiers

    expect((await get('summary?month=2026-13')).status).toBe(400);
    expect((await get('summary?month=abc')).status).toBe(400);
    const old = await get('summary?month=2020-05');
    expect(old.status).toBe(200);
    expect(old.body.spentMinor).toBe(0);

    const t = (await get('trend?months=3')).body.items;
    expect(t).toHaveLength(3);
    expect(t[2]).toMatchObject({ month: s.month, spentMinor: 125_050 });
    expect(t[0].spentMinor).toBe(0);
    expect((await get('trend?months=1')).status).toBe(400);

    const other = await makePayer(ctx, nm('ano'), 0n);
    expect((await ctx.http.get('/api/v1/analytics/summary').set(bearer(other.token))).body.spentMinor).toBe(0); // scoped to the caller
    expect((await ctx.http.get('/api/v1/analytics/summary')).status).toBe(401);
  });

  it('insights label facts and estimates; recurring analysis finds a monthly payment', async () => {
    const a = await makePayer(ctx, nm('ins'), 5_000_000n);
    const b = await makePayer(ctx, nm('insb'), 0n);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await pay(a, toZ(b), 1_990, 'streaming')).id);
    for (const [i, id] of ids.entries()) await ctx.prisma.paymentInstruction.update({ where: { id }, data: { postedAt: new Date(Date.now() - (2 - i) * 30 * DAY) } });
    const rec = (await ctx.http.get('/api/v1/analytics/recurring').set(bearer(a.token))).body;
    expect(rec.items).toHaveLength(1);
    expect(rec).toMatchObject({ monthlyTotalMinor: 1_990 });
    const ins = await ctx.app.get(AnalyticsService).insights(a.id);
    expect(ins.items.every((i) => i.kind === 'FACT' || i.kind === 'ESTIMATE')).toBe(true);
    expect(ins.items.some((i) => i.kind === 'ESTIMATE' && /regular payment/.test(i.title))).toBe(true);
    const api = (await ctx.http.get('/api/v1/ai/insights').set(bearer(a.token))).body;
    expect(api.narrative).toBeNull(); // no AI configured: statistics only, and it says so
    expect(api.narrativeIsAiGenerated).toBe(false);
    expect(api.disclaimer).toMatch(/not financial advice/);
  });

  it('AI help works without AI (approved passages only), refuses to act, and escalates what it cannot answer', async () => {
    const a = await makePayer(ctx, nm('ai'), 0n);
    expect((await ctx.http.get('/api/v1/ai/status').set(bearer(a.token))).body.enabled).toBe(false);
    const ask = (question: string, extra: object = {}) => ctx.http.post('/api/v1/ai/ask').set(bearer(a.token)).send({ question, ...extra });

    const r = await ask('How do I freeze my debit card?');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ answer: null, answerIsAiGenerated: false, matched: true, escalate: false });
    expect(r.body.sources[0].id).toBe('cards');

    const none = await ask('qwerty zzzz plugh');
    expect(none.body).toMatchObject({ matched: false, escalate: true, sources: [] });

    const act = await ask('Transfer money from my account to Kamal now');
    expect(act.body.actionNotice).toMatch(/cannot make changes/);

    expect((await ask('x')).status).toBe(400);
    expect((await ask('How do I freeze my card?', { includeMyData: true, role: 'admin' })).status).toBe(400); // strict body
    expect((await ctx.http.post('/api/v1/ai/ask').send({ question: 'How do cards work?' })).status).toBe(401);
  });

  it('with a provider: answers are labelled AI, prompts are scoped and redacted, failures fall back to the articles', async () => {
    const a = await makePayer(ctx, nm('aip'), 2_000_000n);
    const b = await makePayer(ctx, nm('aipb'), 0n);
    await pay(a, toZ(b), 12_345, 'books');
    const prompts: { system: string; user: string }[] = [];
    let fail = false;
    const provider: AiProvider = { name: 'fake', model: 'fake-1', complete: async (i) => { prompts.push({ system: i.system, user: i.user }); if (fail) throw new Error('boom'); return 'Freeze it in the card screen.'; } };
    const ai = new AiService(ctx.app.get(AnalyticsService), provider);

    const r = await ai.ask(a.id, `How do I freeze my card 4111 1111 1111 1111? My account is ${a.number}`, true);
    expect(r).toMatchObject({ answer: 'Freeze it in the card screen.', answerIsAiGenerated: true, matched: true });
    expect(r.sources.length).toBeGreaterThan(0);
    const sent = prompts[0]!;
    expect(sent.user).not.toContain('4111');
    expect(sent.user).not.toContain(a.number);
    expect(sent.user).toContain('[number]');
    expect(sent.user).toMatch(/spent 12345/); // scoped totals for THIS customer only
    expect(sent.user).not.toContain(b.number);
    expect(sent.system).toMatch(/cannot and must not perform/);
    expect(sent.system).toMatch(/Never ask for a PIN/);

    prompts.length = 0;
    await ai.ask(a.id, 'How do I freeze my card?', false);
    expect(prompts[0]!.user).not.toMatch(/spent \d/); // data only when the customer opted in

    const ins = await ai.insights(a.id);
    expect(ins.narrativeIsAiGenerated).toBe(true);
    expect(ins.items.length).toBeGreaterThan(0); // statistics are still returned, the narrative is extra

    fail = true;
    const down = await ai.ask(a.id, 'How do I freeze my card?', false);
    expect(down).toMatchObject({ answer: null, answerIsAiGenerated: false, matched: true });
    expect(down.sources.length).toBeGreaterThan(0);
    expect((await ai.insights(a.id)).narrative).toBeNull();
  });

  it('reminders: fixed-deposit maturity and tomorrow\'s scheduled payment, each exactly once; new-device login alert', async () => {
    const a = await makePayer(ctx, nm('rem'), 1_000_000n);
    const rem = ctx.app.get(RemindersService);
    const now = new Date();
    const fd = await ctx.prisma.fixedDeposit.create({ data: { reference: `FD${runId}${n++}`, customerId: a.id, fundingAccountId: a.accountId, ledgerAccountId: randomUUID(), originalPrincipalMinor: 500_000n, principalMinor: 500_000n, rateBps: 800, termMonths: 6, startDate: new Date(now.getTime() - 170 * DAY), maturityDate: new Date(now.getTime() + 3 * DAY), renewal: 'PAYOUT' } });
    const sp = await ctx.prisma.scheduledPayment.create({ data: { customerId: a.id, sourceAccountId: a.accountId, destination: { type: 'ZENTRIX' }, amountMinor: 3_000n, frequency: 'MONTHLY', nextRunAt: new Date(now.getTime() + 12 * 3_600_000) } });
    const r1 = await rem.runDue(now);
    expect(r1.fdMaturity).toBeGreaterThanOrEqual(1);
    expect(r1.scheduledPayments).toBeGreaterThanOrEqual(1);
    const r2 = await rem.runDue(now);
    expect(r2.fdMaturity).toBe(0);
    expect(r2.scheduledPayments).toBe(0);
    expect(await ctx.prisma.reminderLog.count({ where: { subjectId: { in: [fd.id, sp.id] } } })).toBe(2);
    await Promise.all([rem.runDue(now), rem.runDue(now)]); // two workers racing never duplicate
    await relayOutboxBatch(ctx.prisma as never, 1000);
    const notes = (await ctx.http.get('/api/v1/notifications').set(bearer(a.token))).body.items as { title: string }[];
    expect(notes.filter((x) => x.title === 'Fixed deposit maturing soon')).toHaveLength(1);
    expect(notes.filter((x) => x.title === 'Scheduled payment tomorrow')).toHaveLength(1);

    const trust = (fp: string) => ctx.http.post('/api/v1/security/devices').set(bearer(a.token)).send({ fingerprint: fp, label: 'Pixel 9' });
    await trust(`first-${runId}`);
    await relayOutboxBatch(ctx.prisma as never, 1000);
    const afterFirst = (await ctx.http.get('/api/v1/notifications').set(bearer(a.token))).body.items as { title: string }[];
    expect(afterFirst.some((x) => x.title === 'New device added')).toBe(false); // first device: no alert
    await trust(`second-${runId}`);
    await trust(`second-${runId}`); // re-trusting the same device is not "new"
    await relayOutboxBatch(ctx.prisma as never, 1000);
    const afterSecond = (await ctx.http.get('/api/v1/notifications').set(bearer(a.token))).body.items as { title: string }[];
    expect(afterSecond.filter((x) => x.title === 'New device added')).toHaveLength(1);
  });

  it('operations health reports the outbox and queues to staff with reports.read, and only to them', async () => {
    const ops = await makeStaff(ctx, nm('ops'), 'OPERATIONS_OFFICER');
    const card = await makeStaff(ctx, nm('cardo'), 'CARD_OFFICER');
    const c = await makePayer(ctx, nm('opsc'), 0n);
    expect((await ctx.http.get('/api/v1/admin/ops/health').set(bearer(c.token))).status).toBe(403);
    expect((await ctx.http.get('/api/v1/admin/ops/health').set(bearer(card.token))).status).toBe(403);
    const h = await ctx.http.get('/api/v1/admin/ops/health').set(bearer(ops.token));
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ outbox: { pending: expect.any(Number), oldestPendingSeconds: expect.any(Number) }, queues: { openTickets: expect.any(Number) } });
    expect(['OK', 'ATTENTION']).toContain(h.body.status);
    await ctx.prisma.outboxEvent.create({ data: { topic: 'test.stale', payload: {}, createdAt: new Date(Date.now() - 20 * 60_000) } });
    const stale = (await ctx.http.get('/api/v1/admin/ops/health').set(bearer(ops.token))).body;
    expect(stale.status).toBe('ATTENTION');
    expect(stale.warnings.join(' ')).toMatch(/behind/);
    await relayOutboxBatch(ctx.prisma as never, 1000); // leave the shared test DB clean
  });
});
