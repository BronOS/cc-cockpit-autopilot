'use strict'
// Active hours: the schema check, inHours edges, canonicalRule, the host skipping before Jev (no
// request outside the hours, checked before the field conditions) and without marking the item
// fired, the dry run's text, the panel form's round trip.
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../dist/lib/schema')
const R = require('../dist/lib/rules')
const CLI = require('../dist/lib/cli')
const F = require('../dist/lib/format')
const V = require('../panels/viewlogic')
const { createAutopilot } = require('../dist/host')
const { fakeCtx, fakeFeed, fakeJev, fakeClock, fakeStorage, item, settle, tempFolder, removeFolder, rule, JIRA } = require('./fakes')

const errsOf = (hours) => S.checkRule(rule('a', { hours })).errors
// Local time, like the host's clock use.
const at = (h, m = 0) => new Date(2026, 10, 4, h, m).getTime()

test('hours: valid, crossing midnight, absent and null mean any time', () => {
  const day = S.checkRule(rule('a', { hours: { from: '09:00', to: '17:30' } }))
  assert.deepEqual(day.errors, [])
  assert.deepEqual(day.rule.hours, { from: '09:00', to: '17:30' })
  assert.deepEqual(S.checkRule(rule('a', { hours: { from: '22:00', to: '07:00' } })).errors, [])
  assert.equal(S.checkRule(rule('a')).rule.hours, null)
  assert.equal(S.checkRule(rule('a', { hours: null })).rule.hours, null)
})

test('hours: from equal to is an error, bad formats name their field', () => {
  assert.deepEqual(errsOf({ from: '08:00', to: '08:00' }).map((e) => e.field), ['hours.from'])
  assert.match(errsOf({ from: '08:00', to: '08:00' })[0].message, /same; leave hours out to run at any time/)
  for (const bad of ['9:00', '24:00', '12:60', '12:5', '', ' 12:00', '12:00:00', 'noon', 7, null, '١٢:٠٠'])
    assert.deepEqual(errsOf({ from: bad, to: '07:00' }).map((e) => e.field), ['hours.from'], String(bad))
  assert.deepEqual(errsOf({ from: '09:00' }).map((e) => e.field), ['hours.to'])
  assert.deepEqual(errsOf({}).map((e) => e.field), ['hours.from', 'hours.to'])
  for (const bad of ['22:00', [], 5]) assert.deepEqual(errsOf(bad).map((e) => e.field), ['hours'])
})

test('hours: an unknown key warns and canonicalRule round-trips it', () => {
  const raw = rule('a', { hours: { from: '22:00', to: '07:00', days: 'weekdays' } })
  const c = S.checkRule(raw)
  assert.deepEqual(c.errors, [])
  assert.ok(c.warnings.some((w) => /unknown key "days" in hours/.test(w)))
  const out = S.canonicalRule({ ...raw, hours: { from: '23:00', to: '06:00' } }, raw)
  assert.deepEqual(out.hours, { from: '23:00', to: '06:00', days: 'weekdays' })
  const keys = Object.keys(out)
  assert.equal(keys[keys.indexOf('hours') - 1], 'jev' in out ? 'jev' : 'when', 'hours comes after when/jev in file order')
  assert.equal(Object.hasOwn(S.canonicalRule(rule('a'), null), 'hours'), false, 'written only when set')
})

test('inHours: from inclusive, to exclusive, midnight crossing, 00:00', () => {
  const day = { from: '09:00', to: '17:00' }
  assert.equal(S.inHours(day, at(8, 59)), false)
  assert.equal(S.inHours(day, at(9, 0)), true)
  assert.equal(S.inHours(day, at(16, 59)), true)
  assert.equal(S.inHours(day, at(17, 0)), false)
  const night = { from: '22:00', to: '07:00' }
  assert.deepEqual([at(21, 59), at(22, 0), at(23, 59), at(0, 0), at(6, 59), at(7, 0), at(12)].map((t) => S.inHours(night, t)), [false, true, true, true, true, false, false])
  const fromMidnight = { from: '00:00', to: '06:00' }
  assert.deepEqual([at(0, 0), at(5, 59), at(6, 0), at(23, 59)].map((t) => S.inHours(fromMidnight, t)), [true, true, false, false])
  assert.equal(S.inHours({ from: '18:00', to: '00:00' }, at(23, 59)), true)
  assert.equal(S.inHours({ from: '18:00', to: '00:00' }, at(0, 0)), false)
  assert.equal(S.inHours(null, at(3)), true)
  assert.equal(S.inHours(undefined, new Date(at(3))), true)
  assert.equal(S.hoursLabel(night), '22:00–07:00')
})

async function setup(rules, jev) {
  const dir = tempFolder(rules, { check: '# Check\nGo.' })
  const ctx = fakeCtx({ folder: dir, jev, storage: fakeStorage() })
  await ctx.storage.set('enabled', true)
  const clock = fakeClock(at(12))
  const feed = fakeFeed(JIRA, [])
  ctx.addProvider('bronos.jira', feed)
  const ap = createAutopilot(ctx, { now: clock.now, timers: clock.timers, debounceMs: 1000, home: '/home/ann' })
  await ap.first
  const push = async (items) => {
    feed.items = items
    ctx.emitFeed('bronos.jira', 'sync', { items, state: 'ok' })
    await settle()
    await clock.advance(1000)
    await ap.idle()
    // A Jev request the judging queued goes out on lib/jev.js's timer; its answer is decided after.
    await clock.advance(2000)
    await settle()
    await ap.idle()
    await settle()
  }
  return { ctx, clock, ap, push, done: () => (ap.dispose(), removeFolder(dir)) }
}

test('host: outside the hours the rule is skipped before Jev, not marked fired, logged', async () => {
  const jev = fakeJev(0.9)
  const r = rule('night', { onChange: true, hours: { from: '22:00', to: '07:00' }, jev: { question: 'q?', min: 0.5 }, limits: { cooldownMinutes: 0 } })
  const t = await setup([r], jev)
  await t.push([item('SUP-1', { title: 'site down', rev: 'a' })])
  assert.equal(t.ctx.opened.length, 0)
  assert.equal(jev.calls.length, 0, 'Jev is not asked outside the hours')
  const [e] = t.ap.state.recent()
  assert.equal(e.skip, 'outside hours 22:00–07:00')
  assert.equal(e.step, 'hours')
  assert.equal(t.ap.state.fired('night', 'bronos.jira', 'SUP-1'), null, 'not recorded as fired')
  // The window opens: the same rev listed again is not queued; a new rev inside the window fires.
  t.clock.t = at(23)
  await t.push([item('SUP-1', { title: 'site down', rev: 'a' })])
  assert.equal(t.ctx.opened.length, 0, 'nothing is queued for when the window opens')
  await t.push([item('SUP-1', { title: 'site down', rev: 'b' })])
  assert.equal(t.ctx.opened.length, 1)
  assert.equal(jev.calls.length, 1)
  t.done()
})

test('dry run: outside the hours is named instead of "would fire"; the listing shows the window', async () => {
  const r = rule('night', { hours: { from: '22:00', to: '07:00' } })
  const t = await setup([r])
  await t.push([item('SUP-1', { title: 'site down' })])
  // The item arrived while on, so it is "seen"; the dry run still reads the feed as it is.
  const d = await t.ap.dryRun(null, false)
  assert.equal(d.results[0].fire, false)
  assert.match(d.results[0].verdict, /outside its hours 22:00–07:00 right now/)
  assert.match(CLI.formatDry(d), /would not fire: outside its hours 22:00–07:00 right now/)
  assert.match(t.ap.status().rules[0].summary, /hours 22:00–07:00/)
  t.clock.t = at(23)
  assert.equal((await t.ap.dryRun(null, false)).results[0].fire, true)
  t.done()
})

test('format text and example document hours; summaryOf shows the window', () => {
  assert.match(F.formatText(), /hours\.from/)
  assert.match(F.formatText(), /22:00 to 07:00 is the night/)
  assert.deepEqual(F.EXAMPLE_RULE.hours, { from: '22:00', to: '07:00' })
  assert.match(R.summaryOf(S.checkRule(rule('a', { hours: { from: '22:00', to: '07:00' } })).rule), /hours 22:00–07:00/)
})

test('panel form: hours round-trip on edit, Any time leaves the key out, errors per field', () => {
  const ST = { levels: [{ level: 'project', label: 'Project', folder: '/p', editable: true, playbookFiles: [{ name: 'check' }], entries: [] }], sources: [] }
  const raw = rule('a', { hours: { from: '22:00', to: '07:00' } })
  const f = V.formFromRaw(raw, ST, 'project')
  assert.deepEqual([f.hoursMode, f.hoursFrom, f.hoursTo], ['set', '22:00', '07:00'])
  assert.deepEqual(V.formToRule(f).hours, { from: '22:00', to: '07:00' })
  const any = V.formFromRaw(rule('b'), ST, 'project')
  assert.deepEqual([any.hoursMode, any.hoursFrom, any.hoursTo], ['any', '22:00', '07:00'])
  assert.equal(Object.hasOwn(V.formToRule(any), 'hours'), false)
  assert.deepEqual(V.formErrors({ ...f, id: 'a' }, ST, 0), {})
  assert.deepEqual(Object.keys(V.formErrors({ ...f, id: 'a', hoursFrom: '' }, ST, 0)), ['hours.from'])
  assert.match(V.formErrors({ ...f, id: 'a', hoursTo: '22:00' }, ST, 0)['hours.from'], /same/)
  assert.deepEqual(V.formErrors({ ...any, id: 'b', hoursFrom: '' }, ST, 0), {}, 'ignored while Any time')
})
