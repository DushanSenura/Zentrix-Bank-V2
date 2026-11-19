import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOutboxBatch } from '../../worker/src/outbox';
import { bearer, boot, makePayer, makeStaff, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

describe.skipIf(!TEST_DB)('support, documents and payment extras (real database)', () => {
  let ctx: Ctx;
  let n = 0;
  const runId = randomBytes(3).toString('hex');
  const nm = (p: string) => `${p}${n++}${runId}`;

  beforeAll(async () => { ctx = await boot(); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });

  const pay = async (from: Payer, to: Payer, amountMinor: number, note?: string) => {
    const d = await ctx.http.post('/api/v1/payments').set(bearer(from.token)).set('Idempotency-Key', randomBytes(8).toString('hex'))
      .send({ sourceAccountId: from.accountId, destination: { type: 'ZENTRIX', accountNumber: to.number }, amountMinor, note });
    expect(d.status).toBe(201);
    const done = await ctx.http.post(`/api/v1/payments/${d.body.id}/authorize`).set(bearer(from.token)).send({ pin: PIN });
    expect(done.body.status).toBe('POSTED');
    return done.body as { id: string; reference: string };
  };

  it('Scenario F: customer reports a problem -> staff reviews and decides -> customer is told; isolation and rules hold', async () => {
    const a = await makePayer(ctx, nm('dispa'), 200_000n);
    const b = await makePayer(ctx, nm('dispb'), 0n);
    const other = await makePayer(ctx, nm('dispo'), 0n);
    const agent = await makeStaff(ctx, nm('agent'), 'CUSTOMER_SERVICE');
    const p = await pay(a, b, 5_000, 'rent');

    const body = { paymentId: p.id, reasonCode: 'UNAUTHORISED', description: 'I do not recognise this payment' };
    expect((await ctx.http.post('/api/v1/disputes').set(bearer(other.token)).send(body)).status).toBe(404); // not their payment
    expect((await ctx.http.post('/api/v1/disputes').set(bearer(b.token)).send(body)).status).toBe(404); // the recipient cannot dispute either
    expect((await ctx.http.post('/api/v1/disputes').set(bearer(a.token)).send({ ...body, description: 'short' })).status).toBe(400);
    expect((await ctx.http.post('/api/v1/disputes').set(bearer(a.token)).send({ ...body, status: 'ACCEPTED' })).status).toBe(400); // strict body

    const d = await ctx.http.post('/api/v1/disputes').set(bearer(a.token)).send(body);
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ status: 'OPEN', resolution: null });
    expect((await ctx.http.post('/api/v1/disputes').set(bearer(a.token)).send(body)).status).toBe(409); // one open report per payment
    expect((await ctx.http.get(`/api/v1/disputes/${d.body.id}`).set(bearer(other.token))).status).toBe(404);

    // reporting never moves money
    expect((await ctx.prisma.ledgerAccount.findUniqueOrThrow({ where: { id: a.ledgerId } })).balanceMinor).toBe(195_000n);

    expect((await ctx.http.get('/api/v1/admin/disputes').set(bearer(a.token))).status).toBe(403);
    const queue = await ctx.http.get('/api/v1/admin/disputes').set(bearer(agent.token));
    expect(queue.body.items.some((i: { id: string }) => i.id === d.body.id)).toBe(true);
    expect((await ctx.http.post(`/api/v1/admin/disputes/${d.body.id}/review`).set(bearer(agent.token))).status).toBe(201);
    // customer service cannot request reversals
    expect((await ctx.http.post(`/api/v1/admin/disputes/${d.body.id}/decision`).set(bearer(agent.token)).send({ decision: 'ACCEPT', resolution: 'Refund agreed', requestReversal: true })).status).toBe(422);
    const dec = await ctx.http.post(`/api/v1/admin/disputes/${d.body.id}/decision`).set(bearer(agent.token)).send({ decision: 'REJECT', resolution: 'The payment was authorised with your PIN' });
    expect(dec.status).toBe(201);
    expect(dec.body.status).toBe('REJECTED');
    expect((await ctx.http.post(`/api/v1/admin/disputes/${d.body.id}/decision`).set(bearer(agent.token)).send({ decision: 'ACCEPT', resolution: 'Changed my mind' })).status).toBe(409);

    await relayOutboxBatch(ctx.prisma as never, 500);
    const notes = (await ctx.http.get('/api/v1/notifications').set(bearer(a.token))).body.items;
    expect(notes.some((x: { title: string }) => x.title === 'Problem report reviewed')).toBe(true);
    const mine = (await ctx.http.get(`/api/v1/disputes/${d.body.id}`).set(bearer(a.token))).body;
    expect(mine).toMatchObject({ status: 'REJECTED', resolution: 'The payment was authorised with your PIN' });
    expect(await ctx.prisma.auditLog.count({ where: { subjectId: d.body.id, actorId: agent.id } })).toBeGreaterThanOrEqual(2);
  });

  it('only a completed, non-own-transfer payment can be reported', async () => {
    const a = await makePayer(ctx, nm('dd'), 50_000n);
    const b = await makePayer(ctx, nm('de'), 0n);
    const draft = await ctx.http.post('/api/v1/payments').set(bearer(a.token)).set('Idempotency-Key', randomBytes(8).toString('hex')).send({ sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: b.number }, amountMinor: 100 });
    expect((await ctx.http.post('/api/v1/disputes').set(bearer(a.token)).send({ paymentId: draft.body.id, reasonCode: 'UNAUTHORISED', description: 'This was never completed' })).status).toBe(409);
  });

  it('tickets: customer and staff conversation, internal notes stay hidden, attachments validated and isolated', async () => {
    const a = await makePayer(ctx, nm('tk'), 0n);
    const other = await makePayer(ctx, nm('tko'), 0n);
    const agent = await makeStaff(ctx, nm('tkagent'), 'CUSTOMER_SERVICE');
    const t = await ctx.http.post('/api/v1/support/tickets').set(bearer(a.token)).send({ subject: 'Help with my card', category: 'CARD', message: 'My card is not showing' });
    expect(t.status).toBe(201);
    expect((await ctx.http.post('/api/v1/support/tickets').set(bearer(a.token)).send({ subject: 'x', category: 'NOPE', message: 'hello there' })).status).toBe(400);
    expect((await ctx.http.get(`/api/v1/support/tickets/${t.body.id}`).set(bearer(other.token))).status).toBe(404);

    const A = (path: string) => `/api/v1/admin/tickets/${path}`;
    expect((await ctx.http.get('/api/v1/admin/tickets').set(bearer(a.token))).status).toBe(403);
    expect((await ctx.http.post(A(`${t.body.id}/messages`)).set(bearer(agent.token)).send({ body: 'Internal: verify identity first', internal: true })).status).toBe(201);
    expect((await ctx.http.post(A(`${t.body.id}/messages`)).set(bearer(agent.token)).send({ body: 'We are looking into it' })).status).toBe(201);

    const seen = (await ctx.http.get(`/api/v1/support/tickets/${t.body.id}`).set(bearer(a.token))).body;
    expect(JSON.stringify(seen)).not.toContain('Internal: verify');
    expect(seen.messages.map((m: { from: string }) => m.from)).toEqual(['CUSTOMER', 'STAFF']);
    expect(seen.status).toBe('PENDING_CUSTOMER');
    const staffView = (await ctx.http.get(A(t.body.id)).set(bearer(agent.token))).body;
    expect(staffView.messages.some((m: { internal: boolean }) => m.internal)).toBe(true);

    // attachments: judged by content, not name
    const up = (token: string, buf: Buffer, name: string) => ctx.http.post(`/api/v1/support/tickets/${t.body.id}/attachments`).set(bearer(token)).attach('file', buf, name);
    expect((await up(a.token, Buffer.from('MZ\x90\x00 not an image'), 'photo.png')).status).toBe(422); // exe disguised as png
    expect((await up(a.token, Buffer.from('<script>alert(1)</script>'), 'x.pdf')).status).toBe(422);
    expect((await up(a.token, Buffer.alloc(5 * 1024 * 1024 + 10, 1), 'big.png')).status).toBe(413);
    const ok = await up(a.token, PNG, '../../etc/passwd.png');
    expect(ok.status).toBe(201);
    expect(ok.body.fileName).not.toMatch(/[\\/]/);
    expect(ok.body.contentType).toBe('image/png');
    expect((await up(other.token, PNG, 'p.png')).status).toBe(404); // someone else's ticket

    const dl = await ctx.http.get(`/api/v1/support/tickets/${t.body.id}/attachments/${ok.body.id}`).set(bearer(a.token));
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['cache-control']).toBe('no-store');
    expect((await ctx.http.get(`/api/v1/support/tickets/${t.body.id}/attachments/${ok.body.id}`).set(bearer(other.token))).status).toBe(404);
    expect((await ctx.http.get(A(`${t.body.id}/attachments/${ok.body.id}`)).set(bearer(agent.token))).status).toBe(200);

    expect((await ctx.http.put(A(`${t.body.id}/status`)).set(bearer(agent.token)).send({ status: 'CLOSED' })).status).toBe(200);
    expect((await ctx.http.post(`/api/v1/support/tickets/${t.body.id}/messages`).set(bearer(a.token)).send({ body: 'one more thing' })).status).toBe(409);
    expect((await up(a.token, PNG, 'late.png')).status).toBe(409);
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(a.token))).body.items.some((x: { title: string }) => x.title === 'Reply to your request')).toBe(true);
  });

  it('branches and appointments', async () => {
    const a = await makePayer(ctx, nm('ap'), 0n);
    const mgr = await makeStaff(ctx, nm('mgr'), 'BRANCH_MANAGER');
    const code = `T${randomBytes(3).toString('hex').toUpperCase()}`;
    expect((await ctx.http.post('/api/v1/admin/branches').set(bearer(a.token)).send({})).status).toBe(403);
    const br = await ctx.http.post('/api/v1/admin/branches').set(bearer(mgr.token)).send({ code, name: 'Kandy Main', city: 'Kandy', address: '5 Temple St', type: 'BRANCH', latitude: 7.29, longitude: 80.63 });
    expect(br.status).toBe(201);
    expect((await ctx.http.post('/api/v1/admin/branches').set(bearer(mgr.token)).send({ code, name: 'Dup', city: 'Kandy', address: 'x st', type: 'BRANCH' })).status).toBe(409);

    const near = await ctx.http.get('/api/v1/branches?lat=7.3&lng=80.6').set(bearer(a.token));
    expect(near.body.items[0].distanceKm).not.toBeNull();
    expect(near.body.items.find((i: { code: string }) => i.code === code)).toBeTruthy();

    const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const ap = (b: object) => ctx.http.post('/api/v1/appointments').set(bearer(a.token)).send(b);
    expect((await ap({ branchId: br.body.id, purpose: 'Open an account', preferredAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    const ok = await ap({ branchId: br.body.id, purpose: 'Open an account', preferredAt: when });
    expect(ok.status).toBe(201);
    expect((await ctx.http.post(`/api/v1/admin/appointments/${ok.body.id}/decision`).set(bearer(mgr.token)).send({ decision: 'CONFIRM' })).status).toBe(400); // time required
    const conf = await ctx.http.post(`/api/v1/admin/appointments/${ok.body.id}/decision`).set(bearer(mgr.token)).send({ decision: 'CONFIRM', confirmedFor: when });
    expect(conf.body.status).toBe('CONFIRMED');
    expect((await ctx.http.post(`/api/v1/appointments/${ok.body.id}/cancel`).set(bearer(a.token))).status).toBe(204);
    expect((await ctx.http.post(`/api/v1/appointments/${ok.body.id}/cancel`).set(bearer(a.token))).status).toBe(404); // already finished

    expect((await ctx.http.delete(`/api/v1/admin/branches/${br.body.id}`).set(bearer(mgr.token))).status).toBe(204);
    expect((await ctx.http.get('/api/v1/branches').set(bearer(a.token))).body.items.some((i: { code: string }) => i.code === code)).toBe(false);
  });

  it('transaction search filters, paginates and never shows another customer', async () => {
    const a = await makePayer(ctx, nm('sa'), 500_000n);
    const b = await makePayer(ctx, nm('sb'), 0n);
    await pay(a, b, 1_000, 'coffee-zz');
    await pay(a, b, 2_500, 'books');
    await pay(a, b, 9_000, 'laptop');
    const get = (token: string, qs: string) => ctx.http.get(`/api/v1/transactions?${qs}`).set(bearer(token));

    const all = await get(a.token, '');
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(4);
    expect(all.body.items.every((i: { paymentId?: string }) => 'paymentId' in i)).toBe(true);
    expect((await get(a.token, 'direction=OUT&minMinor=2000&maxMinor=3000')).body.items.map((i: { amountMinor: number }) => i.amountMinor)).toEqual([-2500]);
    expect((await get(b.token, 'direction=IN')).body.items).toHaveLength(3);
    expect((await get(a.token, 'q=qqqq-no-such-text')).body.items).toHaveLength(0);
    expect((await get(a.token, `q=${all.body.items[0].reference}`)).body.items.some((i: { reference: string }) => i.reference === all.body.items[0].reference)).toBe(true); // search by reference
    expect((await get(a.token, `accountId=${b.accountId}`)).status).toBe(404); // another customer's account
    expect((await get(a.token, 'minMinor=-5')).status).toBe(400);
    expect((await get(a.token, 'from=2026-13-45')).status).toBe(400);

    const p1 = await get(a.token, 'limit=2');
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await get(a.token, `limit=2&cursor=${p1.body.nextCursor}`);
    const ids = new Set([...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id));
    expect(ids.size).toBe(p1.body.items.length + p2.body.items.length); // no overlap between pages
    expect((await get(a.token, 'cursor=garbage')).status).toBe(400);
    // data from b is not in a's feed
    expect(JSON.stringify(all.body)).not.toContain(b.accountId);
  });

  it('documents: statement PDF/CSV with correct balances, receipts, certificates, in three languages; ownership enforced', async () => {
    const a = await makePayer(ctx, nm('ds'), 100_000n);
    const b = await makePayer(ctx, nm('dt'), 0n);
    const p = await pay(a, b, 2_500, '=cmd|calc');
    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const st = (token: string, id: string, qs: string) => ctx.http.get(`/api/v1/accounts/${id}/statement?${qs}`).set(bearer(token)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

    const pdf = await st(a.token, a.accountId, `from=${today}&to=${today}&format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['cache-control']).toBe('no-store');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const csv = await st(a.token, a.accountId, `from=${today}&to=${today}&format=csv`);
    const text = (csv.body as Buffer).toString('utf8');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(text).toContain('Opening balance');
    expect(text).toContain('975.00'); // 100,000.00 - 25.00 (amounts are minor units: 100_000 = LKR 1,000.00)
    expect(text).not.toMatch(/(^|,)=cmd/m); // formula-injection neutralised
    for (const lang of ['si', 'ta']) expect((await st(a.token, a.accountId, `format=pdf&lang=${lang}`)).status).toBe(200);
    expect((await st(a.token, a.accountId, 'lang=fr')).status).toBe(400);
    expect((await st(a.token, a.accountId, 'from=2020-01-01&to=2026-01-01')).status).toBe(400); // more than a year
    expect((await st(a.token, a.accountId, `from=${today}&to=2020-01-01`)).status).toBe(400);
    expect((await st(b.token, a.accountId, '')).status).toBe(404); // not their account

    const rc = await ctx.http.get(`/api/v1/payments/${p.id}/receipt`).set(bearer(a.token)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(rc.status).toBe(200);
    expect((rc.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await ctx.http.get(`/api/v1/payments/${p.id}/receipt`).set(bearer(b.token))).status).toBe(404);

    const cert = await ctx.http.get(`/api/v1/accounts/${a.accountId}/certificate`).set(bearer(a.token));
    expect(cert.status).toBe(200);
    expect((await ctx.http.get(`/api/v1/accounts/${a.accountId}/certificate`).set(bearer(b.token))).status).toBe(404);
    expect(await ctx.prisma.auditLog.count({ where: { actorId: a.id, action: { startsWith: 'document.' } } })).toBeGreaterThanOrEqual(4);
  });

  it('payment requests: request -> payer pays (PIN step-up) -> marked paid; decline/cancel/isolation', async () => {
    const asker = await makePayer(ctx, nm('rq'), 0n);
    const payer = await makePayer(ctx, nm('rp'), 80_000n);
    const stranger = await makePayer(ctx, nm('rs'), 80_000n);
    const make = (body: object) => ctx.http.post('/api/v1/payment-requests').set(bearer(asker.token)).send({ receiveAccountId: asker.accountId, payerAccountNumber: payer.number, amountMinor: 3_000, note: 'dinner', ...body });

    expect((await make({ payerAccountNumber: asker.number })).status).toBe(400); // yourself
    expect((await make({ receiveAccountId: payer.accountId })).status).toBe(404); // not your receiving account
    expect((await make({ amountMinor: 0 })).status).toBe(400);
    const r = await make({});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ direction: 'OUTGOING', status: 'PENDING', amountMinor: 3_000 });

    const incoming = (await ctx.http.get('/api/v1/payment-requests').set(bearer(payer.token))).body.items.find((i: { id: string }) => i.id === r.body.id);
    expect(incoming).toMatchObject({ direction: 'INCOMING', status: 'PENDING' });
    expect((await ctx.http.post(`/api/v1/payment-requests/${r.body.id}/pay`).set(bearer(stranger.token)).set('Idempotency-Key', 'k1').send({ sourceAccountId: stranger.accountId })).status).toBe(404);
    expect((await ctx.http.post(`/api/v1/payment-requests/${r.body.id}/pay`).set(bearer(payer.token)).send({ sourceAccountId: payer.accountId })).status).toBe(400); // key required
    const draft = await ctx.http.post(`/api/v1/payment-requests/${r.body.id}/pay`).set(bearer(payer.token)).set('Idempotency-Key', randomBytes(8).toString('hex')).send({ sourceAccountId: payer.accountId });
    expect(draft.status).toBe(201);
    expect(draft.body.payment.amountMinor).toBe(3_000); // the amount comes from the request, not the client
    expect((await ctx.http.post(`/api/v1/payments/${draft.body.payment.id}/authorize`).set(bearer(payer.token)).send({ pin: PIN })).body.status).toBe('POSTED');
    expect((await ctx.http.get('/api/v1/payment-requests').set(bearer(asker.token))).body.items.find((i: { id: string }) => i.id === r.body.id).status).toBe('PAID');
    expect((await ctx.http.post(`/api/v1/payment-requests/${r.body.id}/decline`).set(bearer(payer.token))).status).toBe(409);

    const r2 = await make({ amountMinor: 500 });
    expect((await ctx.http.post(`/api/v1/payment-requests/${r2.body.id}/decline`).set(bearer(asker.token))).status).toBe(404); // only the payer can decline
    expect((await ctx.http.post(`/api/v1/payment-requests/${r2.body.id}/decline`).set(bearer(payer.token))).status).toBe(204);
    const r3 = await make({ amountMinor: 700 });
    expect((await ctx.http.post(`/api/v1/payment-requests/${r3.body.id}/cancel`).set(bearer(asker.token))).status).toBe(204);

    await ctx.prisma.paymentRequest.update({ where: { id: (await make({ amountMinor: 900 })).body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await ctx.http.get('/api/v1/payment-requests').set(bearer(payer.token))).body.items.some((i: { status: string }) => i.status === 'EXPIRED')).toBe(true);
    await relayOutboxBatch(ctx.prisma as never, 500);
    expect((await ctx.http.get('/api/v1/notifications').set(bearer(payer.token))).body.items.some((x: { title: string }) => x.title === 'Payment request')).toBe(true);
  });

  it('templates: save, list, duplicate name refused, only the owner can delete', async () => {
    const a = await makePayer(ctx, nm('ta'), 0n);
    const b = await makePayer(ctx, nm('tb'), 0n);
    const body = { name: 'Rent', sourceAccountId: a.accountId, destination: { type: 'ZENTRIX', accountNumber: b.number }, amountMinor: 45_000 };
    const t = await ctx.http.post('/api/v1/payment-templates').set(bearer(a.token)).send(body);
    expect(t.status).toBe(201);
    expect(t.body.amountMinor).toBe(45_000);
    expect((await ctx.http.post('/api/v1/payment-templates').set(bearer(a.token)).send(body)).status).toBe(409);
    expect((await ctx.http.post('/api/v1/payment-templates').set(bearer(a.token)).send({ ...body, name: 'Other', sourceAccountId: b.accountId })).status).toBe(404);
    expect((await ctx.http.post('/api/v1/payment-templates').set(bearer(a.token)).send({ name: 'x', destination: { type: 'ZENTRIX', accountNumber: 'abc' } })).status).toBe(400);
    expect((await ctx.http.get('/api/v1/payment-templates').set(bearer(a.token))).body.items).toHaveLength(1);
    expect((await ctx.http.get('/api/v1/payment-templates').set(bearer(b.token))).body.items).toHaveLength(0);
    expect((await ctx.http.delete(`/api/v1/payment-templates/${t.body.id}`).set(bearer(b.token))).status).toBe(404);
    expect((await ctx.http.delete(`/api/v1/payment-templates/${t.body.id}`).set(bearer(a.token))).status).toBe(204);
  });

  it('subscriptions are detected from monthly repeats and need 3 occurrences', async () => {
    const a = await makePayer(ctx, nm('sub'), 900_000n);
    const b = await makePayer(ctx, nm('subb'), 0n);
    expect((await ctx.http.get('/api/v1/subscriptions').set(bearer(a.token))).body.items).toHaveLength(0);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await pay(a, b, 1_990, 'streaming')).id);
    // back-date to three monthly payments
    const now = Date.now();
    for (const [i, id] of ids.entries()) await ctx.prisma.paymentInstruction.update({ where: { id }, data: { postedAt: new Date(now - (2 - i) * 30 * 86_400_000) } });
    const subs = (await ctx.http.get('/api/v1/subscriptions').set(bearer(a.token))).body;
    expect(subs.items).toHaveLength(1);
    expect(subs.items[0]).toMatchObject({ frequency: 'MONTHLY', amountMinor: 1_990, occurrences: 3, annualCostMinor: 1_990 * 12 });
    expect((await ctx.http.get('/api/v1/subscriptions').set(bearer(b.token))).body.items).toHaveLength(0);
  });
});
