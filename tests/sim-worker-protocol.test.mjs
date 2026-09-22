/* Regression coverage for web/js/sim.worker.js's message protocol -- added
   alongside NEURAL GOD's Neural Inspector (web/god/), which is the first
   thing to add a new command (`cmd:'neighbors'`) to this shared worker.
   Before this file, none of the existing 67 tests loaded sim.worker.js at
   all (only web/defend/survival.worker.js and web/play/play.worker.js were
   covered) -- so this is the only thing standing between a change here and
   silently breaking every page that uses it (the bench, NEURAL GOD).

   Uses the same technique as tests/arena-worker.test.mjs: stub `self` so the
   worker module can be imported directly in Node and driven by calling
   self.onmessage(...) itself. sim.worker.js needs no `fetch` stub (unlike
   survival.worker.js) -- its only import is lif-core.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeConnectome, decodeLabels } from '../web/js/data.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, '..', 'web', 'data');

async function loadWorker() {
  const messages = [];
  const oldSelf = globalThis.self;
  globalThis.self = {
    postMessage: (value) => messages.push(value),
  };
  // a fresh module instance per test, since sim.worker.js keeps its engine
  // and its lazily-built transpose in module-level state
  const mod = await import(`../web/js/sim.worker.js?t=${Date.now()}_${Math.random()}`);
  const send = (data) => self.onmessage({ data });
  return { messages, send, restore: () => { globalThis.self = oldSelf; } };
}

/* ---------------- 1. correctness, on a small hand-built graph ---------------- */
test('cmd:neighbors reports exact degree, synapse and edge data on a known tiny graph', async () => {
  const { messages, send, restore } = await loadWorker();
  try {
    // 4 neurons. 0->1 (3 syn, excitatory), 0->2 (1 syn, inhibitory),
    // 1->2 (2 syn, excitatory), 2->0 (5 syn, excitatory). 3 is isolated.
    const WSYN = 0.275;
    const N = 4;
    const indptr = Int32Array.from([0, 2, 3, 4, 4]);
    const indices = Int32Array.from([1, 2, 2, 0]);
    const weights = Float32Array.from([3 * WSYN, -1 * WSYN, 2 * WSYN, 5 * WSYN]);

    send({ cmd: 'init', N, indptr, indices, weights });
    assert.equal(messages.at(-1).type, 'ready');

    send({ cmd: 'neighbors', i: 0, qid: 1, max: 10 });
    let r = messages.at(-1);
    assert.equal(r.type, 'neighbors'); assert.equal(r.qid, 1); assert.equal(r.i, 0);
    assert.equal(r.outDegree, 2); assert.equal(r.outSynapses, 4);   // 3 + 1
    assert.equal(r.inDegree, 1); assert.equal(r.inSynapses, 5);     // only 2->0
    // sorted by |w| descending: edge to 1 (3 syn) before edge to 2 (1 syn)
    assert.deepEqual(r.out.map(e => [e.j, e.synapses]), [[1, 3], [2, 1]]);
    assert.deepEqual(r.in.map(e => [e.j, e.synapses]), [[2, 5]]);
    assert.ok(r.out[1].w < 0, 'the inhibitory edge (0->2) must report a negative weight');

    send({ cmd: 'neighbors', i: 2, qid: 2, max: 10 });
    r = messages.at(-1);
    assert.equal(r.outDegree, 1); assert.equal(r.outSynapses, 5);
    assert.equal(r.inDegree, 2); assert.equal(r.inSynapses, 3);     // 2 (from 1) + 1 (from 0)
    // sorted by |w| descending: 1->2 (2 syn) before 0->2 (1 syn)
    assert.deepEqual(r.in.map(e => [e.j, e.synapses]), [[1, 2], [0, 1]]);

    send({ cmd: 'neighbors', i: 3, qid: 3, max: 10 });
    r = messages.at(-1);
    assert.equal(r.outDegree, 0); assert.equal(r.inDegree, 0);
    assert.deepEqual(r.out, []); assert.deepEqual(r.in, []);

    // max truncates the returned list but never the reported totals
    send({ cmd: 'neighbors', i: 0, qid: 4, max: 1 });
    r = messages.at(-1);
    assert.equal(r.out.length, 1); assert.equal(r.outDegree, 2); assert.equal(r.outSynapses, 4);
  } finally { restore(); }
});

/* ---------------- 2. cmd:neighbors never touches `running` ---------------- */
test('cmd:neighbors answers immediately in both the on and off half of the duty cycle, and never starts or stops the tick loop itself', async () => {
  const { messages, send, restore } = await loadWorker();
  try {
    const N = 2;
    send({
      cmd: 'init', N,
      indptr: Int32Array.from([0, 0, 0]), indices: Int32Array.from([]), weights: Float32Array.from([]),
    });

    // -- OFF: a neighbors query must not start the tick loop --
    messages.length = 0;
    send({ cmd: 'neighbors', i: 0, qid: 10 });
    assert.equal(messages.length, 1, 'exactly one reply, nothing else');
    assert.equal(messages[0].type, 'neighbors');
    await new Promise(r => setTimeout(r, 60));
    assert.ok(messages.every(m => m.type !== 'frame'), 'still off: no frame messages, the query did not start ticking');

    // -- ON: frames must keep arriving on both sides of a neighbors query --
    messages.length = 0;
    send({ cmd: 'run', on: true });
    await new Promise(r => setTimeout(r, 80));
    const framesBefore = messages.filter(m => m.type === 'frame').length;
    assert.ok(framesBefore > 0, 'ticking produced at least one frame before the query');

    messages.length = 0;
    send({ cmd: 'neighbors', i: 1, qid: 11 });
    assert.equal(messages[0].type, 'neighbors', 'the reply is not deferred behind pending frames');

    await new Promise(r => setTimeout(r, 80));
    const framesAfter = messages.filter(m => m.type === 'frame').length;
    assert.ok(framesAfter > 0, 'ticking continued after the query -- neighbors did not stop it');

    // clean up: stop ticking before the test ends
    send({ cmd: 'run', on: false });
    messages.length = 0;
    await new Promise(r => setTimeout(r, 80));
    assert.equal(messages.filter(m => m.type === 'frame').length, 0, 'run:false actually stopped it');
  } finally { restore(); }
});

/* ---------------- 3. existing commands are byte-for-byte unaffected ---------------- */
test('init/stim/run/reset behave exactly as before: a zero-stimulus run stays at zero, deterministically', async () => {
  const { messages, send, restore } = await loadWorker();
  try {
    send({
      cmd: 'init', N: 5,
      indptr: Int32Array.from([0, 1, 1, 1, 1, 1]), indices: Int32Array.from([1]), weights: Float32Array.from([0.275]),
    });
    send({ cmd: 'stim', idx: [], rates: null });   // no external drive at all
    send({ cmd: 'run', on: true });
    await new Promise(r => setTimeout(r, 150));
    send({ cmd: 'run', on: false });
    const frames = messages.filter(m => m.type === 'frame');
    assert.ok(frames.length > 0, 'ticked normally');
    for (const f of frames) {
      assert.equal(f.spikes.length, 0, 'no external drive -> this LIF engine can never spike on its own');
      assert.equal(f.nActive, 0);
      assert.equal(f.totalSpikes, 0);
    }
    send({ cmd: 'reset' });
    const r = messages.at(-1);
    assert.equal(r.type, 'frame'); assert.equal(r.step, 0); assert.equal(r.t, 0); assert.equal(r.totalSpikes, 0);
  } finally { restore(); }
});

/* ---------------- 4. real scale: init timing + cross-checked correctness ---------------- */
test('at full connectome scale: init stays fast, a neighbors query is correct, and repeating it does not re-decode', async () => {
  const gz = f => gunzipSync(readFileSync(join(DATA, f)));
  const meta = JSON.parse(gz('meta.json.gz').toString());
  const N = meta.n_neurons, E = meta.n_edges;
  const labels = decodeLabels(gz('labels.bin.gz'), N);
  const conn = decodeConnectome(gz('conn.bin.gz'), N, E, gz('sign.bin.gz'));

  // a real, named cell type to query -- DNp01, the giant fibre (2 cells)
  const dnp01Type = meta.dicts.cell_type.indexOf('DNp01');
  assert.ok(dnp01Type >= 0, 'fixture assumption: DNp01 exists in this package');
  const i = labels.cellType.indexOf(dnp01Type);
  assert.ok(i >= 0);

  // independent ground truth, computed directly from the same decoded arrays,
  // not through the worker -- this is what buildIncoming()'s transpose must match
  const expectedOutDegree = conn.indptr[i + 1] - conn.indptr[i];
  let expectedInDegree = 0;
  for (let e = 0; e < E; e++) if (conn.indices[e] === i) expectedInDegree++;

  const { messages, send, restore } = await loadWorker();
  try {
    const t0 = performance.now();
    send({
      cmd: 'init', N, indptr: conn.indptr.slice(), indices: conn.indices.slice(), weights: conn.weights.slice(),
    });
    const initMs = performance.now() - t0;
    assert.equal(messages.at(-1).type, 'ready');
    // generous bound: this is about decoding + Float32Array allocation for
    // 138k neurons / 2.7M edges, nothing neighbors-related runs during init
    assert.ok(initMs < 3000, `init took ${initMs.toFixed(0)} ms, expected it to stay fast`);

    const q0 = performance.now();
    send({ cmd: 'neighbors', i, qid: 1, max: 20 });
    const firstMs = performance.now() - q0;
    const r1 = messages.at(-1);
    assert.equal(r1.outDegree, expectedOutDegree);
    assert.equal(r1.inDegree, expectedInDegree);
    assert.ok(r1.out.every((e, k) => k === 0 || Math.abs(r1.out[k - 1].w) >= Math.abs(e.w)), 'out edges sorted by |w| desc');
    assert.ok(r1.in.every((e, k) => k === 0 || Math.abs(r1.in[k - 1].w) >= Math.abs(e.w)), 'in edges sorted by |w| desc');

    // second query (any neuron): the O(N+E) transpose must not be rebuilt
    const q1 = performance.now();
    send({ cmd: 'neighbors', i: 0, qid: 2, max: 20 });
    const secondMs = performance.now() - q1;
    assert.ok(secondMs < Math.max(5, firstMs), `second query (${secondMs.toFixed(2)} ms) should be far cheaper than the first (${firstMs.toFixed(2)} ms), which pays for the one-time transpose`);
  } finally { restore(); }
});
