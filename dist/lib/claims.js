'use strict'
// One window per item (design-v2 "One window per item"): an app-wide claim in ctx.appStorage, so two
// project windows whose rules match the same item (a global rule runs in every project) never both
// open a tab for it. ctx.appStorage is main's: every window's host sees the same keys, main applies
// one call at a time, and `increment` is the one atomic step (a `get` then `set` is not).
//
// Keys (the item is `source` + `itemId`, hashed so any id fits the 200-character key limit and no
// item text reaches a key; `h` = the first 32 hex digits of sha256 of `[source, itemId]` as JSON,
// 128 bits):
//
// - `cl:<h>`: the counter. `increment` answering 1 is the winner; anything else lost the race.
// - `co:<h>`: the owner record, written by the winner right after: `{ source, itemId, project,
//   runId, rule, at, seen }`. `project` is the window's projectDir, `runId` the run the claim is for
//   (the same id the run record, the prompt frame and `ccc autopilot stop` use), `seen` the last
//   refresh. A claim is "mine" only when BOTH project and runId are this window's: a restart of the
//   same project re-adopts its claim through the stored run record's runId.
// - `ct:<h>:<runId>`: the take lock for one stale owner run. Freeing (or taking over) a stale claim
//   is a get-then-write, so two windows could do it at once; `increment` on this key lets one through.
//
// Release (the owner only, never a claim another window holds now): `co` first, then `cl`, then the
// take lock it used. In that order another window either still sees the owner (and loses, correctly)
// or sees a counter with no owner for the moment between the two deletes (and loses too: a narrow
// race that costs one item, never a second tab). The reverse order could let a new winner's `co`
// be deleted by the old owner's late delete.
//
// This project's own leftovers (a claim kept by a quit whose run did not survive the restart) are
// taken over or freed at once: cc-cockpit has one window per project, so no other host can hold them.
//
// Stale claims (a window that crashed, or a project not reopened after the app quit, never
// releases): the owner refreshes `seen` every REFRESH_MS while the claim is held. Another window
// frees a claim only when BOTH hold: `seen` is STALE_MS old by the clock, AND this window watched the
// same unchanged record for STALE_TICKS of its own 60 s passes. The clock alone is wrong after a
// sleep: on wake every claim looks hours old until its owner's next pass, which may come a minute
// after this window's. Passes do not run while the machine sleeps, so the count is awake time,
// during which a live owner would have refreshed three times. STALE_MS (3 h, 18 missed refreshes) is
// the margin for an owner whose refreshes failed for a while (main busy); short enough that an item
// a crashed window held is free again the same day.
//
// Bounded keys: a window holds at most one claim per run record (200), opening entry and queue entry
// (50), each two keys plus a take lock, released at every release point (lib/../host.js). The sweep
// (every SWEEP_TICKS passes) frees confirmed-stale claims and deletes a counter with no owner or a
// take lock whose owner run is gone once two sweeps in a row saw it unchanged (a crash between the
// increment and the owner write, a release cut short by a quit).

const crypto = require('node:crypto')
const { isObj } = require('./util')

const COUNT = 'cl:'
const OWNER = 'co:'
const TAKE = 'ct:'
const HASH_HEX = 32
const REFRESH_MS = 10 * 60000
const STALE_MS = 3 * 3600000
const STALE_TICKS = 30
// A pass counts once this long after the last one: a burst of passes (the refresh button, the
// switch) must not shorten the awake-time watch.
const TICK_MIN_MS = 30000
const SWEEP_TICKS = 10
// lib/prompt.js newRunId: `r` and 12 hex digits; anything key-safe up to 64 is accepted.
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/
const PROJECT_MAX = 1000
const RULE_MAX = 80

// JSON of the pair, not a joined string: no source/id split can make two items one hash.
const hashOf = (source, itemId) => crypto.createHash('sha256').update(JSON.stringify([source, itemId])).digest('hex').slice(0, HASH_HEX)
const takeKey = (h, runId) => `${TAKE}${h}:${runId}`
const num = (v) => typeof v === 'number' && Number.isFinite(v)

/** A stored owner record checked like any input (another window, or an older version, wrote it); null when unusable. */
function ownerOf(raw) {
  if (!isObj(raw) || typeof raw.project !== 'string' || typeof raw.runId !== 'string' || !RUN_ID.test(raw.runId) || !num(raw.at) || !num(raw.seen)) return null
  return {
    source: typeof raw.source === 'string' ? raw.source.slice(0, 128) : '',
    itemId: typeof raw.itemId === 'string' ? raw.itemId.slice(0, 300) : '',
    project: raw.project.slice(0, PROJECT_MAX),
    runId: raw.runId,
    rule: typeof raw.rule === 'string' ? raw.rule.slice(0, RULE_MAX) : '',
    at: raw.at,
    seen: raw.seen,
  }
}

/**
 * `store` is ctx.appStorage (get, set, delete, keys, increment), `project` this window's projectDir,
 * `now` the clock. Every method may reject when the store does; the host fails closed (no claim, no
 * tab) and logs it.
 */
function createClaims({ store, project, now = Date.now }) {
  const proj = String(project || '').slice(0, PROJECT_MAX)
  // This window's claims: h → { source, itemId, runId, rule, refreshedAt, took }.
  const mine = new Map()
  // Other windows' owner records this window has seen: h → { runId, seen, since } (`since`: the pass count then).
  const watch = new Map()
  // Leftover keys seen by the last sweep: key → the value then (deleted when the next sweep sees the same).
  const leftovers = new Map()
  let passes = 0
  let lastPassAt = -Infinity

  const isMe = (o, runId) => Boolean(o) && o.project === proj && o.runId === runId
  const readOwner = async (h) => ownerOf(await store.get(OWNER + h))
  const ownerRecord = (c, at) => ({ source: c.source.slice(0, 128), itemId: c.itemId.slice(0, 300), project: proj, runId: c.runId, rule: String(c.rule || '').slice(0, RULE_MAX), at, seen: at })
  const hold = (h, c, at, took = null) => mine.set(h, { source: c.source, itemId: c.itemId, runId: c.runId, rule: String(c.rule || ''), refreshedAt: at, took })

  /** Is `o` (another window's owner record) confirmed stale? Records the watch as a side effect. */
  function staleNow(h, o) {
    const w = watch.get(h)
    if (!w || w.runId !== o.runId || w.seen !== o.seen) {
      watch.set(h, { runId: o.runId, seen: o.seen, since: passes })
      return false
    }
    return passes - w.since >= STALE_TICKS && now() - o.seen >= STALE_MS
  }

  /** Win the take lock for `o`'s run and check the record is still that stale one: true when this window may replace it. */
  async function takeLock(h, o) {
    if ((await store.increment(takeKey(h, o.runId))) !== 1) return false
    const again = await readOwner(h)
    return Boolean(again) && again.runId === o.runId && again.seen === o.seen && again.project === o.project
  }

  /**
   * Claim the item for run `c` = `{ source, itemId, runId, rule }`. `{ ok: true }` (this window owns it
   * now, or already did), or `{ ok: false, owner }` (another window's live claim; `owner` null while its
   * owner record is not written yet). `adopt`: a run record restored after a restart, whose tab this
   * window has: a counter left with no owner (a release a quit cut short) is not a reason to give
   * the tab's item up, so the owner is written unless one appeared.
   */
  async function claim(c, { adopt = false } = {}) {
    if (!isObj(c) || typeof c.source !== 'string' || typeof c.itemId !== 'string' || typeof c.runId !== 'string' || !RUN_ID.test(c.runId)) throw new Error('claim: bad run')
    const h = hashOf(c.source, c.itemId)
    let o = await readOwner(h)
    const held = mine.get(h)
    if (held) {
      if (isMe(o, held.runId)) {
        // Already ours (a queued item opening now uses the run id it was queued with: same id).
        if (held.runId !== c.runId) {
          const at = now()
          await store.set(OWNER + h, { ...o, runId: c.runId, rule: String(c.rule || '').slice(0, RULE_MAX), seen: at })
          hold(h, c, at, held.took)
        }
        return { ok: true }
      }
      // Lost meanwhile (taken over as stale by another window): decided as anyone's below.
      mine.delete(h)
    }
    if (o) {
      // This window's own record for this run: a restart re-adopting it.
      if (isMe(o, c.runId)) {
        hold(h, c, now())
        return { ok: true }
      }
      // This project's record of a run this window does not hold (a queued item, or a tab closed
      // while the app was quit): cc-cockpit has one window per project, so no live host uses it.
      const ownLeftover = o.project === proj
      if ((!ownLeftover && !staleNow(h, o)) || !(await takeLock(h, o))) return { ok: false, owner: o }
      const at = now()
      await store.set(OWNER + h, ownerRecord(c, at))
      hold(h, c, at, o.runId)
      watch.delete(h)
      return { ok: true, took: o }
    }
    if ((await store.increment(COUNT + h)) === 1) {
      const at = now()
      await store.set(OWNER + h, ownerRecord(c, at))
      hold(h, c, at)
      return { ok: true }
    }
    o = await readOwner(h)
    if (!o && adopt) {
      const at = now()
      await store.set(OWNER + h, ownerRecord(c, at))
      hold(h, c, at)
      return { ok: true }
    }
    return { ok: false, owner: o }
  }

  /**
   * Release this window's claim on the item: true when it was ours and is gone. A claim this window
   * does not hold, or one another window took over since, is never touched (its keys are theirs).
   */
  async function release(source, itemId) {
    const h = hashOf(source, itemId)
    const held = mine.get(h)
    if (!held) return false
    const o = await readOwner(h)
    if (!isMe(o, held.runId)) {
      mine.delete(h)
      return false
    }
    await store.delete(OWNER + h)
    await store.delete(COUNT + h)
    if (held.took) await store.delete(takeKey(h, held.took))
    mine.delete(h)
    return true
  }

  /** Free another window's confirmed-stale claim (the sweep): one window through the take lock. */
  async function free(h, o) {
    if (!(await takeLock(h, o))) return false
    await store.delete(OWNER + h)
    await store.delete(COUNT + h)
    watch.delete(h)
    // The take lock stays until a later sweep finds it with no owner of that run (two sweeps).
    return true
  }

  /** Two sweeps in a row saw `key` with `value`: delete it. Otherwise remember it for the next sweep. */
  async function leftover(key, value, seenNow) {
    seenNow.add(key)
    if (leftovers.has(key) && leftovers.get(key) === value) {
      leftovers.delete(key)
      await store.delete(key)
      return true
    }
    leftovers.set(key, value)
    return false
  }

  async function sweep() {
    const out = { freed: [], cleaned: 0 }
    const all = await store.keys()
    const owners = new Map()
    for (const k of all) if (k.startsWith(OWNER)) owners.set(k.slice(OWNER.length), null)
    for (const h of owners.keys()) {
      const o = await readOwner(h)
      owners.set(h, o)
      if (!o || mine.has(h)) continue
      // This project's own leftover (see claim) is freed at once; another window's only when stale.
      if ((o.project === proj || staleNow(h, o)) && (await free(h, o))) out.freed.push(o)
    }
    for (const h of [...watch.keys()]) if (!owners.get(h)) watch.delete(h)
    const seenNow = new Set()
    const ownerNow = async (h) => (owners.has(h) && owners.get(h) !== null ? owners.get(h) : readOwner(h))
    for (const k of all) {
      if (k.startsWith(COUNT)) {
        const h = k.slice(COUNT.length)
        if (mine.has(h) || (await ownerNow(h))) continue
        if (await leftover(k, await store.get(k), seenNow)) out.cleaned++
      } else if (k.startsWith(TAKE)) {
        const rest = k.slice(TAKE.length)
        const h = rest.slice(0, HASH_HEX)
        const runId = rest.slice(HASH_HEX + 1)
        const held = mine.get(h)
        if (held && held.took === runId) continue
        const o = await ownerNow(h)
        if (o && o.runId === runId) continue
        if (await leftover(k, await store.get(k), seenNow)) out.cleaned++
      }
    }
    for (const k of [...leftovers.keys()]) if (!seenNow.has(k)) leftovers.delete(k)
    return out
  }

  /**
   * One 60 s pass: refresh this window's claims whose `seen` is REFRESH_MS old (re-read first: one
   * another window took over is no longer ours, and is returned in `lost`), and every SWEEP_TICKS
   * passes the sweep. A pass sooner than TICK_MIN_MS after the last one does nothing.
   */
  async function tick() {
    const t = now()
    const out = { lost: [], freed: [], cleaned: 0, errors: [] }
    if (t - lastPassAt < TICK_MIN_MS) return out
    lastPassAt = t
    passes++
    for (const [h, m] of [...mine]) {
      if (t - m.refreshedAt < REFRESH_MS) continue
      try {
        const o = await readOwner(h)
        if (!isMe(o, m.runId)) {
          mine.delete(h)
          out.lost.push({ source: m.source, itemId: m.itemId, rule: m.rule, runId: m.runId, owner: o })
          continue
        }
        await store.set(OWNER + h, { ...o, seen: t })
        m.refreshedAt = t
      } catch (e) {
        out.errors.push(e)
      }
    }
    if (passes % SWEEP_TICKS === 0) {
      try {
        Object.assign(out, await sweep(), { lost: out.lost, errors: out.errors })
      } catch (e) {
        out.errors.push(e)
      }
    }
    return out
  }

  return {
    claim,
    release,
    tick,
    sweep,
    /** Does this window hold the item's claim (as of its last refresh)? */
    owns: (source, itemId) => mine.has(hashOf(source, itemId)),
    /** This window's claims: `[{ source, itemId, runId, rule }]`. */
    owned: () => [...mine.values()].map((m) => ({ source: m.source, itemId: m.itemId, runId: m.runId, rule: m.rule })),
    /** Release every claim this window holds (deactivate): settles when all are done or failed. */
    releaseAll: () => Promise.allSettled([...mine.values()].map((m) => release(m.source, m.itemId))),
  }
}

module.exports = { COUNT, OWNER, TAKE, HASH_HEX, REFRESH_MS, STALE_MS, STALE_TICKS, TICK_MIN_MS, SWEEP_TICKS, RUN_ID, hashOf, takeKey, ownerOf, createClaims }
