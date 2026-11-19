import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CardsService } from '../src/modules/cards/cards.service';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { bearer, boot, makePayer, makeStaff, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

describe.skipIf(!TEST_DB)('cards (real database)', () => {
  let ctx: Ctx;
  let cards: CardsService;
  let branchId: string;
  let n = 0;
  const runId = randomBytes(3).toString('hex');
  const nm = (p: string) => `${p}${n++}${runId}`;

  beforeAll(async () => {
    ctx = await boot();
    cards = ctx.app.get(CardsService);
    branchId = (await ctx.prisma.branch.upsert({ where: { code: 'TEST-COL' }, update: {}, create: { code: 'TEST-COL', name: 'Colombo Fort', city: 'Colombo', address: '1 Test Rd' } })).id;
  });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  const request = (p: Payer, body: object) => ctx.http.post('/api/v1/cards').set(bearer(p.token)).send({ accountId: p.accountId, pin: PIN, ...body });
  const decide = (token: string, id: string, body: object) => ctx.http.post(`/api/v1/admin/cards/${id}/decision`).set(bearer(token)).send(body);
  const get = (p: Payer, id: string) => ctx.http.get(`/api/v1/cards/${id}`).set(bearer(p.token));
  const dbCard = (id: string) => ctx.prisma.card.findUniqueOrThrow({ where: { id } });

  it('Scenario C: customer requests a virtual card -> staff sees it -> approves -> active -> customer notified', async () => {
    const c = await makePayer(ctx, nm('virt'), 100_000n);
    const officer = await makeStaff(ctx, nm('cardoff'), 'CARD_OFFICER');
    const r = await request(c, { kind: 'VIRTUAL' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'VIRTUAL', status: 'PENDING_APPROVAL', statusText: 'Awaiting bank approval', maskedNumber: null });

    const queue = await ctx.http.get('/api/v1/admin/cards').set(bearer(officer.token));
    expect(queue.body.items.some((i: { id: string }) => i.id === r.body.id)).toBe(true);

    expect((await decide(officer.token, r.body.id, { decision: 'REJECT' })).status).toBe(400); // reason required
    const ok = await decide(officer.token, r.body.id, { decision: 'APPROVE' });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('ACTIVE'); // virtual cards are activated by the bank
    expect((await decide(officer.token, r.body.id, { decision: 'APPROVE' })).status).toBe(409);

    const card = (await get(c, r.body.id)).body;
    expect(card.status).toBe('ACTIVE');
    expect(card.maskedNumber).toMatch(/^•{4} •{4} •{4} \d{4}$/);
    expect(card.expiry).toMatch(/^\d{2}\/\d{2}$/);
    const raw = JSON.stringify((await ctx.http.get('/api/v1/cards').set(bearer(c.token))).body);
    expect(raw).not.toMatch(/token|pinHash|cvv|cvc|\bpan\b/i); // no secrets ever leave the server
    const row = await dbCard(r.body.id);
    expect(row.token).toMatch(/^tok_/);
    expect(row.last4).toHaveLength(4);

    await relayOutboxBatch(ctx.prisma as never, 500);
    const notes = (await ctx.http.get('/api/v1/notifications').set(bearer(c.token))).body.items;
    expect(notes.some((x: { title: string }) => x.title === 'Virtual card ready')).toBe(true);
    expect(await ctx.prisma.cardStatusHistory.count({ where: { cardId: r.body.id } })).toBe(2);
    expect(await ctx.prisma.auditLog.count({ where: { subjectId: r.body.id, action: 'card.approve', actorId: officer.id } })).toBe(1);
  });

  it('debit card: approval -> 5 days preparing -> ready to collect -> customer activates with app PIN and chooses a card PIN', async () => {
    const c = await makePayer(ctx, nm('deb'), 100_000n);
    const officer = await makeStaff(ctx, nm('cardoff'), 'CARD_OFFICER');
    expect((await request(c, { kind: 'DEBIT' })).status).toBe(400); // branch required
    expect((await request(c, { kind: 'DEBIT', collectionBranchId: branchId, pin: '000000' })).status).toBe(401); // PIN is verified by the server
    const r = await request(c, { kind: 'DEBIT', collectionBranchId: branchId });
    expect(r.status).toBe(201);
    expect((await request(c, { kind: 'DEBIT', collectionBranchId: branchId })).status).toBe(409); // one in flight at a time

    const ap = await decide(officer.token, r.body.id, { decision: 'APPROVE' });
    expect(ap.body.status).toBe('PREPARING');
    const prep = (await get(c, r.body.id)).body;
    expect(prep).toMatchObject({ status: 'PREPARING', collectionBranch: 'Colombo Fort, Colombo' });
    const days = (new Date(prep.readyOn).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(4.9);
    expect(days).toBeLessThan(5.1);

    const act = (body: object) => ctx.http.post(`/api/v1/cards/${r.body.id}/activate`).set(bearer(c.token)).send(body);
    expect((await act({ pin: PIN, cardPin: '4821' })).status).toBe(409); // not collected yet

    expect(await cards.runDue(new Date())).toBeGreaterThanOrEqual(0);
    expect((await get(c, r.body.id)).body.status).toBe('PREPARING'); // time has not passed
    await cards.runDue(new Date(Date.now() + 6 * 86_400_000));
    await cards.runDue(new Date(Date.now() + 7 * 86_400_000)); // idempotent
    expect((await get(c, r.body.id)).body.status).toBe('READY_TO_COLLECT');
    expect(await ctx.prisma.cardStatusHistory.count({ where: { cardId: r.body.id, toStatus: 'READY_TO_COLLECT' } })).toBe(1);
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(c.token))).body.items.some((x: { title: string; body: string }) => x.title === 'Card ready to collect' && x.body.includes('Colombo Fort'))).toBe(true);

    expect((await act({ pin: '000000', cardPin: '4821' })).status).toBe(401);
    expect((await act({ pin: PIN, cardPin: '1111' })).status).toBe(400); // weak card PIN
    const ok = await act({ pin: PIN, cardPin: '4821' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ACTIVE');
    const row = await dbCard(r.body.id);
    expect(row.pinHash).toMatch(/^\$argon2id\$/);
    expect(row.pinHash).not.toContain('4821');

    // card PIN change (simulated issuer): current must match; throttled/weak refused
    const change = (b: object) => ctx.http.put(`/api/v1/cards/${r.body.id}/pin`).set(bearer(c.token)).send(b);
    expect((await change({ currentPin: '9999', newPin: '5732' })).status).toBe(401);
    expect((await change({ currentPin: '4821', newPin: '2222' })).status).toBe(400);
    expect((await change({ currentPin: '4821', newPin: '5732' })).status).toBe(204);
    expect((await change({ currentPin: '4821', newPin: '6843' })).status).toBe(401); // the old PIN no longer works
  });

  it('controls: tightening is free; loosening needs the PIN; the bank maximum is enforced; freeze/unfreeze', async () => {
    const c = await makePayer(ctx, nm('ctl'), 100_000n);
    const officer = await makeStaff(ctx, nm('cardoff'), 'CARD_OFFICER');
    const r = await request(c, { kind: 'VIRTUAL' });
    const put = (b: object) => ctx.http.put(`/api/v1/cards/${r.body.id}/controls`).set(bearer(c.token)).send(b);
    expect((await put({ dailyLimitMinor: 1000 })).status).toBe(409); // not active yet
    await decide(officer.token, r.body.id, { decision: 'APPROVE' });

    const base = (await get(c, r.body.id)).body.controls;
    expect(base).toMatchObject({ onlineEnabled: true, internationalEnabled: false, maxDailyLimitMinor: 50_000_000 });
    expect((await put({ dailyLimitMinor: 500_000 })).body.controls.dailyLimitMinor).toBe(500_000); // lower: no PIN
    expect((await put({ onlineEnabled: false })).body.controls.onlineEnabled).toBe(false);
    expect((await put({ dailyLimitMinor: 800_000 })).status).toBe(400); // raise: PIN required
    expect((await put({ dailyLimitMinor: 800_000, pin: '000000' })).status).toBe(401);
    expect((await put({ dailyLimitMinor: 800_000, pin: PIN })).body.controls.dailyLimitMinor).toBe(800_000);
    expect((await put({ internationalEnabled: true })).status).toBe(400); // enabling a capability needs the PIN
    expect((await put({ internationalEnabled: true, pin: PIN })).body.controls.internationalEnabled).toBe(true);
    expect((await put({ dailyLimitMinor: 50_000_001, pin: PIN })).status).toBe(422);

    const fz = (frozen: boolean) => ctx.http.post(`/api/v1/cards/${r.body.id}/freeze`).set(bearer(c.token)).send({ frozen });
    expect((await fz(false)).status).toBe(409); // not frozen
    expect((await fz(true)).body.status).toBe('FROZEN');
    expect((await fz(true)).status).toBe(409);
    expect((await put({ dailyLimitMinor: 100 })).status).toBe(200); // controls still editable while frozen
    expect((await fz(false)).body.status).toBe('ACTIVE');
    expect(await ctx.prisma.cardStatusHistory.count({ where: { cardId: r.body.id, toStatus: { in: ['FROZEN', 'ACTIVE'] } } })).toBe(3);
  });

  it('reporting a card lost blocks it permanently and orders a replacement through the approval queue', async () => {
    const c = await makePayer(ctx, nm('lost'), 100_000n);
    const officer = await makeStaff(ctx, nm('cardoff'), 'CARD_OFFICER');
    const d = await request(c, { kind: 'DEBIT', collectionBranchId: branchId });
    await decide(officer.token, d.body.id, { decision: 'APPROVE' });
    await cards.runDue(new Date(Date.now() + 6 * 86_400_000));
    await ctx.http.post(`/api/v1/cards/${d.body.id}/activate`).set(bearer(c.token)).send({ pin: PIN, cardPin: '4821' });

    const lost = (id: string, pin = PIN) => ctx.http.post(`/api/v1/cards/${id}/report-lost`).set(bearer(c.token)).send({ pin });
    expect((await lost(d.body.id, '000000')).status).toBe(401);
    const r = await lost(d.body.id);
    expect(r.status).toBe(200);
    expect(r.body.blocked).toBe(true);
    expect(r.body.replacementId).toBeTruthy();
    expect((await get(c, d.body.id)).body.status).toBe('BLOCKED');
    expect((await lost(d.body.id)).status).toBe(409);
    expect((await ctx.http.post(`/api/v1/cards/${d.body.id}/freeze`).set(bearer(c.token)).send({ frozen: false })).status).toBe(409); // permanent
    expect((await ctx.http.put(`/api/v1/cards/${d.body.id}/controls`).set(bearer(c.token)).send({ dailyLimitMinor: 1 })).status).toBe(409);

    const q = (await ctx.http.get('/api/v1/admin/cards').set(bearer(officer.token))).body.items;
    expect(q.find((i: { id: string }) => i.id === r.body.replacementId)).toMatchObject({ replacement: true, kind: 'DEBIT' });
    expect((await request(c, { kind: 'DEBIT', collectionBranchId: branchId })).status).toBe(409); // replacement already in flight

    const v = await request(c, { kind: 'VIRTUAL' });
    await decide(officer.token, v.body.id, { decision: 'APPROVE' });
    expect((await lost(v.body.id)).body.replacementId).toBeNull(); // virtual cards are not re-issued
  });

  it('credit card applications need income details and a staff-set limit', async () => {
    const c = await makePayer(ctx, nm('cr'), 100_000n);
    const officer = await makeStaff(ctx, nm('cardoff'), 'CARD_OFFICER');
    expect((await request(c, { kind: 'CREDIT' })).status).toBe(400);
    const r = await request(c, { kind: 'CREDIT', application: { monthlyIncomeMinor: 25_000_000, employment: 'Engineer', requestedLimitMinor: 20_000_000 } });
    expect(r.status).toBe(201);
    expect((await decide(officer.token, r.body.id, { decision: 'APPROVE' })).status).toBe(400); // limit required
    const ok = await decide(officer.token, r.body.id, { decision: 'APPROVE', creditLimitMinor: 15_000_000 });
    expect(ok.body.status).toBe('PREPARING');
    expect((await get(c, r.body.id)).body.creditLimitMinor).toBe(15_000_000);
  });

  it('rejections explain themselves; virtual cards are capped; the bank can block', async () => {
    const c = await makePayer(ctx, nm('cap'), 100_000n);
    const officer = await makeStaff(ctx, nm('cardoff'), 'CARD_OFFICER');
    const a = await request(c, { kind: 'VIRTUAL' });
    const rej = await decide(officer.token, a.body.id, { decision: 'REJECT', reason: 'Incomplete profile' });
    expect(rej.body.status).toBe('REJECTED');
    expect((await get(c, a.body.id)).body).toMatchObject({ status: 'REJECTED', decisionReason: 'Incomplete profile' });
    for (let i = 0; i < 3; i++) expect((await request(c, { kind: 'VIRTUAL' })).status).toBe(201);
    expect((await request(c, { kind: 'VIRTUAL' })).status).toBe(409);

    const list = (await ctx.http.get('/api/v1/admin/cards').set(bearer(officer.token))).body.items;
    const target = list.find((i: { customerNumber: string }) => i.customerNumber);
    expect(target).toBeTruthy();
    const blk = await ctx.http.post(`/api/v1/admin/cards/${target.id}/block`).set(bearer(officer.token)).send({ reason: 'Fraud review' });
    expect(blk.body.status).toBe('BLOCKED');
    expect((await ctx.http.post(`/api/v1/admin/cards/${target.id}/block`).set(bearer(officer.token)).send({ reason: 'again' })).status).toBe(409);
  });

  it('isolation and permissions: other customers, customers on staff routes, and staff without cards.review are refused', async () => {
    const a = await makePayer(ctx, nm('iso'), 100_000n);
    const b = await makePayer(ctx, nm('isob'), 100_000n);
    const csr = await makeStaff(ctx, nm('csrc'), 'CUSTOMER_SERVICE');
    const officer = await makeStaff(ctx, nm('cardoff'), 'CARD_OFFICER');
    const r = await request(a, { kind: 'VIRTUAL' });
    await decide(officer.token, r.body.id, { decision: 'APPROVE' });

    expect((await get(b, r.body.id)).status).toBe(404);
    expect((await ctx.http.post(`/api/v1/cards/${r.body.id}/freeze`).set(bearer(b.token)).send({ frozen: true })).status).toBe(404);
    expect((await ctx.http.get(`/api/v1/cards/${r.body.id}/history`).set(bearer(b.token))).status).toBe(404);
    expect(await ctx.prisma.securityEvent.count({ where: { kind: 'FORBIDDEN_RESOURCE_ACCESS', userId: b.id } })).toBeGreaterThanOrEqual(3);
    expect((await ctx.http.get('/api/v1/cards').set(bearer(b.token))).body.items).toHaveLength(0);
    expect((await request(b, { kind: 'VIRTUAL', accountId: a.accountId })).status).toBe(404); // someone else's account

    expect((await decide(a.token, r.body.id, { decision: 'APPROVE' })).status).toBe(403); // customers cannot approve (their own) cards
    expect((await ctx.http.get('/api/v1/admin/cards').set(bearer(csr.token))).status).toBe(403);
    expect((await ctx.http.get('/api/v1/branches').set(bearer(a.token))).body.items.some((x: { code: string }) => x.code === 'TEST-COL')).toBe(true);
  });
});
