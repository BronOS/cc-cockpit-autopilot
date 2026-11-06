'use strict'
// The source store (autopilot design-v2 "Sources"; copied from Inbox's lib/sources.js and adapted):
// one record per `inbox-feed` provider, kept in line with the provider set and the `item` / `gone` /
// `sync` events they emit, plus what Inbox has no use for: which items are NEWS.
//
// - Baseline and news. `seen` maps an item id to the last `rev` Autopilot saw, in memory only (the
//   first read after a start is a baseline anyway). A source's first good read (its first snapshot
//   with a usable answer after the host starts, or after `rebaseline()` on the switch going on) fills
//   `seen` and reports nothing: without it every restart would fire on the whole inbox. After that
//   every `item` event AND every later `sync` / `snapshot()` is compared with `seen`: an id not in it,
//   or another `rev`, is news (`onNews`). A `sync` is not a baseline because sources send one after
//   an outage or sleep, and the items that arrived meanwhile come only in it (review 2026-11-05). A
//   read change (same `rev`) is not news. A key leaves `seen` on `gone` and when a full list no
//   longer holds it, never by age or count: an evicted key would make a mere read change of an item
//   still in the feed look new.
//
// - A source is keyed by the `pluginId` the registry passes with every event and every provider
//   entry, never by a field in the data: a provider cannot place items under another source. Each
//   stored item gets `source` set from that id (`itemOf` drops any `source` the data carried).
// - `describe()` and `features()` are asked once per provider instance: from the moment a plugin id
//   joins the set until it leaves. A plugin that leaves and rejoins (disabled, reloaded, updated) is a
//   new instance, described again. A failed describe falls back to a name built from the id and is
//   asked again with the next `snapshot()` of that source.
// - `snapshot()` is asked when the store starts and for every provider that joins (`onChange`). While
//   a source's snapshot is pending its events are buffered and applied after it, in emit order, so an
//   older snapshot never overwrites a newer `item`. A throwing or late snapshot is that source's error
//   line only; the buffered events are still applied (they are newer than anything Autopilot has).
// - `item` replaces the whole item, `gone` removes ids, `sync` replaces the set. A non-ok `sync`
//   (signedOut, error) keeps the last list, marked stale, with its message.
// - Everything coming in is checked by `feed.js` (`itemOf`, `goneOf`, `syncOf`); what they refuse
//   is counted on the source (`refused`, `overCap`), so a refusal shows on its line.
// Nothing here throws on a hostile provider: a bad answer is a state on that source.

const { CAPS, describeOf, featuresOf, itemOf, goneOf, syncOf } = require('./feed')
const { why, withTimeout } = require('./util')

const CALL_MS = 10000
// Events buffered for one source while its snapshot is pending. A provider that emits past this
// before answering its snapshot gets its buffer dropped and a second snapshot (bounded memory; the
// second snapshot is newer than every dropped event, so nothing is lost).
const MAX_BUFFER = 2000
const EVENTS = ['item', 'gone', 'sync']

/**
 * The store over `set` (`ctx.services.useAll('inbox-feed')`). `opts`: `log` ({ warn }), `onChange(pluginId)`
 * (after any change to a source: an event applied, a snapshot or describe answered, a source left),
 * `onNews(pluginId, items)` (items new or changed since the baseline, each with `source`, called after
 * the change is applied and never while a snapshot is pending), `callMs` (per-call limit, default 10 s),
 * `timers` (the pair behind that limit, for a fake clock). Call `start()` once; `dispose()` unsubscribes.
 */
function createSources(set, opts = {}) {
  const log = opts.log || { warn() {} }
  const onChange = opts.onChange || (() => {})
  const callMs = opts.callMs ?? CALL_MS
  const timers = opts.timers
  const onNews = opts.onNews || (() => {})
  /** pluginId -> record (see `newRecord`) */
  const sources = new Map()
  const disposers = []
  let disposed = false

  /** Hand the news over; a throwing consumer must not break the store. */
  const news = (pluginId, items) => {
    if (disposed || !items.length) return
    try {
      onNews(pluginId, items)
    } catch (e) {
      log.warn(`sources: news callback: ${why(e)}`)
    }
  }

  const changed = (pluginId) => {
    if (disposed) return
    try {
      onChange(pluginId)
    } catch (e) {
      log.warn(`sources: change callback: ${why(e)}`)
    }
  }

  function newRecord(p) {
    return {
      pluginId: p.pluginId,
      handle: p.handle,
      desc: describeOf(undefined, p.pluginId),
      described: false,
      describing: null,
      features: new Set(),
      /** id -> item, each with `source` = pluginId */
      items: new Map(),
      /** id -> last rev seen (see the header); `baselined` once a good read filled it */
      seen: new Map(),
      baselined: false,
      state: 'ok',
      message: null,
      error: null,
      asOf: null,
      loaded: false,
      refused: 0,
      overCap: 0,
      /** null when no snapshot is pending, else the events that came meanwhile */
      buffer: null,
      overflow: false,
      pending: null,
    }
  }

  const live = (r) => !disposed && sources.get(r.pluginId) === r

  /** describe + features once per instance; a failure keeps the fallback and is asked again next snapshot. */
  function describeRecord(r) {
    if (r.described || r.describing) return r.describing || Promise.resolve()
    r.describing = Promise.all([
      withTimeout(r.handle.describe(), callMs, `${r.pluginId} describe`, timers),
      withTimeout(r.handle.features(), callMs, `${r.pluginId} features`, timers).catch(() => []),
    ]).then(
      ([d, f]) => {
        r.describing = null
        if (!live(r)) return
        r.desc = describeOf(d, r.pluginId)
        r.features = featuresOf(f)
        r.described = true
        changed(r.pluginId)
      },
      (e) => {
        r.describing = null
        if (live(r)) log.warn(`source ${r.pluginId} describe: ${why(e)}`)
      }
    )
    return r.describing
  }

  /** Keep at most CAPS.perSource items, the newest by `time`; the rest count in `overCap`. */
  function capItems(r) {
    if (r.items.size <= CAPS.perSource) return
    const keep = [...r.items.values()].sort((a, b) => b.time - a.time).slice(0, CAPS.perSource)
    r.overCap += r.items.size - keep.length
    r.items = new Map(keep.map((it) => [it.id, it]))
  }

  /**
   * Compare `items` with `seen` and return the news. Before the baseline everything only fills `seen`.
   * `full`: the list is the source's whole set, so a key it lacks leaves `seen` (a gone item that was
   * never announced by a `gone` event).
   */
  function track(r, items, full) {
    const fresh = []
    for (const it of items) {
      if (r.seen.get(it.id) === it.rev) continue
      r.seen.set(it.id, it.rev)
      if (r.baselined) fresh.push({ ...it, source: r.pluginId })
    }
    if (full) {
      const ids = new Set(items.map((it) => it.id))
      for (const id of r.seen.keys()) if (!ids.has(id)) r.seen.delete(id)
    }
    return fresh
  }

  /** A checked Sync (from `syncOf`) applied to the record; returns the news it carried. */
  function applySync(r, s) {
    r.loaded = true
    r.state = s.state
    r.message = s.state === 'ok' ? null : s.message || null
    r.refused = s.refused
    r.overCap = s.overCap
    // A non-ok sync carries the last known list; an empty one keeps the list Autopilot already has.
    let fresh = []
    if (s.state === 'ok' || s.items.length > 0) {
      r.items = new Map(s.items.map((it) => [it.id, { ...it, source: r.pluginId }]))
      if (s.asOf !== null) r.asOf = s.asOf
      fresh = track(r, s.items, true)
      // A usable list is the baseline; a failed answer with nothing in it says nothing about the items.
      r.baselined = true
    }
    // An answer came: the error line was about a call that failed, this one did not.
    r.error = null
    return fresh
  }

  /** One event's raw data applied to the record (no snapshot pending); returns the news it carried. */
  function applyEvent(r, event, data) {
    if (event === 'item') {
      const { item, refused } = itemOf(data)
      r.refused += refused
      if (!item) {
        // A bad item is skipped and counted; the log line is the one place a person can see why a rule never fired on it.
        log.warn(`source ${r.pluginId}: an item was refused (missing or bad id, rev, title or time)`)
        return []
      }
      r.items.set(item.id, { ...item, source: r.pluginId })
      capItems(r)
      return track(r, [item], false)
    }
    if (event === 'gone') {
      const g = goneOf(data)
      // Ids past the 500 of one event are not applied: refused, like any part of an event Autopilot cannot use.
      r.refused += g.refused + g.overCap
      for (const id of g.ids) {
        r.items.delete(id)
        r.seen.delete(id)
      }
      return []
    }
    if (event === 'sync') return applySync(r, syncOf(data))
    return []
  }

  /**
   * Ask the source's `snapshot()`; events meanwhile are buffered, then applied in order. One snapshot
   * per source at a time (a second call while one is pending shares it). Never rejects.
   */
  function snapshot(pluginId) {
    const r = sources.get(pluginId)
    if (!r || disposed) return Promise.resolve()
    if (r.pending) return r.pending
    r.buffer = []
    r.overflow = false
    const describing = describeRecord(r)
    r.pending = (async () => {
      let answer
      let failed = null
      try {
        answer = syncOf(await withTimeout(r.handle.snapshot(), callMs, `${pluginId} snapshot`, timers))
      } catch (e) {
        failed = e
      }
      // The error line names the source by its described label, so wait for describe first.
      await describing
      if (!live(r)) return
      let fresh = []
      if (answer) fresh = applySync(r, answer)
      else {
        r.error = `${r.desc.label}: ${why(failed)}`
        log.warn(`source ${pluginId} snapshot: ${why(failed)}`)
      }
      const buffered = r.buffer
      const again = r.overflow
      r.buffer = null
      r.pending = null
      // Buffered events are newer than the snapshot: applied in emit order, each compared with what the
      // snapshot (the baseline, the first time) already put in `seen`, so only the later ones are news.
      for (const [event, data] of buffered) fresh.push(...applyEvent(r, event, data))
      changed(pluginId)
      news(pluginId, fresh)
      if (again) await snapshot(pluginId)
    })()
    return r.pending
  }

  function onEvent(event, data, pluginId) {
    if (disposed || typeof pluginId !== 'string') return
    let r = sources.get(pluginId)
    if (!r) {
      // An event before the onChange that announces its provider: join it now (its snapshot covers
      // anything it emitted before Autopilot subscribed), and buffer this event behind that snapshot.
      const p = providers().find((x) => x.pluginId === pluginId)
      if (!p) return
      r = join(p)
    }
    if (r.buffer) {
      if (r.buffer.length >= MAX_BUFFER) {
        r.buffer = []
        r.overflow = true
      }
      // `data` is the registry's own structured clone, so holding it is safe.
      r.buffer.push([event, data])
      return
    }
    const fresh = applyEvent(r, event, data)
    changed(pluginId)
    news(pluginId, fresh)
  }

  function providers() {
    try {
      const list = set.providers()
      return Array.isArray(list) ? list.filter((p) => p && typeof p.pluginId === 'string') : []
    } catch (e) {
      log.warn(`sources: providers: ${why(e)}`)
      return []
    }
  }

  function join(p) {
    const r = newRecord(p)
    sources.set(p.pluginId, r)
    void snapshot(p.pluginId)
    return r
  }

  /** Bring the records in line with the providers now; resolves once the joined ones answered their snapshot. */
  async function sync() {
    if (disposed) return
    const list = providers()
    const ids = new Set(list.map((p) => p.pluginId))
    for (const id of [...sources.keys()]) {
      if (ids.has(id)) continue
      // A leaving provider takes its items with it; a late answer to its snapshot is dropped (`live`).
      sources.delete(id)
      changed(id)
    }
    const pending = []
    for (const p of list) {
      if (!sources.has(p.pluginId)) join(p)
      const r = sources.get(p.pluginId)
      if (r.pending) pending.push(r.pending)
    }
    await Promise.all(pending)
  }

  /** A plain view of one record, items newest first. */
  function view(r) {
    return {
      pluginId: r.pluginId,
      desc: { ...r.desc },
      features: new Set(r.features),
      items: [...r.items.values()].sort((a, b) => b.time - a.time),
      state: r.state,
      message: r.message,
      error: r.error,
      // A list Autopilot cannot vouch for: the source is not ok, or its last snapshot failed.
      stale: r.items.size > 0 && (r.state !== 'ok' || r.error !== null),
      asOf: r.asOf,
      loaded: r.loaded,
      pending: r.pending !== null,
      refused: r.refused,
      overCap: r.overCap,
      baselined: r.baselined,
    }
  }

  return {
    /** Subscribe and read every provider now; resolves once their snapshots answered. */
    start() {
      if (disposers.length || disposed) return sync()
      for (const event of EVENTS) disposers.push(set.on(event, (data, pluginId) => onEvent(event, data, pluginId)))
      disposers.push(set.onChange(() => void sync().catch((e) => log.warn(`sources: sync: ${why(e)}`))))
      return sync()
    },
    sync,
    snapshot,
    /** The handle to call `act` on, or null when the source is not in the set. */
    /**
     * The switch went on: what is listed now is the new baseline, so nothing that came in while
     * Autopilot was off fires. A source whose snapshot is still pending takes that snapshot as its
     * baseline instead.
     */
    rebaseline() {
      for (const r of sources.values()) {
        r.seen = new Map([...r.items.values()].map((it) => [it.id, it.rev]))
        if (r.pending) r.baselined = false
      }
    },
    get: (pluginId) => (sources.has(pluginId) ? view(sources.get(pluginId)) : null),
    list: () => [...sources.values()].map(view),
    dispose() {
      disposed = true
      for (const d of disposers.splice(0)) {
        try {
          if (typeof d === 'function') d()
        } catch {}
      }
      sources.clear()
    },
  }
}

module.exports = { createSources, MAX_BUFFER }
