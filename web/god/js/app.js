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
import { SCENARIOS } from './scenarios.js';
import { computeStageCounts } from './pipeline.js';
import { computeBehaviorPanel, buildBehaviorRows, renderBehaviorPanel, BEHAVIOUR_LABEL } from './behavior.js';
import { Radar } from './radar.js';
import { createSimPacer } from './sim-pacer.js';
import { createInspector } from './inspector.js';
import { createIntervention } from './intervention.js';
import { REGIONS, buildRegionMembership, applyRegionFilter } from './regions.js';
import { bindBrainPinchZoom } from './touch-brain.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NT_COLOR = {
  acetylcholine: [0.96, 0.68, 0.26], gaba: [0.28, 0.58, 0.88],
  glutamate: [0.64, 0.45, 0.87], dopamine: [0.35, 0.78, 0.55],
  serotonin: [0.90, 0.45, 0.65], octopamine: [0.30, 0.78, 0.80],
  unknown: [0.45, 0.52, 0.55],
};
const RESPOND_HZ = 1;             // "responding" cutoff, same as the main bench's response list
const READOUT_MS = 200;           // same cadence as web/js/app.js's readout() -- also the decoder's own update rate
const QUALITY_KEY = 'neural-god-quality';

/* The 3D world still redraws every rAF tick (smooth camera and gait), but
   these two are visual bookkeeping that gains nothing from running faster
   than this: the brain point cloud's own activity input only changes at
   READOUT_MS anyway, and the radar is a slowly-moving dot. Decoupling them
   from display refresh rate (which can be 60, 120, 144 Hz...) is most of
   where the "spiking rate" of GPU/CPU work independent of simulation speed
   was coming from. */
const BRAIN_HZ = 30;
const BRAIN_DT = 1 / BRAIN_HZ;
const RADAR_HZ = 10;
const RADAR_DT = 1 / RADAR_HZ;

/* A neutral resting drive, so the fly has something to animate toward before
   the first readout() has run. Same shape decoder.js's rules()/learned()
   already return -- not a new behaviour, just its all-zero rest state. */
const NEUTRAL_DRIVE = { walk: 0, turn: 0, stop: 0, backward: 0, escape: 0, proboscis: 0, wing: 0, groom: 0 };

const S = {
  meta: null, dicts: null, labels: null, channels: null,
  view: null, world: null, dec: null, radar: null, pacer: null, inspector: null, hack: null,
  experimentRunning: false,
  regionMembership: null,
  worker: null, ready: false,
  hz: null, spikeAccum: null, winCount: null,
  t: 0, nActive: 0, totalSpikes: 0,
  activeStim: { idx: new Int32Array(0), rates: new Float32Array(0), activeCount: 0 },
  drive: NEUTRAL_DRIVE,
  lastReadout: 0, brainAcc: 0, radarAcc: 0,
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
    S.channels = channels;

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
    /* This panel is 346x186 CSS px at its widest; gl.js defaults to a device
       pixel ratio cap of 2, which is real supersampling this small a canvas
       never needed. 1.5 is a flat, quality-independent cut (-44% pixels);
       Low goes further, in applyBrainQuality() below. */
    S.view.pixelRatioLimit = 1.5;
    bindBrainPinchZoom(S.view, $('#brainWell'));   // touch-only; single-finger drag is gl.js's own, unchanged
    buildNTLegend(meta.dicts.top_nt);
    buildRegionsUI();

    const quality = readQuality();
    S.world = new WorldView($('#flyWell'), { labelContainer: $('#sceneLabels'), quality });
    S.radar = new Radar($('#radar'));
    applyBrainQuality(quality);
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
    S.pacer = createSimPacer(S.worker, { runMs: 250, pauseMs: 250 });

    S.hack = createIntervention({
      el: {
        banner: $('#ivBanner'), bannerCount: $('#ivBannerCount'), bannerReset: $('#ivBannerReset'),
        list: $('#ivList'), trial: $('#ivTrial'), estimate: $('#ivEstimate'),
        runBtn: $('#ivRun'), cancelBtn: $('#ivCancel'),
        progressWrap: $('#ivProgressWrap'), progressBar: $('#ivProgressBar'), progressLabel: $('#ivProgressLabel'),
        results: $('#ivResults'),
      },
      worker: S.worker, dec: S.dec, channels: S.channels,
      dicts: S.dicts, labels: S.labels, defaultHz: PARAMS.RPOI,
      onExperimentStart: () => setExperimentMode(true),
      onExperimentEnd: () => setExperimentMode(false),
    });

    S.inspector = createInspector({
      el: {
        search: $('#insSearch'), results: $('#insResults'),
        empty: $('#insEmpty'), body: $('#insBody'), title: $('#insTitle'), rootLink: $('#insRootLink'),
        meta: $('#insMeta'), rate: $('#insRate'), activity: $('#insActivity'), history: $('#insHistory'),
        connections: $('#insConnections'), involvement: $('#insInvolvement'),
        intervene: $('#insIntervene'),
      },
      meta: S.meta, dicts: S.dicts, labels: S.labels, channels: S.channels,
      dec: S.dec, hz: S.hz, worker: S.worker, view: S.view,
      onRegionPick: applyRegionSelection,
      intervention: S.hack,
    });
    S.hack.onChange = () => S.inspector?.renderIntervene();
    bindBrainWellClick();

    S.wc = initWorldControl({
      container: $('#worldControls'),
      dicts: S.dicts, labels: S.labels,
      defaultHz: PARAMS.RPOI,
      onStimulusChange: applyStimulus,
      onStateChange: applyWorldVisuals,
    });
    applyWorldVisuals(S.wc.state);
    applyStimulus(S.wc.initialStimulus);

    buildScenarioPicker();
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
    S.hack?.noteFrame(m.t);
    return;
  }
  if (m.type === 'neighbors') { S.inspector?.onNeighbors(m); return; }
  if (m.type === 'intervention') { S.hack?.onMessage(m); return; }
  if (m.type === 'experiment' || m.type === 'experimentProgress'
      || m.type === 'experimentCancelled' || m.type === 'experimentError') {
    S.hack?.onMessage(m);
    return;
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
  S.pacer.setEnabled(on);
  $('#simDot').classList.toggle('live', on);
  $('#simLabel').textContent = on ? 'LIVE' : 'PAUSED';
}

/* A paired comparison runs three trials' worth of biological time inside the
   worker. Letting the live loop keep ticking alongside it would halve the
   experiment's throughput and keep moving the brain state underneath it, so
   the live loop is stopped for the duration -- through createSimPacer's own
   setEnabled(), i.e. the existing `cmd:'run'` protocol, with no new worker
   command and no change to sim-pacer.js. */
function setExperimentMode(on) {
  S.experimentRunning = on;
  S.pacer.setEnabled(!on);
  $('#simDot').classList.toggle('live', !on);
  $('#simLabel').textContent = on ? 'EXPERIMENT' : 'LIVE';
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

/* Brain Regions filter (Neural Activity panel). regions.js does the actual
   super_class/cell_class membership test and the dim-array write; this just
   builds the dropdown (with real per-region counts) and wires it. */
function buildRegionsUI() {
  const { membership, counts } = buildRegionMembership(S.dicts, S.labels);
  S.regionMembership = membership;
  const sel = $('#regionsFilter');
  sel.innerHTML = '<option value="-1">All regions</option>' +
    REGIONS.map((r, i) => `<option value="${i}">${esc(r.label)} — ${counts[i].toLocaleString()}</option>`).join('');
  sel.addEventListener('change', () => applyRegionSelection(+sel.value));
}
function applyRegionSelection(idOrIndex) {
  const idx = typeof idOrIndex === 'string' && Number.isNaN(+idOrIndex)
    ? REGIONS.findIndex(r => r.id === idOrIndex)
    : +idOrIndex;
  if (idx < -1) return;
  $('#regionsFilter').value = String(idx);
  applyRegionFilter(S.view, S.regionMembership, idx);
}

/* 3D-click selection in the Neural Activity panel. gl.js's pick() assumes the
   canvas backing store was sized at min(devicePixelRatio, 2) -- true before
   the performance pass, which introduced BrainView.pixelRatioLimit (1.5 on
   High, 1 on Low) and made that assumption wrong on any display where
   devicePixelRatio > pixelRatioLimit. This corrects the *input* coordinate
   pick() receives so the two agree again, without touching gl.js. */
function bindBrainWellClick() {
  const canvas = $('#brainWell');
  canvas.addEventListener('click', e => {
    const r = canvas.getBoundingClientRect();
    const realDpr = Math.min(devicePixelRatio || 1, S.view.pixelRatioLimit ?? 2);
    const pickDpr = Math.min(devicePixelRatio || 1, 2);
    const k = realDpr / pickDpr;
    const i = S.view.pick((e.clientX - r.left) * k, (e.clientY - r.top) * k);
    if (i >= 0) S.inspector.select(i); else S.inspector.clearSelection();
  });
}

function buildScenarioPicker() {
  const sel = $('#scenarioSelect');
  sel.innerHTML = SCENARIOS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  const showDesc = id => {
    $('#scenarioDesc').textContent = SCENARIOS.find(s => s.id === id)?.description || '';
  };
  sel.addEventListener('change', () => {
    const scenario = SCENARIOS.find(s => s.id === sel.value);
    if (!scenario) return;
    S.wc.applyValues(scenario.values);
    showDesc(scenario.id);
  });
  showDesc(sel.value);
}

function markQuality(q) {
  $('#qHigh').classList.toggle('on', q === 'high');
  $('#qLow').classList.toggle('on', q === 'low');
}

/* The Graphics setting previously only touched WorldView -- the brain point
   cloud (web/js/gl.js's BrainView) kept rendering at full resolution with
   full bloom regardless. Low now actually means less work here too: no
   post-processing at all (gl.js's own draw() skips the whole bloom chain
   when this.bloom < 0.01) and pixel-ratio 1 instead of 1.5. Neither touches
   gl.js -- both are public properties it already exposed. */
function applyBrainQuality(q) {
  if (q === 'high') { S.view.pixelRatioLimit = 1.5; S.view.bloom = 0.85; }
  else { S.view.pixelRatioLimit = 1; S.view.bloom = 0; }
}

function bindViewControls() {
  $('#btnResetWorld').addEventListener('click', () => {
    S.spikeAccum.fill(0); S.winCount.fill(0); S.hz.fill(0);
    S.view.act.fill(0); S.view.uploadAct();
    S.hack?.clearAll();
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
      applyBrainQuality(q);
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
    /* The fly's body still integrates every rAF tick -- gait, wings and
       camera stay smooth at whatever the display's own refresh rate is.
       `S.drive` itself only changes at READOUT_MS (see readout() below):
       recomputing decode() here as well was recomputing the same answer
       up to a dozen times between the readouts that actually change it. */
    S.world.update(S.drive, dt);
    S.world.draw(dt);

    S.brainAcc += dt;
    if (S.brainAcc >= BRAIN_DT) {
      const bdt = S.brainAcc; S.brainAcc = 0;
      const act = S.view.act, sp = S.spikeAccum;
      const decay = Math.pow(0.02, bdt);
      for (let i = 0; i < act.length; i++) {
        const a = act[i] * decay;
        act[i] = sp[i] > a ? sp[i] : a;
        sp[i] = 0;
      }
      S.view.uploadAct();
      S.view.draw(bdt);
    }

    S.radarAcc += dt;
    if (S.radarAcc >= RADAR_DT) {
      S.radarAcc = 0;
      S.radar.draw(S.world.rig.s.x, S.world.rig.s.z, S.world.rig.s.heading);
    }

    if (now - S.lastReadout > READOUT_MS) { readout(now); S.lastReadout = now; }
  }

  if (fpsAcc > 0.25) { setText($('#statFps'), String(Math.round(fpsN / fpsAcc))); fpsAcc = 0; fpsN = 0; }
  requestAnimationFrame(loop);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
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

  setText($('#statActive'), S.nActive.toLocaleString());
  setText($('#statHz'), activeN ? (sumActiveHz / activeN).toFixed(1) : '0.0');

  const stage = computeStageCounts({
    dicts: S.dicts, labels: S.labels, hz, activeStimCount: S.activeStim.activeCount, threshold: RESPOND_HZ,
  });
  setText($('#pipeSensoryInput'), stage.sensoryInput.toLocaleString());
  setText($('#pipeSensory'), stage.sensoryNeurons.toLocaleString());
  setText($('#pipeInter'), stage.interneurons.toLocaleString());
  setText($('#pipeDescending'), stage.descendingNeurons.toLocaleString());
  setText($('#pipeMotor'), stage.motorOutput.toLocaleString());

  /* The single decode() for this whole 200ms window -- FlyRig.update() in
     loop() above keeps reading this same object every frame until the next
     readout() replaces it. */
  S.drive = S.dec.decode(hz);
  const panel = computeBehaviorPanel(S.dec, hz);
  renderBehaviorPanel($('#behaviorPanel'), panel);
  setText($('#overlayBehaviour'), BEHAVIOUR_LABEL[panel.current]);
  setText($('#overlayConfidence'), panel.score.toFixed(2));
  setText($('#overlayDirection'), `${Math.round(((S.world.rig.s.heading * 180 / Math.PI) % 360 + 360) % 360)}°`);
  setText($('#overlayPos'), `X:${S.world.rig.s.x.toFixed(1)} Z:${S.world.rig.s.z.toFixed(1)}`);
  setText($('#overlaySpeed'), `${Math.abs(S.world.rig.s.speed).toFixed(2)} u/s`);

  S.inspector?.sampleHistory();   // same 5 Hz cadence hz[] itself just updated at
}

window.neuralGod = S;          // same debugging convention as the bench's `window.bench`
boot();
