/* NEURAL GOD -- Experience Learning Layer: the Value Table and Experience Log.

   Two independent structures, both O(1) per operation, neither ever scanned
   in full on a hot path:

   - Value Table: `${state}|${action}` -> a value, updated with the plain
     rule the spec asked for, `value += learningRate * (reward - value)`.
     With 9 states x 9 actions (see experience-learning.js) this is at most
     81 cells -- looping all of them every tick would already be cheap, but
     memoryDecay is applied lazily instead (a cell remembers the tick it was
     last touched; decay is folded in only when that cell is next read or
     written), so the cost of this structure never depends on how much of
     the table has been visited, and stays exactly the same if the state or
     action space ever grows.

   - Experience Log: a fixed-size ring buffer (default 500 entries). Writing
     is O(1) (overwrite the next slot, wrap the index); the UI only ever asks
     for "the last N", which is O(N) for a small N, never a scan of the
     whole buffer. Nothing here is swept once per frame or once per tick. */
const DEFAULT_CAPACITY = 500;

export function createExperienceStore({ learningRate = 0.15, memoryDecay = 0.995, capacity = DEFAULT_CAPACITY } = {}) {
  let cfg = { learningRate, memoryDecay };
  const table = new Map();                 // key -> { value, lastTick }
  let log = new Array(capacity);
  let logHead = 0, logCount = 0;
  let tick = 0;                             // logical tick, advanced once per call to advanceTick() (experience-learning.js calls it once per readout, i.e. 5 Hz) -- deterministic and independent of wall-clock time, so tests never need to fake a clock
  let totalReward = 0;

  const keyOf = (state, action) => `${state}|${action}`;

  function decayed(cell) {
    if (!cell) return 0;
    const dt = tick - cell.lastTick;
    return dt > 0 ? cell.value * Math.pow(cfg.memoryDecay, dt) : cell.value;
  }

  function getValue(state, action) {
    return decayed(table.get(keyOf(state, action)));
  }

  function updateValue(state, action, reward) {
    const key = keyOf(state, action);
    const current = decayed(table.get(key));
    const next = current + cfg.learningRate * (reward - current);
    table.set(key, { value: next, lastTick: tick });
    return next;
  }

  function recentExperiences(n = 10) {
    const out = [];
    const count = Math.min(n, logCount, log.length);
    for (let i = 0; i < count; i++) {
      out.push(log[(logHead - 1 - i + log.length) % log.length]);
    }
    return out;
  }

  return {
    advanceTick() { tick++; },
    get tick() { return tick; },

    getValue,

    /* Records one experience and folds it into the value table in the same
       call -- the two are never allowed to drift apart (an entry in the log
       always corresponds to exactly one value-table update, and vice versa
       for anything that reached this function). */
    experience({ state, action, event, reward, resultingBehavior, timestamp }) {
      const value = updateValue(state, action, reward);
      totalReward += reward;
      log[logHead] = { timestamp, state, action, event, reward, resultingBehavior, value };
      logHead = (logHead + 1) % log.length;
      logCount = Math.min(logCount + 1, log.length);
      return value;
    },

    recentExperiences,
    get experienceCount() { return logCount; },
    get totalReward() { return totalReward; },

    /* Every cell that has ever been written, decay-adjusted to the current
       tick -- for the LEARNING panel's "cells touched" readout and for
       tests. Only ever called at ~5-10 Hz by the UI, never per-frame, and
       is bounded by the state/action space size (<=81 in this build), not
       by how many experiences have been logged. */
    allValues() {
      const out = {};
      for (const [key, cell] of table) out[key] = decayed(cell);
      return out;
    },

    configure(next) { cfg = { ...cfg, ...next }; },
    getConfig() { return { ...cfg }; },

    reset() {
      table.clear();
      log = new Array(capacity);
      logHead = 0; logCount = 0; tick = 0; totalReward = 0;
    },

    serialize() {
      return JSON.stringify({
        version: 1,
        tick, totalReward, cfg,
        table: [...table.entries()],
        log: recentExperiences(logCount),
      });
    },

    /* Returns false (and leaves the store untouched) on anything that does
       not look like this store's own serialize() output -- a save file from
       an incompatible version should never partially apply. */
    loadFrom(json) {
      let parsed;
      try { parsed = JSON.parse(json); } catch (_) { return false; }
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.table)) return false;
      table.clear();
      for (const [key, cell] of parsed.table) table.set(key, cell);
      tick = parsed.tick || 0;
      totalReward = parsed.totalReward || 0;
      cfg = { ...cfg, ...(parsed.cfg || {}) };
      log = new Array(capacity);
      logHead = 0; logCount = 0;
      for (const entry of (parsed.log || []).slice().reverse()) {
        log[logHead] = entry;
        logHead = (logHead + 1) % log.length;
        logCount = Math.min(logCount + 1, log.length);
      }
      return true;
    },
  };
}
