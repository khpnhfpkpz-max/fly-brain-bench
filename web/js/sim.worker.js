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
  eng.run(speed, i => { if (accN < acc.length) acc[accN++] = i; });
  post(false);
  setTimeout(tick, 0);
}
