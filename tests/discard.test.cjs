const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../discard-model.js');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DEF = uuid(9000);
const price = (n, at = 1000) => ({ ok: true, fetchedAt: at, averages: { C: n } });
const entry = (n, overrides = {}) => ({ id: uuid(n), card_id: DEF, starred: false, is_shiny: false, count: 1,
  card: { id: DEF, rarity: 'C', wikipedia_title: `Card ${n}` }, ...overrides });
const protect = () => model.protection([], []);
const selected = (raw, prices = () => price(0), maximum = 0, protections = protect()) => model.plan(raw.map(model.entry), prices, maximum, protections);

function fixture(number = 125, options = {}) {
  let rows = Array.from({ length: number }, (_, i) => entry(i + 1)), pending = [], selling = [];
  const calls = [], store = new Map([['wm_avg_v3_' + DEF, price(0)]]);
  let stage = 0, service;
  const core = { cacheMemory: new Map(), cardMetaById: new Map(), cacheKey: id => 'wm_avg_v3_' + id,
    readLocalValue: key => store.get(key), writeLocalValue: (key, value) => { store.set(key, structuredClone(value)); return true; }, isCollectionPage: () => true };
  const context = vm.createContext({ window: { __wmAverageFeatures: {} }, navigator: options.navigator || {},
    document: {}, AbortController, setTimeout, clearTimeout, Date, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'discard-model.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'features', 'discard.js'), 'utf8'), context);
  const fetch = async (url, init) => {
    const call = { url, method: init.method || 'GET', body: init.body && JSON.parse(init.body) }; calls.push(call);
    if (url.includes('/api/my-collection')) {
      const page = Number(new URL(url, 'https://www.wiki-masters.com').searchParams.get('page'));
      if (page === 0) stage++;
      const data = { collection: rows.slice(page * 50, (page + 1) * 50), total: rows.length, pendingTradeCardIds: pending };
      const replacement = options.collection?.({ page, stage, data, core });
      return response(200, replacement || data);
    }
    if (url.includes('/api/marketplace?')) return options.market?.() || response(200, { selling });
    assert.equal(url, '/api/user-cards/bulk-discard');
    assert.equal(init.credentials, 'include'); assert.equal(init.headers['Content-Type'], 'application/json');
    const replacement = await options.post?.({ call, core, service, calls });
    return replacement || response(200, { discarded_count: call.body.card_ids.length, failed: [] });
  };
  service = context.window.__wmAverageFeatures.discard.create({ core, priceLoader: options.priceLoader }, { fetch, wait: async () => {} });
  return { service, core, store, calls, posts: () => calls.filter(call => call.method === 'POST'),
    setRows: next => { rows = next; }, setPending: next => { pending = next; }, setSelling: next => { selling = next; } };
}
function response(status, data) { return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => data }; }

test('threshold accepts zero/decimals and refuses blank, negatives, infinity or malformed input', () => {
  assert.equal(model.threshold('0'), 0); assert.equal(model.threshold('1,25'), 1.25);
  for (const value of ['', ' ', '-1', 'Infinity', '1e4', false, null]) assert.throws(() => model.threshold(value));
});

test('never-checked, failed or malformed price results never become zero', () => {
  for (const hit of [undefined, { ...price(0), ok: false }, price(false), price(NaN), price(Infinity), price(-1),
    { ...price(0), averages: null }, { ...price(0), averages: [] }, { ...price(0), fetchedAt: 0 }]) assert.equal(selected([entry(1)], () => hit).selected.length, 0);
  assert.equal(selected([entry(1)], () => price(0)).selected.length, 1);
  assert.equal(selected([entry(1)], () => price(1)).selected.length, 0);
});

test('successful Moy. — counts as zero only for selection, preserving the original cached summary', () => {
  for (const averages of [{}, { R: 42 }, { C: null }]) {
    const hit = { ok: true, fetchedAt: 1000, averages }, before = structuredClone(hit);
    const plan = selected([entry(1)], () => hit);
    assert.equal(plan.selected.length, 1); assert.equal(plan.selected[0].average, 0); assert.equal(plan.selected[0].noAverage, true);
    assert.deepEqual(hit, before);
  }
});

function seedCached(f, copies = [1, 2, 3], additions = {}) {
  f.core.writeLocalValue('wm_all_collection_v1', { complete: true, fetchedAt: 1234,
    cards: [{ id: DEF, title: 'Cached card', rarity: 'C', starred: false, count: copies.length,
      ownedCardIds: copies.map(uuid), ...additions }] });
}

test('cached preview uses every owned copy without any network calls and reverses the price order', () => {
  const f = fixture(3); seedCached(f); f.core.writeLocalValue('wm_avg_v3_' + DEF, { ok: true, fetchedAt: 1000, averages: {} });
  f.core.cardMetaById.set(uuid(9001), { id: uuid(9001), rarity: 'R', title: 'Observed card', ownedCardIds: [uuid(4)], count: 1 });
  f.core.writeLocalValue('wm_avg_v3_' + uuid(9001), { ok: true, fetchedAt: 1000, averages: { R: 2 } });
  const plan = f.service.cachedPlan(2, model.RARITIES);
  assert.deepEqual(Array.from(plan.selected, row => row.average), [0, 0, 0, 2]);
  assert.equal(f.calls.length, 0); assert.equal(plan.complete, true);
});

test('cached copy protections stay per copy, with conservative favorites for older cache formats', () => {
  const f = fixture(3); seedCached(f, [1, 2, 3], { starred: true, ownedCopies: [
    { id: uuid(1), starred: false, shiny: false }, { id: uuid(2), starred: true, shiny: false }, { id: uuid(3), starred: false, shiny: true }
  ] });
  assert.deepEqual(Array.from(f.service.cachedPlan(0).selected, row => row.ownedId), [uuid(1)]);
  seedCached(f, [1, 2, 3], { starred: true });
  assert.equal(f.service.cachedPlan(0).selected.length, 0); assert.equal(f.calls.length, 0);
});

test('pending, in-flight or errored price requests exclude even a retained successful zero price', () => {
  for (const priceLoader of [{ isPending: () => true }, { getStatus: () => 'En attente' }, { getStatus: () => 'Erreur API 500' }]) {
    const f = fixture(1, { priceLoader }); seedCached(f, [1]);
    assert.equal(f.service.cachedPlan(0).selected.length, 0); assert.equal(f.calls.length, 0);
  }
  const f = fixture(1); seedCached(f, [1]);
  f.core.writeLocalValue('wm_atlas_unpriced_cards_v1', { [DEF]: { id: DEF, retryAt: Date.now() + 60000 } });
  assert.equal(f.service.cachedPlan(0).selected.length, 0);
});

test('fresh API errors cannot be hidden by an older successful cache entry', () => {
  const f = fixture(1); seedCached(f, [1]); f.core.cacheMemory.set(DEF, price(0, 1000));
  f.core.writeLocalValue('wm_avg_v3_' + DEF, { ok: false, fetchedAt: 2000, averages: {}, error: 'API error' });
  assert.equal(f.service.cachedPlan(0).selected.length, 0);
});

test('loading ownership once saves reusable metadata and copy protections, without loading prices', async () => {
  const f = fixture(125); await f.service.analyse(0); const requests = f.calls.length;
  const cached = f.service.cachedPlan(0);
  assert.equal(cached.selected.length, 125); assert.equal(cached.complete, true); assert.equal(f.calls.length, requests);
  assert.equal(f.store.get('wm_all_collection_v1').cards[0].ownedCopies.length, 125);
  assert.ok(f.calls.every(call => !call.url.includes('/sales')));
});

test('an older cache with unknown shiny status cannot discard a copy that the fresh API protects', async () => {
  const f = fixture(1); seedCached(f, [1]); f.setRows([entry(1, { is_shiny: true })]);
  const preview = f.service.cachedPlan(0), report = await f.service.execute(preview.selected, 0);
  assert.equal(report.status, 'error'); assert.equal(f.posts().length, 0);
  assert.equal(f.service.cachedPlan(0).selected.length, 0, 'Fresh protected metadata replaces the older preview cache.');
});

test('favorites, shiny copies, pending trades and active sales are protected', () => {
  const raw = [entry(1, { starred: true }), entry(2, { is_shiny: true }), entry(3), entry(4, { card_id: uuid(9001), card: { id: uuid(9001), rarity: 'C' } })];
  const plan = selected(raw, () => price(0), 0, model.protection([DEF], [{ card_id: uuid(9001) }]));
  assert.equal(plan.selected.length, 0);
  assert.deepEqual(plan.excluded, { favorite: 1, shiny: 1, trade: 1, sale: 1, unknown: 0, above: 0, rarity: 0 });
});

test('rarity filter keeps R/SR/UR/L even with cheap or successful no-average prices, defaulting to C/PC', () => {
  const raw = ['C', 'PC', 'R', 'SR', 'UR', 'L'].map((rarity, i) => entry(i + 1, { card: { id: DEF, rarity } }));
  for (const averages of [{}, { C: 1, PC: 1, R: 1, SR: 1, UR: 1, L: 1 }]) {
    const hit = { ok: true, fetchedAt: 1000, averages };
    const plan = model.plan(raw.map(model.entry), () => hit, 5, protect());
    assert.deepEqual(plan.selected.map(row => row.rarity), ['C', 'PC']); assert.equal(plan.excluded.rarity, 4);
    assert.equal(model.plan(raw.map(model.entry), () => hit, 5, protect(), []).selected.length, 0);
    assert.deepEqual(model.plan(raw.map(model.entry), () => hit, 5, protect(), ['R']).selected.map(row => row.rarity), ['R']);
    assert.throws(() => model.plan(raw.map(model.entry), () => hit, 5, protect(), ['INVALID']));
  }
});

test('rarity filter is enforced before POST and again after the fresh ownership check', async () => {
  const f = fixture(1); seedCached(f, [1]);
  f.core.writeLocalValue('wm_all_collection_v1', { complete: true, cards: [{ id: DEF, rarity: 'R', title: 'Rare card', ownedCardIds: [uuid(1)], count: 1 }] });
  const optIn = f.service.cachedPlan(5, ['R']);
  await assert.rejects(f.service.execute(optIn.selected, 5)); assert.equal(f.calls.length, 0);
  seedCached(f, [1]);
  const common = f.service.cachedPlan(5);
  f.setRows([entry(1, { card: { id: DEF, rarity: 'R' } })]);
  const report = await f.service.execute(common.selected, 5);
  assert.equal(report.status, 'error'); assert.equal(f.posts().length, 0);
});

test('copy IDs remain separate, duplicate definitions retain every eligible owned copy, and sorting is ascending', () => {
  const second = uuid(9001);
  const raw = [entry(1), entry(2), entry(3, { card_id: second, card: { id: second, rarity: 'C', wikipedia_title: 'A' } })];
  const plan = selected(raw, id => price(id === DEF ? 2 : 1), 2);
  assert.deepEqual(plan.selected.map(row => row.ownedId), [uuid(3), uuid(1), uuid(2)]);
  assert.equal(plan.selected[1].cardId, DEF);
  assert.throws(() => model.entry({ ...entry(1), card: { id: uuid(9002), rarity: 'C' } }));
  assert.throws(() => model.entry({ ...entry(1), count: 2 }));
  assert.throws(() => model.entry({ ...entry(1), starred: undefined }));
});

test('analysis reads the complete collection beyond fifty, without any discard POST', async () => {
  const f = fixture(125), plan = await f.service.analyse(0);
  assert.equal(plan.selected.length, 125); assert.equal(plan.total, 125);
  assert.equal(f.calls.filter(call => call.url.includes('/api/my-collection')).length, 3);
  assert.equal(f.posts().length, 0);
});

test('confirmed copies from multiple pages discard in fifty-copy batches with only owned IDs', async () => {
  const f = fixture(125), preview = await f.service.analyse(0);
  const report = await f.service.execute(preview.selected, 0);
  assert.equal(report.status, 'done'); assert.equal(report.discarded, 125);
  assert.deepEqual(f.posts().map(call => call.body.card_ids.length), [50, 50, 25]);
  assert.equal(new Set(f.posts().flatMap(call => call.body.card_ids)).size, 125);
  assert.equal(f.posts().some(call => call.body.card_ids.includes(DEF)), false);
  assert.equal(f.calls.filter(call => call.url.includes('/api/my-collection')).length, 6, 'Revalidate before the first deletion.');
});

test('missing pages, duplicate rows and changed totals refuse partial analysis', async () => {
  for (const alter of [data => ({ ...data, collection: [] }), data => ({ ...data, collection: data.collection.map(() => entry(1)) }), data => ({ ...data, total: data.total + 1 })]) {
    const f = fixture(125, { collection: ({ page, data }) => page === 1 ? alter(data) : null });
    await assert.rejects(f.service.analyse(0)); assert.equal(f.posts().length, 0);
  }
});

test('protection failure does not silently turn into an empty protected set', async () => {
  for (const market of [() => response(500, {}), () => response(200, {}), () => response(200, { selling: [{ card_id: 'invalid' }] })]) {
    const f = fixture(1, { market }); await assert.rejects(f.service.analyse(0)); assert.equal(f.posts().length, 0);
  }
  const f = fixture(1); f.setPending(undefined); await assert.rejects(f.service.analyse(0));
});

test('execution refuses arbitrary IDs without a completed preview and sends no POST', async () => {
  const f = fixture(1);
  await assert.rejects(f.service.execute(selected([entry(1)]).selected, 0));
  const plan = await f.service.analyse(0);
  await assert.rejects(f.service.execute([{ ...plan.selected[0], ownedId: uuid(2) }], 0));
  assert.equal(f.posts().length, 0);
});

test('new favorites or a higher price after preview force a new confirmation', async () => {
  const first = fixture(1); const preview = await first.service.analyse(0);
  first.setRows([entry(1, { starred: true })]);
  const report = await first.service.execute(preview.selected, 0);
  assert.equal(report.status, 'error'); assert.equal(first.posts().length, 0);
  const second = fixture(1, { collection: ({ stage, core }) => { if (stage === 2) core.writeLocalValue('wm_avg_v3_' + DEF, price(1, 2000)); } });
  const old = await second.service.analyse(0), changed = await second.service.execute(old.selected, 0);
  assert.equal(changed.status, 'error'); assert.equal(second.posts().length, 0);
});

test('newly pulled low-price copies cannot be added to an already confirmed selection', async () => {
  const f = fixture(1); const preview = await f.service.analyse(0);
  f.setRows([entry(1), entry(2)]);
  const report = await f.service.execute(preview.selected, 0);
  assert.equal(report.discarded, 1); assert.deepEqual(f.posts()[0].body.card_ids, [uuid(1)]);
});

test('partial successes stop later batches and report only the server-confirmed count', async () => {
  const f = fixture(125, { post: () => response(200, { discarded_count: 49, failed: [{ id: uuid(1), error: 'protected' }] }) });
  const preview = await f.service.analyse(0), report = await f.service.execute(preview.selected, 0);
  assert.equal(report.status, 'error'); assert.equal(report.discarded, 49); assert.equal(f.posts().length, 1);
  assert.equal(report.batches[0].status, 'partial');
});

test('HTTP blocks, rate limits and server errors stop immediately without retrying POST', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(125, { post: () => response(status, { error: 'blocked' }) });
    const preview = await f.service.analyse(0), report = await f.service.execute(preview.selected, 0);
    assert.equal(report.status, 'error'); assert.equal(f.posts().length, 1); assert.match(report.error, /aucun nouvel essai automatique/);
    if (status !== 500) assert.ok(f.store.get('wm_atlas_price_pause_v1').until > Date.now());
  }
});

test('network loss or invalid mutation response stays unconfirmed and never continues', async () => {
  for (const post of [() => { throw Error('Network lost'); }, () => response(200, {}), () => response(200, { discarded_count: 51 }), () => ({ ok: true, status: 200, json: async () => { throw Error('bad json'); } })]) {
    const f = fixture(125, { post }), preview = await f.service.analyse(0), report = await f.service.execute(preview.selected, 0);
    assert.equal(f.posts().length, 1); assert.equal(report.discarded, 0); assert.equal(report.batches[0].status, 'unconfirmed');
    assert.equal(f.service.getReport().status, 'error');
  }
});

test('Stop waits for the in-flight result and prevents the next batch', async () => {
  const f = fixture(125, { post: ({ service }) => { service.stop(); return response(200, { discarded_count: 50, failed: [] }); } });
  const preview = await f.service.analyse(0), report = await f.service.execute(preview.selected, 0);
  assert.equal(report.status, 'stopped'); assert.equal(report.discarded, 50); assert.equal(f.posts().length, 1);
});

test('a synchronized higher price after the first batch stops remaining confirmed copies', async () => {
  const f = fixture(125, { post: ({ core, call }) => { core.writeLocalValue('wm_avg_v3_' + DEF, price(5, 2000)); return response(200, { discarded_count: call.body.card_ids.length, failed: [] }); } });
  const preview = await f.service.analyse(0), report = await f.service.execute(preview.selected, 0);
  assert.equal(report.discarded, 50); assert.equal(report.status, 'error'); assert.equal(f.posts().length, 1);
});

test('existing server cooldown blocks scanning and a second tab cannot execute under the same lock', async () => {
  const f = fixture(1); f.core.writeLocalValue('wm_atlas_price_pause_v1', { until: Date.now() + 60000 });
  await assert.rejects(f.service.analyse(0)); assert.equal(f.calls.length, 0);
  const locked = fixture(1, { navigator: { locks: { request: async (_name, _options, callback) => callback(null) } } });
  const preview = await locked.service.analyse(0); await assert.rejects(locked.service.execute(preview.selected, 0));
  assert.equal(locked.posts().length, 0);
});

test('the newest successful cache wins, current data survives, and stored reports never autorun', async () => {
  const f = fixture(1); f.core.cacheMemory.set(DEF, price(1, 500));
  const preview = await f.service.analyse(0); assert.equal(preview.selected.length, 1);
  const before = structuredClone(f.store.get('wm_avg_v3_' + DEF));
  await f.service.execute(preview.selected, 0);
  assert.deepEqual(f.store.get('wm_avg_v3_' + DEF), before);
  const fresh = fixture(1); fresh.core.writeLocalValue('wm_discard_report_v1', { status: 'pending', ids: [uuid(1)] });
  assert.equal(fresh.calls.length, 0);
});

test('confirmed removals update ownership metadata without clearing historical prices or protected copies', async () => {
  const f = fixture(3); f.setRows([entry(1), entry(2), entry(3, { starred: true })]);
  const preview = await f.service.analyse(0); await f.service.execute(preview.selected, 0);
  const owned = f.store.get('wm_all_collection_v1');
  assert.equal(owned.complete, true); assert.equal(owned.cards.length, 1);
  assert.deepEqual(owned.cards[0].ownedCardIds, [uuid(3)]); assert.equal(owned.cards[0].starred, true);
  assert.equal(f.store.get('wm_avg_v3_' + DEF).averages.C, 0);
});

test('ambiguous removals invalidate ownership claims rather than offering uncertain copies for sale', async () => {
  const f = fixture(1, { post: () => { throw Error('lost response'); } });
  const preview = await f.service.analyse(0); await f.service.execute(preview.selected, 0);
  const owned = f.store.get('wm_all_collection_v1'); assert.equal(owned.complete, false); assert.equal(owned.cards.length, 0);
  assert.equal(f.store.get('wm_avg_v3_' + DEF).averages.C, 0);
});

test('discardPulled discards only unprotected copies of the picked cards and reports the shortfall', async () => {
  const f = fixture(0);
  const other = uuid(9001);
  f.setRows([
    entry(1), entry(2, { starred: true }), entry(3, { is_shiny: true }), entry(4), entry(5),
    entry(6, { card_id: other, card: { id: other, rarity: 'C', wikipedia_title: 'Other' } })
  ]);
  f.setSelling([{ card_id: other }]);
  // 4 copies of DEF wanted but only 3 are unprotected (1, 4, 5); the single `other` copy is on sale.
  const report = await f.service.discardPulled([DEF, DEF, DEF, DEF, other].map(cardId => ({ cardId })));
  assert.equal(report.status, 'done');
  assert.equal(report.discarded, 3);
  assert.deepEqual({ ...report.missing }, { [DEF]: 1, [other]: 1 });
  assert.deepEqual(f.posts().map(call => call.body.card_ids).flat().sort(), [uuid(1), uuid(4), uuid(5)].sort());
});

test('discardPulled refuses an empty or malformed selection before any request', async () => {
  const f = fixture(1);
  await assert.rejects(f.service.discardPulled([]));
  await assert.rejects(f.service.discardPulled([{ cardId: 'nope' }]));
  assert.equal(f.calls.length, 0);
});
