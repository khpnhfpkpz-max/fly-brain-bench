/* Web-worker wrapper around the shared engine in lif-core.js.

   The engine itself lives in one place so the browser and the headless trainer
   cannot drift apart; this file only handles messages and paces the posts. */

import { Engine, PARAMS } from './lif-core.js';

let eng = null, running = false, speed = 8;
let acc = null, accN = 0, lastPost = 0;
const POST_MS = 33;      // wall-clock cadence for frames to the main thread

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.cmd === 'init') {
    eng = new Engine({ N: m.N, indptr: m.indptr, indices: m.indices,
                       weights: m.weights, dt: m.dt || 0.1 });
    self.postMessage({ type: 'ready', N: m.N, edges: m.indices.length });
    return;
  }
  if (!eng) return;
  if (m.cmd === 'stim') {
    eng.stimulate(m.idx, m.rates);
    // The bench wants a clean slate per stimulus, so reset stays the default. A
    // caller that samples the same brain over and over must pass reset:false —
    // resetting rewinds the step counter and therefore the clock this worker
    // reports, and anything pacing itself on that clock then waits forever.
    if (m.reset !== false) eng.reset();
    return;
  }
  if (m.cmd === 'run') { const was = running; running = m.on; if (running && !was) tick(); return; }
  if (m.cmd === 'speed') { speed = m.value; return; }
  if (m.cmd === 'eps') { eng.EPS = m.v; return; }
  if (m.cmd === 'reset') { eng.reset(); post(true); return; }
  if (m.cmd === 'neighbors') { answerNeighbors(m); return; }
  if (m.cmd === 'intervene') { setIntervention(m); return; }
  if (m.cmd === 'experiment') { startExperiment(m); return; }
  if (m.cmd === 'experimentCancel') { cancelExperiment(m); return; }
};

/* ---------------- cmd:'neighbors' (query-only; never touches `running`) ----------------

   Added for the Neural Inspector's Connections panel. Reads the CSR the engine
   already holds (indptr/indices/weights) and, on the first call only, builds
   its transpose (who points *at* this neuron) since the forward CSR alone
   cannot answer that. Nothing above this line changes: init/stim/run/speed/
   eps/reset are untouched, this only adds a seventh, independent branch that
   answers a question and returns -- it never starts, stops, or paces tick(). */
let inPtr = null, inSrc = null, inW = null;

function buildIncoming() {
  if (inPtr) return;                    // built once, lazily, on first query
  const N = eng.N, E = eng.indices.length;
  const counts = new Int32Array(N + 1);
  for (let e = 0; e < E; e++) counts[eng.indices[e] + 1]++;
  for (let i = 0; i < N; i++) counts[i + 1] += counts[i];
  const cursor = counts.slice(0, N);
  inSrc = new Int32Array(E);
  inW = new Float32Array(E);
  for (let i = 0; i < N; i++) {
    for (let e = eng.indptr[i]; e < eng.indptr[i + 1]; e++) {
      const j = eng.indices[e];
      const pos = cursor[j]++;
      inSrc[pos] = i;
      inW[pos] = eng.weights[e];
    }
  }
  inPtr = counts;
}

/* Synapse counts are recovered exactly, not estimated: decodeConnectome
   (web/js/data.js) packs each edge as round(synapses) * (WSYN or -WSYN), so
   dividing back out and rounding recovers the original integer. */
function synapsesOf(w) { return Math.round(Math.abs(w) / PARAMS.WSYN); }

function topEdges(otherArr, wArr, start, end, max) {
  const n = end - start;
  const order = [];
  for (let e = start; e < end; e++) order.push(e);
  order.sort((a, b) => Math.abs(wArr[b]) - Math.abs(wArr[a]));
  const out = [];
  for (let k = 0; k < Math.min(max, n); k++) {
    const e = order[k];
    out.push({ j: otherArr[e], w: wArr[e], synapses: synapsesOf(wArr[e]) });
  }
  return out;
}

function synapseSum(wArr, start, end) {
  let s = 0;
  for (let e = start; e < end; e++) s += synapsesOf(wArr[e]);
  return s;
}

function answerNeighbors(m) {
  const i = m.i, max = m.max || 64;
  buildIncoming();
  const oS = eng.indptr[i], oE = eng.indptr[i + 1];
  const iS = inPtr[i], iE = inPtr[i + 1];
  self.postMessage({
    type: 'neighbors', qid: m.qid, i,
    outDegree: oE - oS, inDegree: iE - iS,
    outSynapses: synapseSum(eng.weights, oS, oE),
    inSynapses: synapseSum(inW, iS, iE),
    out: topEdges(eng.indices, eng.weights, oS, oE, max),
    in: topEdges(inSrc, inW, iS, iE, max),
  });
}

function post(force) {
  const now = Date.now();
  if (!force && now - lastPost < POST_MS) return;
  lastPost = now;
  const buf = new Int32Array(accN);
  buf.set(acc.subarray(0, accN));
  accN = 0;
  self.postMessage({ type: 'frame', spikes: buf, step: eng.step, t: eng.t,
                     nActive: eng.nActive, totalSpikes: eng.totalSpikes }, [buf.buffer]);
}

function tick() {
  if (!running) return;
  // Spikes accumulate across sub-steps and go out on a wall clock: under load a
  // single tick carries six figures of them, and posting each one starved the
  // main thread badly enough to drop the page to about one frame per second.
  if (!acc) acc = new Int32Array(1 << 18);
  const sink = i => { if (accN < acc.length) acc[accN++] = i; };
  /* With no live intervention configured this is the identical call the
     worker has always made -- liveOps.length === 0 is the untouched path. */
  if (liveOps.length === 0) eng.run(speed, sink);
  else for (let s = 0; s < speed; s++) { applyIntervention(eng, liveOps, liveRnds); eng.run(1, sink); }
  post(false);
  setTimeout(tick, 0);
}

/* ---------------- NEURAL HACKING: cmd:'intervene' / cmd:'experiment' ----------------

   Added for NEURAL GOD's Phase 4. Everything above this line is unchanged
   apart from three dispatch lines in onmessage and the `liveOps.length === 0`
   branch in tick() -- which is the branch the worker has always taken, so a
   session that never intervenes runs exactly the code it ran before.

   Three invariants this section is built around, all verified against
   lif-core.js (see tests/intervention-worker.test.mjs, which proves them
   rather than assuming them):

   1. The connectome (indptr/indices/weights) is never written by the engine
      -- advance() only reads it (`g[j] += weights[e]`). So a second Engine
      can *share* those three arrays instead of copying 22 MB of them, and
      the FlyWire wiring stays immutable no matter what an intervention does.
   2. Engine.rand has exactly one call site (the Poisson stimulus draw). An
      intervention that uses its own generator therefore leaves the engine's
      own random stream bit-identical, intervened or not.
   3. A neuron with rfc[i] > 0 is skipped whole in advance() -- it cannot
      spike regardless of its input. That, not a weight edit, is how Disable
      is implemented.

   Deliberately NOT used: isStim[i]. Setting it would add drive, but it also
   exempts the neuron from the refractory period (lif-core.js L109) and from
   active-set pruning (L117) -- i.e. it changes the dynamics, not just the
   input. Interventions stay at the level of "add input" / "hold output off". */

/* mulberry32, copied from web/defend/neural-rig.js (which already assigns a
   seeded generator to an Engine the same way) rather than imported, so this
   worker keeps its single dependency on lif-core.js. */
function mulberry(a) {
  const rng = function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  rng.state = () => a >>> 0;
  rng.setState = value => { a = value | 0; };
  return rng;
}

const RFC_HOLD = 32767;          // Int16Array max; re-armed every sub-step so it never expires
let liveOps = [];                // the live intervention set; [] means "untouched engine"
let liveOff = new Set();         // which neurons are currently held off, so releases can be undone
let liveRnds = [];               // one generator per entry of liveOps
let liveSeed = 1;

/* One sub-step of intervention, applied just before engine.advance().
   `stim`/`suppress` reuse the engine's own Poisson machinery (W_POI at
   hz*dt/1000) so no new constant enters the model; `off` re-arms the
   refractory counter the engine already honours.

   `rnds` is one generator *per neuron*, not one shared stream: with a single
   stream, adding a second intervention shifts every draw the first one would
   have made, so two configurations could not be compared against the same
   noise. Seeding per neuron index (see rngsFor) keeps each neuron's draws
   identical no matter what else is intervened on. */
function applyIntervention(e, ops, rnds) {
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k], i = op.i;
    if (op.mode === 'off') {
      e.rfc[i] = RFC_HOLD;
      e.v[i] = PARAMS.VRST;
      e.g[i] = 0;                // so releasing it cannot fire a burst of stored charge
      e.touch(i);
    } else {
      const p = op.hz * e.DT / 1000;
      if (p > 0 && rnds[k]() < p) {
        e.v[i] += (op.mode === 'suppress' ? -e.W_POI : e.W_POI);
        e.touch(i);
      }
    }
  }
}

/* Derived from (seed, neuron index) only -- deliberately not from the op's
   position in the list or its mode, so a neuron keeps its own noise draw when
   other neurons are added to the set or when it is flipped stim <-> suppress. */
function rngsFor(ops, seed) {
  return ops.map(op => mulberry((seed ^ Math.imul(op.i + 1, 0x9E3779B1)) >>> 0));
}

/* Undo an `off` hold: without this the engine would keep the neuron silent
   for another RFC_HOLD sub-steps (3.28 biological seconds at dt=0.1ms). */
function releaseOff(e, i) {
  e.rfc[i] = 0;
  e.v[i] = PARAMS.VRST;
  e.g[i] = 0;
}

function normaliseOps(ops) {
  const out = [];
  for (const op of ops || []) {
    const i = op.i | 0;
    if (i < 0 || i >= eng.N) continue;
    if (op.mode === 'off') out.push({ i, mode: 'off', hz: 0 });
    else if (op.mode === 'stim' || op.mode === 'suppress') {
      out.push({ i, mode: op.mode, hz: Math.max(0, +op.hz || 0) });
    }
  }
  return out;
}

/* Declarative: every message carries the whole intervention set, so the main
   thread's UI state is the single source of truth and the two cannot drift.
   ops:[] clears everything -- that is Reset. Never touches `running`. */
function setIntervention(m) {
  const ops = normaliseOps(m.ops);
  const nextOff = new Set();
  for (const op of ops) if (op.mode === 'off') nextOff.add(op.i);
  for (const i of liveOff) if (!nextOff.has(i)) releaseOff(eng, i);
  liveOff = nextOff;
  liveOps = ops;
  if (m.seed !== undefined) liveSeed = m.seed >>> 0;
  liveRnds = rngsFor(ops, liveSeed);
  self.postMessage({ type: 'intervention', count: ops.length, ops });
}

/* ---------------- paired A/B experiment ----------------

   Normal and Intervention are forked from one bit-identical state and given
   the same seeded generator, so the background Poisson noise is *the same
   draw* on both sides (common random numbers). Any difference in the result
   is the intervention and nothing else -- which two permanently co-running
   engines could not give you, since they would be drawing independently. */
function cloneEngine(src) {
  // shares indptr/indices/weights by reference: invariant 1 above
  const e = new Engine({ N: src.N, indptr: src.indptr, indices: src.indices,
                         weights: src.weights, dt: src.DT });
  e.EPS = src.EPS;
  e.v.set(src.v); e.g.set(src.g); e.rfc.set(src.rfc);
  e.inActive.set(src.inActive); e.isStim.set(src.isStim);
  e.spikeCount.set(src.spikeCount); e.active.set(src.active);
  e.nActive = src.nActive; e.step = src.step; e.totalSpikes = src.totalSpikes;
  e.stimList = src.stimList; e.stimRate = src.stimRate;   // read-only in advance()
  e.ring = src.ring.map(r => ({ buf: r.buf.slice(), n: r.n }));
  return e;
}

let exp = null;

function startExperiment(m) {
  if (exp) { self.postMessage({ type: 'experimentError', qid: m.qid, reason: 'busy' }); return; }
  const dt = eng.DT;
  const ms = Math.max(dt, +m.ms || 0);
  const preMs = m.preMs === undefined ? ms : Math.max(0, +m.preMs || 0);
  const seed = (m.seed === undefined ? 1 : m.seed) >>> 0;
  const ops = normaliseOps(m.ops);

  const pre = cloneEngine(eng);
  pre.rand = mulberry(seed);
  exp = {
    qid: m.qid, dt, ms, preMs, ops, seed,
    preSteps: Math.round(preMs / dt), steps: Math.round(ms / dt),
    phase: 'pre', done: 0,
    pre, normal: null, interv: null,
    preStart: eng.spikeCount.slice(), preStartTotal: eng.totalSpikes,
    baseline: null, forkCounts: null, forkTotal: 0,
    normalFs: null, intervFs: null,
  };
  if (exp.preSteps === 0) forkExperiment();
  setTimeout(expChunk, 0);
}

function cancelExperiment(m) {
  if (!exp || (m.qid !== undefined && m.qid !== exp.qid)) return;
  const qid = exp.qid;
  exp = null;
  self.postMessage({ type: 'experimentCancelled', qid });
}

function forkExperiment() {
  const x = exp;
  x.baseline = deltaCounts(x.pre.spikeCount, x.preStart);
  x.baselineTotal = x.pre.totalSpikes - x.preStartTotal;
  x.forkCounts = x.pre.spikeCount.slice();
  x.forkTotal = x.pre.totalSpikes;
  const state = x.pre.rand.state();
  x.normal = cloneEngine(x.pre); x.normal.rand = mulberry(state);
  x.interv = cloneEngine(x.pre); x.interv.rand = mulberry(state);
  x.normalFs = new Int32Array(eng.N).fill(-1);
  x.intervFs = new Int32Array(eng.N).fill(-1);
  x.intervRnds = rngsFor(x.ops, x.seed);
  x.pre = null;
  x.phase = 'normal'; x.done = 0;
}

function deltaCounts(now, before) {
  const out = new Int32Array(now.length);
  for (let i = 0; i < out.length; i++) out[i] = now[i] - before[i];
  return out;
}

function advanceOne(e, fs, s, ops, rnds) {
  if (ops && ops.length) applyIntervention(e, ops, rnds);
  e.advance();
  if (fs) for (let k = 0; k < e.outCount; k++) { const i = e.outIdx[k]; if (fs[i] < 0) fs[i] = s; }
}

/* Runs in short wall-clock slices with a yield in between, so `neighbors`
   queries, `stim` changes and the main thread all stay responsive while an
   experiment is in flight. */
function expChunk() {
  if (!exp) return;
  const deadline = Date.now() + 12;
  do {
    for (let b = 0; b < 8; b++) {
      if (!exp) return;
      if (!expStep()) { finishExperiment(); return; }
    }
  } while (Date.now() < deadline);
  self.postMessage({ type: 'experimentProgress', qid: exp.qid,
                     phase: exp.phase, done: exp.done,
                     total: exp.phase === 'pre' ? exp.preSteps : exp.steps });
  setTimeout(expChunk, 0);
}

/* one sub-step of whichever phase is current; false once all three are done */
function expStep() {
  const x = exp;
  if (x.phase === 'pre') {
    advanceOne(x.pre, null, x.done, null, null);
    if (++x.done >= x.preSteps) forkExperiment();
    return true;
  }
  if (x.phase === 'normal') {
    advanceOne(x.normal, x.normalFs, x.done, null, null);
    if (++x.done >= x.steps) { x.phase = 'interv'; x.done = 0; }
    return true;
  }
  advanceOne(x.interv, x.intervFs, x.done, x.ops, x.intervRnds);
  return ++x.done < x.steps;
}

function finishExperiment() {
  const x = exp;
  exp = null;
  const normalCounts = deltaCounts(x.normal.spikeCount, x.forkCounts);
  const intervCounts = deltaCounts(x.interv.spikeCount, x.forkCounts);
  self.postMessage({
    type: 'experiment', qid: x.qid, ms: x.ms, preMs: x.preMs, steps: x.steps, dt: x.dt,
    ops: x.ops,
    baseline: { counts: x.baseline, totalSpikes: x.baselineTotal },
    normal: { counts: normalCounts, firstSpikeStep: x.normalFs, totalSpikes: x.normal.totalSpikes - x.forkTotal },
    intervention: { counts: intervCounts, firstSpikeStep: x.intervFs, totalSpikes: x.interv.totalSpikes - x.forkTotal },
  }, [x.baseline.buffer, normalCounts.buffer, intervCounts.buffer, x.normalFs.buffer, x.intervFs.buffer]);
}
