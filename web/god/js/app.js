/* NEURAL GOD -- Phase 1.

   "You don't control the creature. You control its world and its brain."

   This boots the *same* Brain Engine as the main bench (web/js/lif-core.js,
   run inside web/js/sim.worker.js, never touched or duplicated here), reuses
   the same connectome data, the same stimulus presets (web/js/presets.js)
   and the same decoder (web/js/decoder.js). Nothing here computes neural
   activity itself -- it only reads what the worker actually reports. */
import { fetchGz, decodeConnectome, decodePositions, decodeLabels } from '../../js/data.js';
import { BrainView } from '../../js/gl.js';
import { Decoder } from '../../js/decoder.js';
import { PARAMS } from '../../js/lif-core.js';
import { WorldView } from './world-view.js';
import { initWorldControl } from './world-control.js';
import { computeStageCounts } from './pipeline.js';
import { computeBehaviorPanel, buildBehaviorRows, renderBehaviorPanel, BEHAVIOUR_LABEL } from './behavior.js';
import { Radar } from './radar.js';

const $ = s => document.querySelector(s);
const NT_COLOR = {
  acetylcholine: [0.96, 0.68, 0.26], gaba: [0.28, 0.58, 0.88],
  glutamate: [0.64, 0.45, 0.87], dopamine: [0.35, 0.78, 0.55],
  serotonin: [0.90, 0.45, 0.65], octopamine: [0.30, 0.78, 0.80],
  unknown: [0.45, 0.52, 0.55],
};
const RESPOND_HZ = 1;             // "responding" cutoff, same as the main bench's response list
const READOUT_MS = 200;           // same cadence as web/js/app.js's readout()
const QUALITY_KEY = 'neural-god-quality';

const S = {
  meta: null, dicts: null, labels: null,
  view: null, world: null, dec: null, radar: null,
  worker: null, ready: false,
  hz: null, spikeAccum: null, winCount: null,
  t: 0, nActive: 0, totalSpikes: 0,
  activeStim: { idx: new Int32Array(0), rates: new Float32Array(0), activeCount: 0 },
  lastReadout: 0,
};

const yieldFrame = () => new Promise(r => setTimeout(r, 0));

function setStatus(label, frac) {
  $('#loadLabel').textContent = label;
  $('#loadBar').style.width = `${Math.round(frac * 100)}%`;
  $('#loadPct').textContent = `${Math.round(frac * 100)}%`;
}
function hideBoot() { $('#boot').classList.add('done'); }
function showBootError(err) {
  $('#loadLabel').textContent = 'Failed to load';
  $('#loadDetail').textContent = err.message;
  $('#loadDetail').classList.add('err');
}

function readQuality() {
  try { return localStorage.getItem(QUALITY_KEY) === 'low' ? 'low' : 'high'; } catch (_) { return 'high'; }
}
function storeQuality(q) {
  try { localStorage.setItem(QUALITY_KEY, q); } catch (_) { /* private mode */ }
}

async function boot() {
  try {
    setStatus('Loading connectome metadata…', 0.02);
    const meta = JSON.parse(new TextDecoder().decode(await fetchGz('../data/meta.json.gz')));
    S.meta = meta; S.dicts = meta.dicts;
    const N = meta.n_neurons, E = meta.n_edges;
    $('#totalNeurons').textContent = N.toLocaleString();
    $('#totalEdges').textContent = E.toLocaleString();

    setStatus('Loading neuron positions…', 0.10);
    const posRaw = await fetchGz('../data/pos.u16.bin.gz', f => setStatus('Loading neuron positions…', 0.10 + f * 0.10));
    const { pos, radius } = decodePositions(posRaw, N, meta.bbox_lo, meta.span);

    setStatus('Loading annotations…', 0.22);
    const labels = decodeLabels(await fetchGz('../data/labels.bin.gz'), N);
    S.labels = labels;
    const signRaw = await fetchGz('../data/sign.bin.gz');
    const channels = await (await fetch('../data/channels.json')).json();

    setStatus('Loading connections…', 0.32);
    const connRaw = await fetchGz('../data/conn.bin.gz', f => setStatus('Loading connections…', 0.32 + f * 0.5));

    setStatus('Rebuilding graph…', 0.86);
    await yieldFrame();
    const conn = decodeConnectome(connRaw, N, E, signRaw);

    setStatus('Starting renderer…', 0.94);
    await yieldFrame();
    S.view = new BrainView($('#brainWell'), pos, labels.nt, radius);
    const provenance = await fetch('../data/position-provenance.json').then(r => {
      if (!r.ok) throw new Error('Position provenance unavailable');
      return r.json();
    });
    if (provenance.n_neurons !== N) throw new Error('Position provenance mismatch');
    S.view.hideMissingPositions(provenance.missing);
    S.view.autoRotate = true;
    S.view.setNTColors(meta.dicts.top_nt.map(n => NT_COLOR[n] || NT_COLOR.unknown));
    buildNTLegend(meta.dicts.top_nt);

    const quality = readQuality();
    S.world = new WorldView($('#flyWell'), { labelContainer: $('#sceneLabels'), quality });
    S.radar = new Radar($('#radar'));
    markQuality(quality);

    S.dec = new Decoder(channels.channels, channels.features);
    buildBehaviorRows($('#behaveRows'));

    S.hz = new Float32Array(N);
    S.spikeAccum = new Float32Array(N);
    S.winCount = new Float32Array(N);

    S.worker = new Worker('../js/sim.worker.js', { type: 'module' });
    S.worker.onmessage = onWorker;
    S.worker.postMessage(
      { cmd: 'init', N, indptr: conn.indptr, indices: conn.indices, weights: conn.weights },
      [conn.indptr.buffer, conn.indices.buffer, conn.weights.buffer],
    );

    const wc = initWorldControl({
      container: $('#worldControls'),
      dicts: S.dicts, labels: S.labels,
      defaultHz: PARAMS.RPOI,
      onStimulusChange: applyStimulus,
      onStateChange: applyWorldVisuals,
    });
    applyWorldVisuals(wc.state);
    applyStimulus(wc.initialStimulus);

    bindViewControls();
    setRunning(true);
    requestAnimationFrame(loop);
  } catch (err) {
    showBootError(err);
    console.error(err);
  }
}

function onWorker(ev) {
  const m = ev.data;
  if (m.type === 'ready') {
    S.ready = true;
    hideBoot();
    return;
  }
  if (m.type === 'frame') {
    const sp = m.spikes;
    for (let k = 0; k < sp.length; k++) { const i = sp[k]; S.spikeAccum[i] = 1; S.winCount[i]++; }
    S.t = m.t; S.nActive = m.nActive; S.totalSpikes = m.totalSpikes;
  }
}

function applyStimulus(built) {
  S.activeStim = built;
  S.worker.postMessage({ cmd: 'stim', idx: built.idx, rates: built.rates.length ? built.rates : null });
}

function applyWorldVisuals(state) {
  S.world.setPredatorVisible(!!state.predator);
  S.world.setFoodVisible(!!state.food);
}

function setRunning(on) {
  S.worker.postMessage({ cmd: 'run', on });
  $('#simDot').classList.toggle('live', on);
  $('#simLabel').textContent = on ? 'LIVE' : 'PAUSED';
}

/* The neurotransmitter legend is the honest one: in web/js/gl.js a point's
   hue is its transmitter and its brightness is how recently it fired. There
   is no firing-rate colour scale to label. */
function buildNTLegend(names) {
  const box = $('#ntLegend');
  box.innerHTML = names.map(n => {
    const c = (NT_COLOR[n] || NT_COLOR.unknown).map(x => Math.round(x * 255)).join(',');
    return `<span class="nt"><i style="background:rgb(${c})"></i>${n}</span>`;
  }).join('');
}

function markQuality(q) {
  $('#qHigh').classList.toggle('on', q === 'high');
  $('#qLow').classList.toggle('on', q === 'low');
}

function bindViewControls() {
  $('#btnResetWorld').addEventListener('click', () => {
    S.spikeAccum.fill(0); S.winCount.fill(0); S.hz.fill(0);
    S.view.act.fill(0); S.view.uploadAct();
    S.worker.postMessage({ cmd: 'reset' });
  });
  $('#cameraMode').addEventListener('change', e => S.world.setCameraMode(e.target.value));
  $('#btnResetCam').addEventListener('click', () => S.world.resetCamera());
  $('#btnSettings').addEventListener('click', e => {
    e.stopPropagation();
    $('#settingsPop').classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#settingsPop') && !e.target.closest('#btnSettings')) {
      $('#settingsPop').classList.remove('open');
    }
  });
  for (const [id, q] of [['#qHigh', 'high'], ['#qLow', 'low']]) {
    $(id).addEventListener('click', () => {
      S.world.setQuality(q);
      storeQuality(q);
      markQuality(q);
    });
  }
}

/* ---------------- frame loop ---------------- */
let last = performance.now(), fpsAcc = 0, fpsN = 0;
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  fpsAcc += dt; fpsN++;

  if (S.ready) {
    const act = S.view.act, sp = S.spikeAccum;
    const decay = Math.pow(0.02, dt);
    for (let i = 0; i < act.length; i++) {
      const a = act[i] * decay;
      act[i] = sp[i] > a ? sp[i] : a;
      sp[i] = 0;
    }
    S.view.uploadAct();
    S.view.draw(dt);

    const drive = S.dec.decode(S.hz);
    S.world.update(drive, dt);
    S.world.draw(dt);
    S.radar.draw(S.world.rig.s.x, S.world.rig.s.z, S.world.rig.s.heading);

    if (now - S.lastReadout > READOUT_MS) { readout(now); S.lastReadout = now; }
  }

  if (fpsAcc > 0.25) { $('#statFps').textContent = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  requestAnimationFrame(loop);
}

function readout(now) {
  const dtSec = S.lastReadout ? Math.min(Math.max((now - S.lastReadout) / 1000, 0.05), 1.0) : READOUT_MS / 1000;
  const hz = S.hz, wc = S.winCount;
  let sumActiveHz = 0, activeN = 0;
  for (let i = 0; i < hz.length; i++) {
    hz[i] += ((wc[i] / dtSec) - hz[i]) * 0.45;
    wc[i] = 0;
    if (hz[i] >= RESPOND_HZ) { sumActiveHz += hz[i]; activeN++; }
  }

  $('#statActive').textContent = S.nActive.toLocaleString();
  $('#statHz').textContent = activeN ? (sumActiveHz / activeN).toFixed(1) : '0.0';

  const stage = computeStageCounts({
    dicts: S.dicts, labels: S.labels, hz, activeStimCount: S.activeStim.activeCount, threshold: RESPOND_HZ,
  });
  $('#pipeSensoryInput').textContent = stage.sensoryInput.toLocaleString();
  $('#pipeSensory').textContent = stage.sensoryNeurons.toLocaleString();
  $('#pipeInter').textContent = stage.interneurons.toLocaleString();
  $('#pipeDescending').textContent = stage.descendingNeurons.toLocaleString();
  $('#pipeMotor').textContent = stage.motorOutput.toLocaleString();

  const panel = computeBehaviorPanel(S.dec, hz);
  renderBehaviorPanel($('#behaviorPanel'), panel);
  $('#overlayBehaviour').textContent = BEHAVIOUR_LABEL[panel.current];
  $('#overlayConfidence').textContent = panel.score.toFixed(2);
  $('#overlayDirection').textContent = `${Math.round(((S.world.rig.s.heading * 180 / Math.PI) % 360 + 360) % 360)}°`;
  $('#overlayPos').textContent = `X:${S.world.rig.s.x.toFixed(1)} Z:${S.world.rig.s.z.toFixed(1)}`;
  $('#overlaySpeed').textContent = `${Math.abs(S.world.rig.s.speed).toFixed(2)} u/s`;
}

window.neuralGod = S;          // same debugging convention as the bench's `window.bench`
boot();
