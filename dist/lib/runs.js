'use strict'
// Runs (design-v2 "One session per item"): which Autopilot tab works on which item, how many slots
// are taken, and the queue of items that fired at the cap.
//
// - **Records** `key → { source, itemId, tabId, sessionId, rule, rev, openedAt, deliveries, stopped,
//   runId, takenOver }` live in ctx.storage (`runs`), so a restart still knows which tab is whose. A
//   record is trusted only while ctx.sessions.list() shows its tab: `reconcile(list)` runs on every
//   sessions onChange and before the host decides, and drops a record whose tab is gone (the person
//   closed it: the item is free again). "In flight" is never a stored status.
// - **Opening** entries (memory only) cover the time from a fire to `open()` resolving: the item has
//   a run already (a second rev or a dequeue opens nothing), and the entry holds a slot.
// - **A restart** restores tabs under new tab ids (core mints one) but keeps their Claude `sessionId`
//   (restore resumes it). A stored record whose tab id is unknown is re-adopted by `sessionId`, marked
//   taken over: nothing is delivered into a resumed session the person has not looked at yet.
// - **Slots** (`maxRunning`): opening entries and tabs `starting` or `working`. A finished tab
//   (`waiting`, Claude done at its prompt), one waiting for a permission answer and an ended one hold
//   none (the user, 2026-11-05: otherwise three night runs block every later item until the person
//   closes a tab). `idle` holds none either: it is not working. Counting `starting` matters: a burst
//   of news would otherwise open past the cap before the first tabs report `working`.
// - **The queue** (memory only, like v1's nothing-queued-across-restarts): one entry per item key, its
//   place kept when a newer rev comes (the host re-reads the latest copy when it dequeues anyway), at
//   most 50, the oldest out first. An entry holds the item's app-wide claim (lib/claims.js) under the
//   run id it will open with.
// - **Pending updates** (memory only, design-v2 "The pending update"; a restart drops them, restored
//   tabs are taken over anyway): at most one per item, the newest rev replacing an older one, so five
//   Chat messages during one run arrive as one delivery of the item's latest state. The host delivers
//   one when the tab waits for input and the person has not typed in it.
// - **Taken over** (design-v2 decision 8): the first list that shows `typed: true` on a record's tab
//   marks the record (stored), and its pending update goes. Main refuses and drops plugin texts into
//   a typed tab itself; this is what keeps Autopilot from trying, and what the log shows.
//
// Grace periods, since the list is a moment late on both ends: a tab just opened may not be in the
// next list yet (FRESH_MS), and restored tabs may come after the host started (RESTORE_GRACE_MS). A
// record whose tab was seen once and then vanished is dropped at once.

const { isObj } = require('./util')

const KEY = 'runs'
const RUNS_MAX = 200
const QUEUE_MAX = 50
const FRESH_MS = 30000
const RESTORE_GRACE_MS = 60000
// A tab that ends within this long after opening most likely never ran: Claude Code refused the
// model or effort (or the argv); logged with its rule so a bad setting shows (design-v2 "The cap").
const EARLY_END_MS = 60000
const HOLDS_SLOT = Object.freeze(['starting', 'working'])
const MAX_RUNNING = Object.freeze({ min: 1, max: 10, default: 3 })
const MY_NAMES_MAX = 10
const MY_NAME_LEN = 200
// Updates delivered into one tab at most (design-v2 decision 10): a source outsiders can write to must
// not be able to keep a session busy, nor wake a finished one forever.
const DELIVERY_MAX = 5
// The record's rule is its ref (`project:r1`): `project:` (8) and an id of at most 64.
const RULE_REF_MAX = 80

const keyOf = (source, itemId) => `${source}\u0000${itemId}`
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const time = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The project setting `maxRunning` as a whole number 1..10 (default 3): the app checks the schema, this is the belt. */
function maxRunningOf(settings) {
  const v = settings && settings.project && settings.project.maxRunning
  if (!Number.isInteger(v)) return MAX_RUNNING.default
  return Math.min(MAX_RUNNING.max, Math.max(MAX_RUNNING.min, v))
}

/** The project setting `myNames`: up to 10 trimmed non-empty strings (plan Task 12 checks replies against them). */
function myNamesOf(settings) {
  const v = settings && settings.project && settings.project.myNames
  if (!Array.isArray(v)) return []
  return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, MY_NAME_LEN)).slice(0, MY_NAMES_MAX)
}

/**
 * Is the item's latest activity the person's own (their reply)? `from.name` or `from.address` equal,
 * ignoring case and outer spaces, to one of `names` (myNamesOf). No names: the check is off, since no
 * source states the account's identity (design-v2 "Shipped details").
 */
function isOwn(item, names) {
  if (!names.length || !isObj(item) || !isObj(item.from)) return false
  const mine = new Set(names.map((n) => n.toLowerCase()))
  return [item.from.name, item.from.address].some((v) => typeof v === 'string' && v.trim() && mine.has(v.trim().toLowerCase()))
}

/** A stored record checked like any input; null when it cannot be used. */
function recordOf(raw) {
  if (!isObj(raw) || typeof raw.source !== 'string' || typeof raw.itemId !== 'string' || typeof raw.tabId !== 'string' || typeof raw.rule !== 'string' || time(raw.openedAt) === null) return null
  return {
    source: str(raw.source, 128),
    itemId: str(raw.itemId, 300),
    tabId: str(raw.tabId, 200),
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? str(raw.sessionId, 200) : null,
    rule: str(raw.rule, RULE_REF_MAX),
    rev: str(raw.rev, 300),
    openedAt: raw.openedAt,
    deliveries: Number.isInteger(raw.deliveries) && raw.deliveries >= 0 ? raw.deliveries : 0,
    stopped: raw.stopped === true,
    runId: str(raw.runId, 64),
    takenOver: raw.takenOver === true,
    // The mode the tab was opened with (0.3.0), for the wording of its deliveries; a record from before
    // has none and is read as investigate (deliveries then say "still read-only", the cautious side).
    mode: raw.mode === 'act' ? 'act' : 'investigate',
  }
}

/**
 * `storage` is ctx.storage; `now` the clock. Every write is awaited by the caller; a failed one leaves
 * memory right for this run (the host logs it).
 */
function createRuns({ storage, now = Date.now }) {
  const records = new Map()
  const opening = new Map()
  const queue = new Map()
  const pending = new Map()
  // In memory: records whose tab a list showed in this host run (a vanished one is closed, not late),
  // the records loaded at start (restore grace, no slot until seen), the early-end lines already logged.
  const seen = new Set()
  const loaded = new Set()
  const endLogged = new Set()
  let sessions = []
  const startedAt = now()

  const save = () => storage.set(KEY, [...records.values()])
  const tabOf = (rec) => sessions.find((s) => s && s.tabId === rec.tabId) || null

  return {
    async load() {
      const raw = await storage.get(KEY)
      records.clear()
      for (const r of Array.isArray(raw) ? raw : []) {
        const rec = recordOf(r)
        if (!rec) continue
        const k = keyOf(rec.source, rec.itemId)
        records.set(k, rec)
        loaded.add(k)
      }
      while (records.size > RUNS_MAX) records.delete(records.keys().next().value)
    },

    /**
     * Check every record against the window's Claude tabs (ctx.sessions.list / onChange). Returns what
     * changed for the log: `dropped` (the tab is gone: the item is free), `adopted` (a restored tab
     * found by its sessionId, taken over), `endedEarly` (ended within a minute of opening).
     */
    async reconcile(list) {
      sessions = Array.isArray(list) ? list.filter(isObj) : []
      const out = { dropped: [], adopted: [], endedEarly: [], takenOver: [] }
      let dirty = false
      const t = now()
      const bound = new Set([...records.values()].map((r) => r.tabId))
      for (const [k, rec] of records) {
        let tab = tabOf(rec)
        if (!tab && rec.sessionId) {
          // A restored tab: same Claude session, new tab id. Never one another record holds.
          tab = sessions.find((s) => s.sessionId === rec.sessionId && !bound.has(s.tabId)) || null
          if (tab) {
            bound.add(tab.tabId)
            rec.tabId = tab.tabId
            rec.takenOver = true
            pending.delete(k)
            out.adopted.push({ key: k, ...rec })
            dirty = true
          }
        }
        if (!tab) {
          const grace = loaded.has(k) ? t - startedAt < RESTORE_GRACE_MS : t - rec.openedAt < FRESH_MS
          if (seen.has(k) || !grace) {
            records.delete(k)
            pending.delete(k)
            seen.delete(k)
            loaded.delete(k)
            endLogged.delete(k)
            out.dropped.push({ key: k, ...rec })
            dirty = true
          }
          continue
        }
        seen.add(k)
        // The person typed or pasted into the tab (app 0.11): taken over for good, while the tab exists.
        // `=== true` only: an older app has no `typed`, which is "no deliveries at all" (support()).
        if (tab.typed === true && !rec.takenOver) {
          rec.takenOver = true
          const p = pending.get(k)
          pending.delete(k)
          out.takenOver.push({ key: k, ...rec, droppedRev: p ? p.item.rev : null })
          dirty = true
        }
        // A new tab gets its sessionId with Claude's SessionStart hook, a moment after it opened.
        if (!rec.sessionId && typeof tab.sessionId === 'string' && tab.sessionId) {
          rec.sessionId = tab.sessionId.slice(0, 200)
          dirty = true
        }
        if (tab.status === 'ended' && !rec.takenOver && t - rec.openedAt < EARLY_END_MS && !endLogged.has(k)) {
          endLogged.add(k)
          out.endedEarly.push({ key: k, ...rec })
        }
      }
      if (dirty) await save()
      return out
    },

    /**
     * Does this app report `typed` (takeover detection, app 0.11)? 'yes' / 'no' from any Claude tab of
     * the window, 'unknown' while there is none. Plugins see no app version; this is the one signal,
     * and it also says whether `model`/`effort` reached the app (an older one drops them silently).
     */
    support() {
      if (!sessions.length) return 'unknown'
      return sessions.some((s) => typeof s.typed === 'boolean') ? 'yes' : 'no'
    },

    /** The item's run: its record (`kind: 'tab'`, with the tab's current SessionInfo) or opening entry, or null. */
    runOf(source, itemId) {
      const k = keyOf(source, itemId)
      if (opening.has(k)) return { kind: 'opening', key: k, ...opening.get(k) }
      const rec = records.get(k)
      return rec ? { kind: 'tab', key: k, record: rec, tab: tabOf(rec) } : null
    },

    /** Slots in use: opening entries, tabs starting or working, and a just-opened tab the list has not shown yet. */
    running() {
      let n = opening.size
      for (const [k, rec] of records) {
        const tab = tabOf(rec)
        if (tab ? HOLDS_SLOT.includes(tab.status) : !loaded.has(k) && !seen.has(k)) n++
      }
      return n
    },

    beginOpening(source, itemId, info) {
      opening.set(keyOf(source, itemId), { ...info, at: now() })
    },
    endOpening(source, itemId) {
      opening.delete(keyOf(source, itemId))
    },
    /** The opened tab's record (after `open()` resolved with its tab id). */
    async record(rec) {
      const k = keyOf(rec.source, rec.itemId)
      records.delete(k)
      records.set(k, { sessionId: null, deliveries: 0, stopped: false, takenOver: false, ...rec })
      while (records.size > RUNS_MAX) records.delete(records.keys().next().value)
      await save()
    },

    /**
     * Why nothing may be delivered into the record's tab any more (a reason for the log), or null.
     * Taken over first: it is what the person did, and it outlasts the other two.
     */
    blocked(rec) {
      if (rec.takenOver) return 'taken over: you typed in the tab'
      if (rec.stopped) return 'stopped: the session ran ccc autopilot stop'
      if (rec.deliveries >= DELIVERY_MAX) return `delivery cap: ${DELIVERY_MAX} updates were delivered into this tab`
      return null
    },

    /** Make `item` the key's pending update; returns the rev it replaced (null: none was pending). */
    setPending(source, itemId, item) {
      const k = keyOf(source, itemId)
      const old = pending.get(k)
      pending.set(k, { source, itemId, item, at: now() })
      return old ? old.item.rev : null
    },
    pendingOf: (source, itemId) => pending.get(keyOf(source, itemId)) || null,
    dropPending: (source, itemId) => pending.delete(keyOf(source, itemId)),
    /** Every pending update, oldest first. */
    pendings: () => [...pending.values()],
    clearPending: () => pending.clear(),

    /** An update reached the send gate: one delivery more, and the tab now knows `rev`. */
    async delivered(source, itemId, rev) {
      const rec = records.get(keyOf(source, itemId))
      if (!rec) return
      rec.deliveries++
      rec.rev = str(rev, 300)
      await save()
    },

    /** The record whose run id this is (the stop command names it), or null. */
    byRunId(runId) {
      for (const [k, rec] of records) if (rec.runId && rec.runId === runId) return { key: k, record: rec }
      return null
    },
    /** The session said stop: nothing more is delivered into its tab (stored, so a restart keeps it). */
    async stop(source, itemId) {
      const k = keyOf(source, itemId)
      const rec = records.get(k)
      if (!rec) return
      pending.delete(k)
      if (rec.stopped) return
      rec.stopped = true
      await save()
    },

    /**
     * Queue the item at the cap. One entry per key (its place kept); a new key at 50 pushes the oldest
     * out, which is returned so the host logs it and releases its claim. `runId`: the run the item's
     * app-wide claim was taken for (lib/claims.js); the open uses it, so the claim stays the same.
     */
    enqueue(source, itemId, runId = null) {
      const k = keyOf(source, itemId)
      if (queue.has(k)) return null
      let out = null
      if (queue.size >= QUEUE_MAX) {
        const [oldest, ref] = queue.entries().next().value
        queue.delete(oldest)
        out = ref
      }
      queue.set(k, { source, itemId, at: now(), runId })
      return out
    },
    /** The item's queue entry (`{ source, itemId, at, runId }`), or null. */
    queuedOf: (source, itemId) => queue.get(keyOf(source, itemId)) || null,
    unqueue(source, itemId) {
      return queue.delete(keyOf(source, itemId))
    },
    isQueued: (source, itemId) => queue.has(keyOf(source, itemId)),
    /** The queue, oldest first. */
    queued: () => [...queue.values()],
    clearQueue: () => queue.clear(),

    /** Every record with its tab's status (null: not in the list) and its pending rev (null: none), for the panel and the status. */
    list() {
      return [...records].map(([k, r]) => {
        const tab = tabOf(r)
        const p = pending.get(k)
        return { ...r, status: tab ? tab.status : null, pending: p ? p.item.rev : null }
      })
    },
  }
}

module.exports = { KEY, RUNS_MAX, DELIVERY_MAX, QUEUE_MAX, FRESH_MS, RESTORE_GRACE_MS, EARLY_END_MS, HOLDS_SLOT, MAX_RUNNING, MY_NAMES_MAX, MY_NAME_LEN, keyOf, maxRunningOf, myNamesOf, isOwn, recordOf, createRuns }
