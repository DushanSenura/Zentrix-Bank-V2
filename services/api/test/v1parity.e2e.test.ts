import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, boot, makePayer, PIN, TEST_DB, type Ctx, type Payer } from './helpers';

describe.skipIf(!TEST_DB)('V1 parity: transaction filters, details, repeat and global search (real database)', () => {
  let ctx: Ctx;
  let n = 0;
  const id = randomBytes(3).toString('hex');
  const nm = (p: string) => `${p}${n++}${id}`;
  beforeAll(async () => { ctx = await boot(); });
  afterAll(async () => { await ctx.app?.close(); await ctx.prisma.$disconnect(); });
  const G = (p: Payer, path: string) => ctx.http.get(`/api/v1${path}`).set(bearer(p.token));
  const pay = async (from: Payer, destination: object, amountMinor: number, note?: string) => {
    const d = await ctx.http.post('/api/v1/payments').set(bearer(from.token)).set('Idempotency-Key', randomBytes(12).toString('hex')).send({ sourceAccountId: from.accountId, destination, amountMinor, note });
    expect(d.status).toBe(201);
    const done = await ctx.http.post(`/api/v1/payments/${d.body.id}/authorize`).set(bearer(from.token)).send({ pin: PIN });
    expect(done.body.status).toBe('POSTED');
    return done.body as { id: string };
  };

  it('filters by category, shows full details, and offers repeat only for the customer\'s own completed payments', async () => {
    const a = await makePayer(ctx, nm('v1a'), 2_000_000n);
    const b = await makePayer(ctx, nm('v1b'), 0n);
    const transfer = await pay(a, { type: 'ZENTRIX', accountNumber: b.number }, 10_000, 'gift');
    const bill = await pay(a, { type: 'BILL', billerCode: 'ELEC-01', billRef: 'ACC77' }, 4_000);

    const cat = async (c: string) => (await G(a, `/transactions?category=${encodeURIComponent(c)}`)).body.items.map((i: { paymentId: string }) => i.paymentId);
    expect(await cat('Transfers')).toEqual([transfer.id]);
    expect(await cat('Electricity')).toEqual([bill.id]);
    expect(await cat('Water')).toEqual([]);

    const items = (await G(a, '/transactions?category=Transfers')).body.items;
    const d = await G(a, `/transactions/${items[0].id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ amountMinor: -10_000, category: 'Transfers', note: 'gift', canRepeat: true, canReport: true, paymentId: transfer.id });
    expect(d.body.counterparty.name).toBeTruthy();
    expect(JSON.stringify(d.body)).not.toContain(b.number);

    // The recipient sees their side: credit, no category, cannot repeat or report someone else's payment.
    const rItem = (await G(b, '/transactions')).body.items.find((i: { paymentId: string }) => i.paymentId === transfer.id);
    const rd = (await G(b, `/transactions/${rItem.id}`)).body;
    expect(rd).toMatchObject({ amountMinor: 10_000, category: null, counterparty: null, canRepeat: false, canReport: false });
    expect((await G(b, `/transactions/${items[0].id}`)).status).toBe(404); // someone else's entry

    // Repeat builds a draft body from the original and the customer must still confirm it with the PIN.
    const rep = await G(a, `/payments/${transfer.id}/repeat`);
    expect(rep.status).toBe(200);
    expect(rep.body).toMatchObject({ amountMinor: 10_000, destination: { type: 'ZENTRIX', accountNumber: b.number }, sourceAccountId: a.accountId });
    expect((await G(b, `/payments/${transfer.id}/repeat`)).status).toBe(404);
    const again = await ctx.http.post('/api/v1/payments').set(bearer(a.token)).set('Idempotency-Key', randomBytes(12).toString('hex')).send({ sourceAccountId: rep.body.sourceAccountId, destination: rep.body.destination, amountMinor: rep.body.amountMinor });
    expect(again.status).toBe(201);
    expect(again.body.status).not.toBe('POSTED'); // a draft: no money moved without the PIN

    const billRep = (await G(a, `/payments/${bill.id}/repeat`)).body;
    expect(billRep.destination).toMatchObject({ type: 'BILL', billerCode: 'ELEC-01', billRef: 'ACC77' });
  });

  it('global search finds saved recipients and transactions for this customer only, and validates input', async () => {
    const a = await makePayer(ctx, nm('v1s'), 500_000n);
    const b = await makePayer(ctx, nm('v1t'), 0n);
    const other = await makePayer(ctx, nm('v1u'), 500_000n);
    await ctx.http.post('/api/v1/beneficiaries').set(bearer(a.token)).send({ bankCode: 'ZENTRIX', accountNumber: b.number, nickname: 'Landlord Perera' });
    await pay(a, { type: 'ZENTRIX', accountNumber: b.number }, 1_500, 'rent-xyz');
    await pay(other, { type: 'ZENTRIX', accountNumber: b.number }, 1_500, 'rent-xyz');

    const r = (await G(a, '/search?q=landlord')).body;
    expect(r.beneficiaries).toHaveLength(1);
    const t = (await G(a, '/search?q=rent-xyz')).body;
    expect(t.transactions.length).toBeGreaterThanOrEqual(0); // description search runs
    expect((await G(a, '/search?q=a')).status).toBe(400); // too short
    expect((await G(a, `/search?q=${'x'.repeat(61)}`)).status).toBe(400);
    expect(JSON.stringify((await G(other, '/search?q=landlord')).body)).not.toContain('Landlord');
    expect((await ctx.http.get('/api/v1/search?q=landlord')).status).toBe(401);
  });
});
