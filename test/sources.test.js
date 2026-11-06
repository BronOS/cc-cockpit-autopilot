'use strict'
// The source store (lib/sources.js, adapted from Inbox's): item validation, snapshot buffering, and
// what Autopilot adds, the baseline and the news (design-v2 "Sources").
const test = require('node:test')
const assert = require('node:assert/strict')
const { createSources, MAX_BUFFER } = require('../dist/lib/sources')
const { CAPS, itemOf } = require('../dist/lib/feed')
const { NOW, HOUR, item, bare, fakeFeed, fakeCtx, flush, CHAT, MAIL } = require('./fakes')

/** A ctx with the given providers, and a started store over its `useAll('inbox-feed')`; `news` collects onNews. */
async function setup(providers = {}, opts = {}) {
  const ctx = fakeCtx()
  for (const [id, feed] of Object.entries(providers)) ctx.addProvider(id, feed)
  const warns = []
  const news = []
  const store = createSources(ctx.services.useAll('inbox-feed'), {
    log: { warn: (m) => warns.push(m) },
    onNews: (id, items) => news.push([id, items.map((i) => `${i.id}@${i.rev}`)]),
    callMs: opts.callMs ?? 1000,
  })
  await store.start()
  await flush()
  return { ctx, store, warns, news }
}
const ids = (store, pluginId) => store.get(pluginId).items.map((i) => i.id)
const emit = async (ctx, id, event, data) => {
  ctx.emitFeed(id, event, data)
  await flush()
}

// ---- item validation (copied from Inbox's contract) ----

test('itemOf: required fields, caps, unknown fields dropped, bad items refused', () => {
  const ok = itemOf({ ...item('a'), junk: 1, source: 'bronos.chat', title: `${'t'.repeat(400)}\nline` })
  assert.equal(ok.refused, 0)
  assert.equal(ok.item.title.length, CAPS.title)
  assert.equal(ok.item.junk, undefined, 'unknown fields are left out')
  assert.equal(ok.item.source, undefined, 'a data field never names the source')
  for (const bad of [null, [], 'x', {}, { ...item('a'), id: '' }, { ...item('a'), id: 'x'.repeat(CAPS.id + 1) }, { ...item('a'), id: 'a\nb' }, { ...item('a'), rev: 5 }, { ...item('a'), title: '' }, { ...item('a'), time: 0 }, { ...item('a'), time: 'now' }])
    assert.deepEqual(itemOf(bad), { item: null, refused: 1 }, JSON.stringify(bad))
  const odd = itemOf({ ...item('a'), from: 'Ann', place: { kind: 'planet', name: 'x' }, to: 'everyone', labels: 'no', mentionsMe: 'yes' }).item
  assert.deepEqual([odd.from, odd.place, odd.to, odd.labels, odd.mentionsMe], [undefined, undefined, undefined, [], false])
})

test('a bad item event is skipped and logged, the store keeps working', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  const { ctx, store, warns } = await setup({ 'bronos.chat': chat })
  await emit(ctx, 'bronos.chat', 'item', { id: 'b', title: 'no rev or time' })
  await emit(ctx, 'bronos.chat', 'item', 'junk')
  assert.deepEqual(ids(store, 'bronos.chat'), ['a'])
  assert.equal(store.get('bronos.chat').refused, 2)
  assert.equal(warns.filter((w) => /item was refused/.test(w)).length, 2)
  store.dispose()
})

// ---- baseline and news ----

test('baseline: the first snapshot fills seen and reports nothing; the registry id is the source', async () => {
  const mail = fakeFeed(MAIL, [item('t1'), item('t2', { extra: { source: 'bronos.chat' } })])
  const { store, news } = await setup({ 'bronos.gmail': mail })
  assert.deepEqual(news, [])
  assert.ok(store.get('bronos.gmail').items.every((i) => i.source === 'bronos.gmail'))
  assert.equal(store.get('bronos.gmail').baselined, true)
  store.dispose()
})

test('after the baseline an item event with a new id or a new rev is news; the same rev is not', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  const { ctx, store, news } = await setup({ 'bronos.chat': chat })
  await emit(ctx, 'bronos.chat', 'item', item('b'))
  await emit(ctx, 'bronos.chat', 'item', item('a', { rev: 'a-r2' }))
  await emit(ctx, 'bronos.chat', 'item', item('a', { rev: 'a-r2', read: true }))
  assert.deepEqual(news, [['bronos.chat', ['b@b-r1']], ['bronos.chat', ['a@a-r2']]], 'a read change (same rev) is not news')
  store.dispose()
})

test('a later sync carries news: the items that arrived during an outage (review 2026-11-05)', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  const { ctx, store, news } = await setup({ 'bronos.chat': chat })
  await emit(ctx, 'bronos.chat', 'sync', { items: [item('a'), item('n1'), item('n2')], state: 'ok', asOf: NOW })
  assert.deepEqual(news, [['bronos.chat', ['n1@n1-r1', 'n2@n2-r1']]], 'a sync is not a baseline')
  // The same list again: nothing new. A read change in a sync: nothing new either.
  await emit(ctx, 'bronos.chat', 'sync', { items: [item('a', { read: true }), item('n1'), item('n2')], state: 'ok', asOf: NOW })
  assert.equal(news.length, 1)
  store.dispose()
})

test('a later snapshot() is news too; a failed one is not a baseline and the next good one is', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  chat.throwOn = 'snapshot'
  const { store, news, warns } = await setup({ 'bronos.chat': chat })
  assert.equal(store.get('bronos.chat').baselined, false)
  assert.match(store.get('bronos.chat').error, /feed broke/)
  assert.ok(warns.some((w) => /snapshot/.test(w)))
  chat.throwOn = null
  await store.snapshot('bronos.chat')
  assert.deepEqual(news, [], 'the first good read after a failure is the baseline')
  chat.items = [item('a'), item('b')]
  await store.snapshot('bronos.chat')
  assert.deepEqual(news, [['bronos.chat', ['b@b-r1']]])
  store.dispose()
})

test('an error answer with no items is not a baseline', async () => {
  const chat = fakeFeed(CHAT, [])
  chat.state = 'error'
  const { store, ctx, news } = await setup({ 'bronos.chat': chat })
  assert.equal(store.get('bronos.chat').baselined, false)
  await emit(ctx, 'bronos.chat', 'item', item('a'))
  assert.deepEqual(news, [], 'before a baseline an event only fills seen')
  store.dispose()
})

test('buffering: events during a pending snapshot apply after it, in order, and only what is new is news', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  const { ctx, store, news } = await setup({ 'bronos.chat': chat })
  const release = chat.hold()
  chat.items = [item('a'), item('b')]
  const pending = store.snapshot('bronos.chat')
  await flush()
  // Newer than the snapshot: b changes, c arrives, then a goes. A buffered copy of b with the snapshot's
  // rev is not news; the latest copy of each item is what the store keeps.
  ctx.emitFeed('bronos.chat', 'item', item('b'))
  ctx.emitFeed('bronos.chat', 'item', item('c'))
  ctx.emitFeed('bronos.chat', 'item', item('b', { rev: 'b-r2', title: 'newest' }))
  ctx.emitFeed('bronos.chat', 'gone', { ids: ['a'] })
  await flush()
  assert.deepEqual(news, [], 'nothing applied while the snapshot is pending')
  release()
  await pending
  // This snapshot is a later read, so its new b is news; then the buffered events in emit order (the
  // second copy of b, same rev, is not).
  assert.deepEqual(news, [['bronos.chat', ['b@b-r1', 'c@c-r1', 'b@b-r2']]])
  assert.deepEqual(ids(store, 'bronos.chat').sort(), ['b', 'c'])
  assert.equal(store.get('bronos.chat').items.find((i) => i.id === 'b').title, 'newest')
  store.dispose()
})

test('buffering at the baseline: the snapshot is the baseline, buffered events after it are news', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  const ctx = fakeCtx()
  const release = chat.hold()
  ctx.addProvider('bronos.chat', chat)
  const news = []
  const store = createSources(ctx.services.useAll('inbox-feed'), { onNews: (id, items) => news.push(items.map((i) => `${i.id}@${i.rev}`)), callMs: 1000 })
  const started = store.start()
  await flush()
  ctx.emitFeed('bronos.chat', 'item', item('a'))
  ctx.emitFeed('bronos.chat', 'item', item('new'))
  ctx.emitFeed('bronos.chat', 'item', item('new', { rev: 'new-r2' }))
  await flush()
  release()
  await started
  assert.deepEqual(news, [['new@new-r1', 'new@new-r2']], 'a is in the baseline, a same-rev copy is not news; both revs of new came after it')
  assert.equal(store.get('bronos.chat').items.find((i) => i.id === 'new').rev, 'new-r2', 'the latest copy is kept')
  store.dispose()
})

test('prune: gone and a sync without the key forget it, so the same id coming back is news', async () => {
  const chat = fakeFeed(CHAT, [item('a'), item('b'), item('c')])
  const { ctx, store, news } = await setup({ 'bronos.chat': chat })
  await emit(ctx, 'bronos.chat', 'gone', { ids: ['a'] })
  await emit(ctx, 'bronos.chat', 'item', item('a'))
  assert.deepEqual(news.splice(0), [['bronos.chat', ['a@a-r1']]], 'gone pruned a')
  await emit(ctx, 'bronos.chat', 'sync', { items: [item('a')], state: 'ok' })
  assert.deepEqual(news, [], 'b and c left the list')
  await emit(ctx, 'bronos.chat', 'sync', { items: [item('a'), item('b'), item('c')], state: 'ok' })
  assert.deepEqual(news, [['bronos.chat', ['b@b-r1', 'c@c-r1']]], 'a sync without the key pruned it')
  store.dispose()
})

test('nothing is pruned by age or count: the store cap evicts an item but not its seen key', async () => {
  const many = Array.from({ length: CAPS.perSource }, (_, i) => item(`i${i}`, { time: NOW - (i + 1) * 1000 }))
  const chat = fakeFeed(CHAT, many)
  const { ctx, store, news } = await setup({ 'bronos.chat': chat })
  await emit(ctx, 'bronos.chat', 'item', item('newest', { time: NOW }))
  assert.equal(store.get('bronos.chat').items.length, CAPS.perSource)
  assert.ok(!ids(store, 'bronos.chat').includes(`i${CAPS.perSource - 1}`), 'the oldest was evicted from the store')
  news.length = 0
  await emit(ctx, 'bronos.chat', 'item', { ...many[CAPS.perSource - 1], read: true })
  assert.deepEqual(news, [], 'a read change of the evicted item (same rev) is not news')
  store.dispose()
})

test('rebaseline: what is listed now is the new baseline', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  const { ctx, store, news } = await setup({ 'bronos.chat': chat })
  // Tracked while Autopilot is off: the store does not know the switch, so these are reported ...
  await emit(ctx, 'bronos.chat', 'item', item('b'))
  assert.equal(news.length, 1)
  news.length = 0
  // ... and the switch going on makes every listed item part of the baseline.
  store.rebaseline()
  await emit(ctx, 'bronos.chat', 'item', item('b'))
  await emit(ctx, 'bronos.chat', 'sync', { items: [item('a'), item('b')], state: 'ok' })
  assert.deepEqual(news, [])
  await emit(ctx, 'bronos.chat', 'item', item('c'))
  assert.equal(news.length, 1)
  store.dispose()
})

// ---- the store (copied from Inbox's tests, trimmed) ----

test('buffer overflow drops the buffer and asks a second snapshot', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  const { ctx, store } = await setup({ 'bronos.chat': chat })
  const release = chat.hold()
  const pending = store.snapshot('bronos.chat')
  await flush()
  for (let i = 0; i <= MAX_BUFFER; i++) ctx.emitFeed('bronos.chat', 'item', item(`x${i}`))
  await flush()
  chat.items = [item('a'), item('fresh')]
  release()
  await pending
  assert.ok(chat.calls.filter((c) => c[0] === 'snapshot').length >= 3, 'a second snapshot after the overflow')
  assert.deepEqual(ids(store, 'bronos.chat').sort(), ['a', 'fresh'])
  store.dispose()
})

test('a provider leaving takes its items; rejoining is a new instance, baselined again', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  const { ctx, store, news } = await setup({ 'bronos.chat': chat })
  ctx.removeProvider('bronos.chat')
  await store.sync()
  assert.equal(store.get('bronos.chat'), null)
  chat.items = [item('a'), item('b')]
  ctx.addProvider('bronos.chat', chat)
  await store.sync()
  assert.deepEqual(news, [], 'a provider joining starts with a baseline')
  assert.equal(chat.calls.filter((c) => c[0] === 'describe').length, 2)
  store.dispose()
})

test('a snapshot that never answers times out into an error line, with the fake clock', async () => {
  const chat = fakeFeed(CHAT, [item('a')])
  chat.hold()
  const ctx = fakeCtx()
  ctx.addProvider('bronos.chat', chat)
  const store = createSources(ctx.services.useAll('inbox-feed'), { callMs: 5 })
  await store.start()
  assert.match(store.get('bronos.chat').error, /did not answer/)
  store.dispose()
})

test('hostile events: prototype keys, wrong types and an item without from or place never break the store', async () => {
  const chat = fakeFeed(CHAT, [])
  const { ctx, store, news } = await setup({ 'bronos.chat': chat })
  await emit(ctx, 'bronos.chat', 'item', JSON.parse('{"__proto__":{"x":1},"id":"p","rev":"1","title":"t","time":5}'))
  await emit(ctx, 'bronos.chat', 'item', bare('bare'))
  await emit(ctx, 'bronos.chat', 'gone', 'junk')
  await emit(ctx, 'bronos.chat', 'sync', 7)
  ctx.emitFeed(42, 'item', item('z'))
  await flush()
  assert.equal(({}).x, undefined)
  assert.ok(ids(store, 'bronos.chat').includes('bare'))
  assert.equal(store.get('bronos.chat').state, 'error', 'a sync nothing can read is the source error')
  assert.ok(news.length >= 1)
  store.dispose()
})
