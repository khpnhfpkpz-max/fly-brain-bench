/* Regression coverage for NEURAL HACKING (NEURAL GOD Phase 4) -- the
   `intervene` / `experiment` commands added to web/js/sim.worker.js.

   The point of this file is not that the new feature works; it is that the
   *existing* engine is provably untouched by it. sim.worker.js is shared by
   the main bench and by NEURAL GOD, and lif-core.js is shared further still
   (the headless trainer imports it directly), so the three things that must
   be true are asserted here rather than argued:

     A. a seeded run with no intervention is bit-identical to what the same
        seed produced before this feature existed, and an intervention never
        consumes from the engine's own random stream;
     B. the FlyWire connectome is never written, and a forked engine shares
        those arrays rather than copying them;
     C. PARAMS / EPS / dt / derived constants are unchanged throughout.

   Same harness as tests/sim-worker-protocol.test.mjs (stub `self`, import the
   real module, drive it through self.onmessage), plus two extra stubs that
   make the tick loop deterministic: setTimeout is captured so ticks can be
   stepped by hand, and Date.now is advanced by a fixed amount per tick so
   sim.worker.js's wall-clock post() emits exactly one frame per tick. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARAMS, Engine } from '../web/js/lif-core.js';
import { decodeConnectome } from '../web/js/data.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, '..', 'web', 'data');
const WORKER = join(ROOT, '..', 'web', 'js', 'sim.worker.js');
/* The pre-Phase-4 worker, kept so "identical to before the change" can be
   asserted against the actual earlier file rather than against a number
   copied out of one run of it. */
const BASELINE = join(ROOT, 'fixtures', 'sim.worker.phase3.js');

const realSetTimeout = globalThis.setTimeout;
const realDateNow = Date.now;

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* A small but genuinely active graph: a driven input layer feeding a chain,
   with one inhibitory edge, so spikes actually propagate and the hash below
   has something to be sensitive to. */
function fixture(N = 24) {
  const W = PARAMS.WSYN * 400;
  const indptr = new Int32Array(N + 1);
  const indices = [], weights = [];
  for (let i = 0; i < N; i++) {
    indptr[i] = indices.length;
    if (i + 1 < N) { indices.push(i + 1); weights.push(i % 7 === 6 ? -W : W); }
    if (i + 5 < N) { indices.push(i + 5); weights.push(W * 0.5); }
  }
  indptr[N] = indices.length;
  return { N, indptr, indices: Int32Array.from(indices), weights: Float32Array.from(weights) };
}

/* Loads a worker module with Math.random seeded (lif-core.js captures the
   reference in its constructor, so this must be in place before `init`),
   the tick loop under manual control and the clock under ours. */
async function deterministicWorker(path, seed) {
  const messages = [];
  const queue = [];
  const oldSelf = globalThis.self;
  const oldRandom = Math.random;
  let draws = 0, now = 0;

  const rng = mulberry(seed);
  Math.random = () => { draws++; return rng(); };
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms) => {
    if (ms === 0) { queue.push(fn); return queue.length; }     // the tick loop
    return realSetTimeout(fn, ms);                              // anything else, untouched
  };
  globalThis.self = { postMessage: v => messages.push(v) };

  await import(`${path}?t=${Date.now()}_${Math.random()}_${process.hrtime.bigint()}`);
  const send = (data) => self.onmessage({ data });

  return {
    messages, send,
    get draws() { return draws; },
    /* run exactly `n` ticks of sim.worker.js's own tick(), each advancing the
       fake clock past POST_MS so exactly one frame message is emitted */
    step(n) {
      for (let k = 0; k < n; k++) {
        const fn = queue.shift();
        if (!fn) break;
        now += 100;
        fn();
      }
    },
    drain() { while (queue.length) { const fn = queue.shift(); now += 100; fn(); } },
    restore() {
      globalThis.self = oldSelf; Math.random = oldRandom;
      globalThis.setTimeout = realSetTimeout; Date.now = realDateNow;
    },
  };
}

/* The spike train, as the worker itself reported it. */
function trainHash(messages) {
  const h = createHash('sha256');
  for (const m of messages) {
    if (m.type !== 'frame') continue;
    h.update(`s${m.step}|t${m.t}|a${m.nActive}|T${m.totalSpikes}|`);
    h.update(Buffer.from(Int32Array.from(m.spikes).buffer));
  }
  return h.digest('hex');
}

const bytes = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const hashConnectome = c =>
  createHash('sha256').update(bytes(c.indptr)).update(bytes(c.indices)).update(bytes(c.weights)).digest('hex');

/* ============================================================
   A. determinism and non-interference
   ============================================================ */

test('A1 golden hash: with no intervention, the worker produces the exact spike train the pre-Phase-4 worker produced from the same seed', async (t) => {
  const SEED = 424242, TICKS = 120;
  const run = async (path) => {
    const f = fixture();
    const w = await deterministicWorker(path, SEED);
    try {
      w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
      w.send({ cmd: 'stim', idx: Int32Array.from([0, 1, 2]), rates: Float32Array.from([150, 150, 150]) });
      w.send({ cmd: 'run', on: true });
      w.step(TICKS);
      w.send({ cmd: 'run', on: false });
      return { hash: trainHash(w.messages), draws: w.draws,
               spikes: w.messages.filter(m => m.type === 'frame').reduce((a, m) => a + m.spikes.length, 0) };
    } finally { w.restore(); }
  };

  const before = await run(BASELINE);
  const after = await run(WORKER);
  t.diagnostic(`pre-Phase-4 worker : ${before.hash} (${before.spikes} spikes, ${before.draws} engine RNG draws)`);
  t.diagnostic(`current worker     : ${after.hash} (${after.spikes} spikes, ${after.draws} engine RNG draws)`);
  assert.ok(before.spikes > 100, `the fixture must actually spike for this hash to mean anything (got ${before.spikes})`);
  assert.equal(after.hash, before.hash, 'the spike train changed -- Phase 4 is not transparent to an un-intervened run');
  assert.equal(after.draws, before.draws, 'the engine drew a different number of random values than it used to');
});

test('A2 an active intervention never consumes from the engine\'s own random stream', async (t) => {
  const SEED = 99, TICKS = 40;
  const run = async (ops) => {
    const f = fixture();
    const w = await deterministicWorker(WORKER, SEED);
    try {
      w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
      w.send({ cmd: 'stim', idx: Int32Array.from([0, 1, 2]), rates: Float32Array.from([150, 150, 150]) });
      if (ops) w.send({ cmd: 'intervene', ops, seed: 7 });
      w.send({ cmd: 'run', on: true });
      w.step(TICKS);
      w.send({ cmd: 'run', on: false });
      return { draws: w.draws, hash: trainHash(w.messages) };
    } finally { w.restore(); }
  };

  const plain = await run(null);
  const stim = await run([{ i: 10, mode: 'stim', hz: 150 }]);
  const off = await run([{ i: 4, mode: 'off' }]);
  t.diagnostic(`engine RNG draws -- none:${plain.draws} stim:${stim.draws} disable:${off.draws}`);

  assert.equal(stim.draws, plain.draws, 'Stimulate consumed from Math.random -- it must use its own generator');
  assert.equal(off.draws, plain.draws, 'Disable consumed from Math.random');
  assert.notEqual(stim.hash, plain.hash, 'the intervention must actually change the spike train, or this proves nothing');
  assert.notEqual(off.hash, plain.hash);
});

test('A3 the experiment engine matches lif-core.js run directly: the null comparison is identical on both sides', async () => {
  const f = fixture();
  const w = await deterministicWorker(WORKER, 1);
  try {
    w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
    w.send({ cmd: 'stim', idx: Int32Array.from([0, 1, 2]), rates: Float32Array.from([150, 150, 150]) });
    w.send({ cmd: 'experiment', qid: 1, ms: 8, preMs: 4, seed: 31337, ops: [] });
    w.drain();
    const x = w.messages.find(m => m.type === 'experiment');
    assert.ok(x, 'the experiment completed');
    assert.deepEqual([...x.normal.counts], [...x.intervention.counts],
      'with ops:[] the two sides must be bit-identical -- this is what common random numbers buys');
    assert.equal(x.normal.totalSpikes, x.intervention.totalSpikes);
    assert.deepEqual([...x.normal.firstSpikeStep], [...x.intervention.firstSpikeStep]);
    assert.ok(x.normal.totalSpikes > 0, 'the trial must actually produce spikes for that to mean anything');

    /* the same seeded trajectory, computed with lif-core.js directly rather
       than through the worker: the experiment path must not perturb it */
    const e = new Engine({ N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
    e.rand = mulberry(31337);
    e.stimulate(Int32Array.from([0, 1, 2]), Float32Array.from([150, 150, 150]));
    const preSteps = Math.round(4 / e.DT), steps = Math.round(8 / e.DT);
    e.run(preSteps);
    const fork = e.spikeCount.slice();
    e.run(steps);
    const expected = Array.from(e.spikeCount, (v, i) => v - fork[i]);
    assert.deepEqual([...x.normal.counts], expected,
      'the worker\'s Normal side must equal a plain Engine run from the same seed');
  } finally { w.restore(); }
});

/* ============================================================
   B. the connectome is immutable, and forked engines share it
   ============================================================ */

test('B1 the connectome arrays are byte-identical before and after live interventions and a full experiment', async (t) => {
  const f = fixture(40);
  const snapshot = { indptr: f.indptr.slice(), indices: f.indices.slice(), weights: f.weights.slice() };
  const hashBefore = hashConnectome(f);
  assert.equal(hashBefore, hashConnectome(snapshot), 'sanity: the hash is over content, not identity');
  t.diagnostic(`connectome sha256 before: ${hashBefore}`);

  const w = await deterministicWorker(WORKER, 5);
  try {
    w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
    w.send({ cmd: 'stim', idx: Int32Array.from([0, 1, 2]), rates: Float32Array.from([150, 150, 150]) });
    w.send({ cmd: 'intervene', ops: [{ i: 3, mode: 'stim', hz: 300 }, { i: 9, mode: 'suppress', hz: 300 }, { i: 15, mode: 'off' }], seed: 2 });
    w.send({ cmd: 'run', on: true });
    w.step(30);
    w.send({ cmd: 'run', on: false });
    w.send({ cmd: 'experiment', qid: 1, ms: 6, preMs: 3, seed: 11, ops: [{ i: 3, mode: 'stim', hz: 300 }, { i: 15, mode: 'off' }] });
    w.drain();
    assert.ok(w.messages.some(m => m.type === 'experiment'), 'the experiment ran');
    w.send({ cmd: 'intervene', ops: [] });
    w.send({ cmd: 'run', on: true });
    w.step(20);
    w.send({ cmd: 'run', on: false });
  } finally { w.restore(); }

  t.diagnostic(`connectome sha256 after : ${hashConnectome(f)}`);
  assert.equal(hashConnectome(f), hashBefore,
    'a byte of the FlyWire connectome changed -- interventions must never write to it');
  assert.deepEqual([...f.indptr], [...snapshot.indptr]);
  assert.deepEqual([...f.indices], [...snapshot.indices]);
  assert.deepEqual([...f.weights], [...snapshot.weights]);
});

test('B2 at full connectome scale a forked experiment does not duplicate the 22 MB CSR', async (t) => {
  const gz = f => gunzipSync(readFileSync(join(DATA, f)));
  const meta = JSON.parse(gz('meta.json.gz').toString());
  const N = meta.n_neurons, E = meta.n_edges;
  const conn = decodeConnectome(gz('conn.bin.gz'), N, E, gz('sign.bin.gz'));
  const csrBytes = conn.indptr.byteLength + conn.indices.byteLength + conn.weights.byteLength;
  const hashBefore = hashConnectome(conn);
  t.diagnostic(`full connectome: ${N.toLocaleString()} neurons, ${E.toLocaleString()} edges, sha256 ${hashBefore}`);

  const w = await deterministicWorker(WORKER, 3);
  let peak = 0;
  try {
    w.send({ cmd: 'init', N, indptr: conn.indptr, indices: conn.indices, weights: conn.weights });
    assert.equal(w.messages.at(-1).type, 'ready');
    const base = process.memoryUsage().arrayBuffers;
    w.send({ cmd: 'experiment', qid: 1, ms: 1, preMs: 1, seed: 8, ops: [{ i: 0, mode: 'stim', hz: 150 }] });
    // measure while both clones are alive: after the fork, before the result
    const seen = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); };
    seen();
    w.drain();
    seen();
    const x = w.messages.find(m => m.type === 'experiment');
    assert.ok(x, 'the full-scale experiment completed');
    t.diagnostic(`CSR is ${(csrBytes / 1e6).toFixed(1)} MB; peak extra ArrayBuffer bytes during the fork: ${(peak / 1e6).toFixed(1)} MB`);
    assert.ok(peak < csrBytes,
      `two forked engines grew ArrayBuffers by ${(peak / 1e6).toFixed(1)} MB; copying the CSR even once would cost ${(csrBytes / 1e6).toFixed(1)} MB, so it is being shared`);
  } finally { w.restore(); }
  assert.equal(hashConnectome(conn), hashBefore, 'full-scale connectome unchanged');
});

/* ============================================================
   C. model parameters are untouched
   ============================================================ */

test('C1 PARAMS, EPS, dt and the derived constants are unchanged by an intervention', async () => {
  const frozen = JSON.parse(JSON.stringify(PARAMS));
  const f = fixture();
  const w = await deterministicWorker(WORKER, 12);
  try {
    w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
    w.send({ cmd: 'intervene', ops: [{ i: 2, mode: 'suppress', hz: 300 }, { i: 6, mode: 'off' }], seed: 4 });
    w.send({ cmd: 'run', on: true });
    w.step(25);
    w.send({ cmd: 'run', on: false });
    w.send({ cmd: 'experiment', qid: 1, ms: 4, preMs: 2, seed: 5, ops: [{ i: 2, mode: 'off' }] });
    w.drain();
  } finally { w.restore(); }
  assert.deepEqual(JSON.parse(JSON.stringify(PARAMS)), frozen, 'PARAMS was mutated');

  // the constants the engine derives from them, recomputed the way lif-core does
  const e = new Engine({ N: 2, indptr: Int32Array.from([0, 0, 0]), indices: Int32Array.from([]), weights: Float32Array.from([]) });
  assert.equal(e.DT, 0.1);
  assert.equal(e.EPS, 0.02);
  assert.equal(e.RFC_STEPS, Math.max(1, Math.round(PARAMS.TRFC / 0.1)));
  assert.equal(e.DLY_STEPS, Math.max(1, Math.round(PARAMS.TDLY / 0.1)));
  assert.equal(e.W_POI, PARAMS.WSYN * PARAMS.FPOI);
  assert.equal(e.P_POI, PARAMS.RPOI * 0.1 / 1000);
});

/* ============================================================
   D. the interventions themselves behave as specified
   ============================================================ */

test('D1 Disable makes a neuron unspikeable however hard it is driven, and releasing it restores normal firing without a rebound burst', async () => {
  const f = fixture();
  const stimIdx = Int32Array.from([0, 1, 2]), stimHz = Float32Array.from([150, 150, 150]);
  const perNeuron = (messages) => {
    const c = new Int32Array(f.N);
    for (const m of messages) if (m.type === 'frame') for (const i of m.spikes) c[i]++;
    return c;
  };

  const w = await deterministicWorker(WORKER, 77);
  try {
    w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
    w.send({ cmd: 'stim', idx: stimIdx, rates: stimHz });

    /* Neuron 12 -- deliberately not 7/14/21, which sit behind the fixture's
       inhibitory chain edges (i % 7 === 6) and are near-silent by design. */
    const T = 12;
    w.send({ cmd: 'run', on: true }); w.step(60); w.send({ cmd: 'run', on: false });
    const baseline = perNeuron(w.messages);
    assert.ok(baseline[T] > 3, `fixture assumption: neuron ${T} fires steadily (got ${baseline[T]})`);
    const baselinePerTick = baseline[T] / 60;

    // disabled, while the rest of the network keeps being driven hard
    w.messages.length = 0;
    w.send({ cmd: 'intervene', ops: [{ i: T, mode: 'off' }], seed: 1 });
    w.send({ cmd: 'intervene', ops: [{ i: T, mode: 'off' }], seed: 1 });   // idempotent re-send
    w.send({ cmd: 'run', on: true }); w.step(200); w.send({ cmd: 'run', on: false });
    const disabled = perNeuron(w.messages);
    assert.equal(disabled[T], 0, 'a disabled neuron spiked');
    assert.ok(disabled.reduce((a, b) => a + b, 0) > 0, 'the rest of the network kept running');

    // it is held off far longer than the engine's own refractory period, so
    // this is the hold being re-armed, not one ordinary refractory window
    assert.ok(200 * 8 * 0.1 > PARAMS.TRFC * 10, 'the silence outlasts a natural refractory period by orders of magnitude');

    // released: fires again, and does not discharge a rebound burst
    w.messages.length = 0;
    w.send({ cmd: 'intervene', ops: [] });
    w.send({ cmd: 'run', on: true }); w.step(60); w.send({ cmd: 'run', on: false });
    const released = perNeuron(w.messages);
    assert.ok(released[T] > 0, 'a released neuron never fired again -- the refractory hold was not cleared');
    const firstTick = w.messages.filter(m => m.type === 'frame')[0];
    const burst = [...firstTick.spikes].filter(i => i === T).length;
    assert.ok(burst <= Math.max(1, Math.ceil(baselinePerTick * 2)),
      `release produced a rebound burst of ${burst} spikes in the first tick (normal rate is ${baselinePerTick.toFixed(2)}/tick)`);
  } finally { w.restore(); }
});

test('D2 Stimulate at the engine\'s own default rate matches the engine\'s own default drive, and Suppress reduces firing', async () => {
  const f = fixture();
  const countOf = (messages, i) => messages.filter(m => m.type === 'frame')
    .reduce((a, m) => a + [...m.spikes].filter(x => x === i).length, 0);

  // neuron 12 is far enough down the chain to be quiet without help
  const run = async (mode) => {
    const w = await deterministicWorker(WORKER, 2024);
    try {
      w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
      if (mode === 'engine') w.send({ cmd: 'stim', idx: Int32Array.from([12]), rates: null });  // PARAMS.RPOI
      else {
        w.send({ cmd: 'stim', idx: Int32Array.from([]), rates: null });
        if (mode !== 'none') w.send({ cmd: 'intervene', ops: [{ i: 12, mode, hz: PARAMS.RPOI }], seed: 61 });
      }
      w.send({ cmd: 'run', on: true }); w.step(120); w.send({ cmd: 'run', on: false });
      return countOf(w.messages, 12);
    } finally { w.restore(); }
  };

  const none = await run('none');
  const engineDrive = await run('engine');
  const stim = await run('stim');
  const suppress = await run('suppress');

  assert.equal(none, 0, 'with no drive at all this neuron must be silent');
  assert.ok(engineDrive > 0, 'the engine\'s own default stimulus makes it fire');
  // Same Poisson machinery, same rate, different generator -- so the same
  // order of magnitude, not the same integer.
  assert.ok(stim > engineDrive * 0.5 && stim < engineDrive * 1.5,
    `Stimulate at ${PARAMS.RPOI} Hz gave ${stim} spikes vs the engine's own drive ${engineDrive}; expected the same mechanism, not a new constant`);
  assert.equal(suppress, 0, 'an inhibitory barrage on an otherwise silent cell cannot make it fire');
});

test('D3 a neuron\'s own noise draws do not change when other neurons are added to the intervention set', async () => {
  const f = fixture();
  const run = async (ops) => {
    const w = await deterministicWorker(WORKER, 31);
    try {
      w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
      w.send({ cmd: 'stim', idx: Int32Array.from([]), rates: null });
      w.send({ cmd: 'experiment', qid: 1, ms: 20, preMs: 0, seed: 555, ops });
      w.drain();
      return w.messages.find(m => m.type === 'experiment');
    } finally { w.restore(); }
  };
  const alone = await run([{ i: 0, mode: 'stim', hz: 150 }]);
  const withOthers = await run([{ i: 0, mode: 'stim', hz: 150 }, { i: 18, mode: 'stim', hz: 150 }]);
  assert.equal(withOthers.intervention.counts[0], alone.intervention.counts[0],
    'adding a second intervention shifted the first one\'s random draws -- the two configurations are then not comparable');
  assert.equal(withOthers.intervention.firstSpikeStep[0], alone.intervention.firstSpikeStep[0]);
  assert.ok(withOthers.intervention.counts[18] > 0, 'the second intervention did take effect');
});

/* ============================================================
   E. the existing protocol still behaves exactly as before
   ============================================================ */

test('E1 intervene/experiment never change `running`, and neighbors still answers during an experiment', async () => {
  const f = fixture();
  const w = await deterministicWorker(WORKER, 8);
  try {
    w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });

    // stopped: neither command may start the tick loop
    w.messages.length = 0;
    w.send({ cmd: 'intervene', ops: [{ i: 1, mode: 'stim', hz: 150 }], seed: 1 });
    w.send({ cmd: 'experiment', qid: 1, ms: 2, preMs: 1, seed: 1, ops: [{ i: 1, mode: 'stim', hz: 150 }] });
    w.drain();
    assert.equal(w.messages.filter(m => m.type === 'frame').length, 0,
      'a frame was posted while stopped -- something started the tick loop');

    // running: an experiment must not stop it
    w.send({ cmd: 'run', on: true });
    w.step(3);
    assert.ok(w.messages.filter(m => m.type === 'frame').length > 0, 'ticking');
    w.messages.length = 0;
    w.send({ cmd: 'experiment', qid: 2, ms: 2, preMs: 1, seed: 1, ops: [] });
    w.send({ cmd: 'neighbors', i: 1, qid: 90, max: 5 });
    assert.equal(w.messages.filter(m => m.type === 'neighbors').length, 1,
      'the neighbors reply was deferred or dropped while an experiment was in flight');
    w.step(3);
    assert.ok(w.messages.filter(m => m.type === 'frame').length > 0, 'ticking continued across the experiment');
    w.send({ cmd: 'run', on: false });
    w.messages.length = 0;
    w.step(3);
    assert.equal(w.messages.filter(m => m.type === 'frame').length, 0, 'run:false still stops it');
  } finally { w.restore(); }
});

test('E2 intervene is declarative and idempotent; an empty op list is a full reset', async () => {
  const f = fixture();
  const w = await deterministicWorker(WORKER, 9);
  try {
    w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
    w.send({ cmd: 'intervene', ops: [{ i: 1, mode: 'stim', hz: 150 }, { i: 2, mode: 'off' }], seed: 1 });
    let r = w.messages.at(-1);
    assert.equal(r.type, 'intervention'); assert.equal(r.count, 2);
    assert.deepEqual(r.ops, [{ i: 1, mode: 'stim', hz: 150 }, { i: 2, mode: 'off', hz: 0 }]);

    // out-of-range indices and unknown modes are dropped, not crashed on
    w.send({ cmd: 'intervene', ops: [{ i: -1, mode: 'stim', hz: 5 }, { i: 9e9, mode: 'off' }, { i: 3, mode: 'nonsense' }] });
    assert.equal(w.messages.at(-1).count, 0);

    w.send({ cmd: 'intervene', ops: [] });
    assert.equal(w.messages.at(-1).count, 0);
    assert.deepEqual(w.messages.at(-1).ops, []);
  } finally { w.restore(); }
});

test('E3 a second experiment while one is running is refused rather than corrupting the first, and cancel stops it', async () => {
  const f = fixture();
  const w = await deterministicWorker(WORKER, 15);
  try {
    w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
    w.send({ cmd: 'stim', idx: Int32Array.from([0]), rates: null });
    w.send({ cmd: 'experiment', qid: 1, ms: 50, preMs: 50, seed: 1, ops: [{ i: 0, mode: 'stim', hz: 150 }] });
    w.send({ cmd: 'experiment', qid: 2, ms: 50, preMs: 50, seed: 1, ops: [] });
    const err = w.messages.find(m => m.type === 'experimentError');
    assert.ok(err && err.qid === 2 && err.reason === 'busy', 'the second experiment was refused');

    w.send({ cmd: 'experimentCancel', qid: 1 });
    assert.equal(w.messages.at(-1).type, 'experimentCancelled');
    w.drain();
    assert.ok(!w.messages.some(m => m.type === 'experiment'), 'a cancelled experiment must not deliver a result');

    // and a fresh one can start afterwards
    w.send({ cmd: 'experiment', qid: 3, ms: 2, preMs: 1, seed: 1, ops: [] });
    w.drain();
    assert.ok(w.messages.some(m => m.type === 'experiment' && m.qid === 3), 'a new experiment runs after a cancel');
  } finally { w.restore(); }
});

test('E4 reaction time is reported as an exact step index, or as "never" -- never as a bound', async () => {
  const f = fixture();
  const w = await deterministicWorker(WORKER, 21);
  try {
    w.send({ cmd: 'init', N: f.N, indptr: f.indptr, indices: f.indices, weights: f.weights });
    w.send({ cmd: 'stim', idx: Int32Array.from([]), rates: null });
    w.send({ cmd: 'experiment', qid: 1, ms: 30, preMs: 5, seed: 909, ops: [{ i: 0, mode: 'stim', hz: 200 }] });
    w.drain();
    const x = w.messages.find(m => m.type === 'experiment');
    const fs = x.intervention.firstSpikeStep;
    assert.equal(x.normal.firstSpikeStep[0], -1, 'unstimulated, neuron 0 never fires');
    assert.ok(fs[0] >= 0 && fs[0] < x.steps, 'stimulated, it fires inside the window at a definite step');
    assert.ok(fs[1] > fs[0], 'the downstream neuron fires strictly after the one driving it');
    // the whole array is either -1 or a step inside the window: no sentinel
    // that could be mistaken for "at least this long"
    for (const v of fs) assert.ok(v === -1 || (v >= 0 && v < x.steps), `bad first-spike value ${v}`);
  } finally { w.restore(); }
});
