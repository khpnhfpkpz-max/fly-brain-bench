/* NEURAL GOD -- Phase 4: NEURAL HACKING.

   Stimulate / Suppress / Disable a selected neuron while the simulation runs,
   and compare "what the brain does normally" against "what it does with the
   intervention" as an explicit, paired experiment.

   Two mechanisms, deliberately separate:

   1. LIVE INTERVENTION. The one existing Engine, intervened in place. Costs
      nothing when nothing is intervened -- sim.worker.js's tick() takes the
      exact call it always took while the op set is empty.
   2. PAIRED EXPERIMENT (the "RUN COMPARISON" button). The worker forks one
      bit-identical brain state into two and gives both the *same* seeded
      noise, so the only difference between the two runs is the intervention
      itself. Two permanently co-running engines could not do this: they would
      draw independent noise, and the difference would be part intervention
      and part luck.

   Everything shown here is arithmetic over spike counts the worker actually
   returned. The behaviour comparison runs the real decoder (web/js/decoder.js,
   unmodified) on both sides rather than reimplementing it. Nothing is
   estimated, extrapolated or filled in. */
import { computeBehaviorPanel, BEHAVIOUR_LABEL } from './behavior.js';
import { BEHAVIOURS } from '../../js/decoder.js';

export const MODES = {
  stim: { label: 'Stimulate', short: 'STIM' },
  suppress: { label: 'Suppress', short: 'SUPP' },
  off: { label: 'Disable', short: 'OFF' },
};
const CHANNEL_NAMES = ['escape', 'turn', 'stop', 'backward', 'landing', 'wing', 'walk', 'proboscis'];
const TRIALS = [50, 100, 200];     // biological ms per side
const SEED = 20260922;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createIntervention({ el, worker, dec, channels, dicts, labels, defaultHz,
                                     onExperimentStart, onExperimentEnd }) {
  const ops = new Map();           // i -> { mode, hz } ; the single source of truth
  let qid = 0, pending = -1, running = false;
  let lastResult = null;
  let onChange = null;

  /* measured, not guessed: biological ms of simulation per wall-clock second,
     sampled from the frames the worker is actually posting */
  let clockT = 0, clockWall = 0, bioPerSec = 0;

  /* ---------------- live intervention ---------------- */
  function push() {
    worker.postMessage({ cmd: 'intervene', ops: [...ops].map(([i, o]) => ({ i, ...o })), seed: SEED });
    renderBanner();
    renderList();
    onChange?.();
  }

  function setMode(i, mode, hz) {
    if (!MODES[mode]) return;
    ops.set(i, { mode, hz: mode === 'off' ? 0 : (hz ?? defaultHz) });
    push();
  }
  function clear(i) { if (ops.delete(i)) push(); }
  function clearAll() { if (ops.size) { ops.clear(); push(); } }
  const modeOf = i => ops.get(i)?.mode || null;
  const hzOf = i => ops.get(i)?.hz ?? defaultHz;

  /* ---------------- banner + active list ---------------- */
  function renderBanner() {
    const n = ops.size;
    el.banner.classList.toggle('on', n > 0);
    el.bannerCount.textContent = n ? `${n} neuron${n === 1 ? '' : 's'}` : '';
    el.runBtn.disabled = n === 0 || running;
  }

  function renderList() {
    if (!ops.size) {
      el.list.innerHTML = '<p class="dim">No intervention. Select a neuron in the Neural inspector and choose Stimulate, Suppress or Disable.</p>';
      return;
    }
    el.list.innerHTML = [...ops].map(([i, o]) => {
      const type = dicts.cell_type[labels.cellType[i]];
      const detail = o.mode === 'off' ? 'held silent' : `${o.hz.toFixed(0)} Hz`;
      return `<div class="iv-item"><span class="iv-tag ${o.mode}">${MODES[o.mode].short}</span>` +
             `<span class="iv-item-name">${esc(type)} <span class="mono dim">#${i}</span></span>` +
             `<span class="mono dim">${detail}</span>` +
             `<button class="iv-x" type="button" data-i="${i}" title="Reset this neuron">&times;</button></div>`;
    }).join('');
    for (const b of el.list.querySelectorAll('.iv-x')) {
      b.addEventListener('click', () => clear(+b.dataset.i));
    }
  }

  /* ---------------- throughput, for an honest duration estimate ---------------- */
  /* Two frames can land in the same millisecond, and `reset` rewinds the
     worker's clock -- either would divide by zero or by a negative. A
     measurement that cannot be taken is skipped, never substituted. */
  function noteFrame(t) {
    const now = performance.now();
    const wall = (now - clockWall) / 1000;
    if (clockWall && wall >= 0.05 && t > clockT) {
      const rate = (t - clockT) / wall;
      if (Number.isFinite(rate) && rate > 0) {
        bioPerSec = bioPerSec ? bioPerSec + (rate - bioPerSec) * 0.2 : rate;
      }
      clockT = t; clockWall = now;
      if (!running) renderEstimate();
    } else if (!clockWall || t < clockT) {
      clockT = t; clockWall = now;        // first frame, or the clock was reset
    }
  }

  function trialMs() { return +el.trial.value || TRIALS[1]; }

  /* An experiment runs pre + normal + intervention, i.e. 3x the trial length
     of biological time, and runs it with the duty-cycle pacer switched off --
     so roughly twice the throughput the live measurement above sees. */
  function renderEstimate() {
    const total = trialMs() * 3;
    if (!bioPerSec || !Number.isFinite(bioPerSec)) {
      el.estimate.textContent = `${total} biological ms · measuring this machine's simulation speed…`;
      return;
    }
    const secs = total / (bioPerSec * 2);
    el.estimate.textContent = `${total} biological ms · ≈${secs < 1 ? secs.toFixed(1) : Math.round(secs)}s ` +
      `(estimated from the ${bioPerSec.toFixed(0)} bio-ms/s this machine is currently sustaining)`;
  }

  /* ---------------- paired experiment ---------------- */
  function run() {
    if (running || !ops.size) return;
    running = true;
    pending = ++qid;
    const ms = trialMs();
    el.runBtn.disabled = true;
    el.cancelBtn.hidden = false;
    el.progressWrap.hidden = false;
    el.results.innerHTML = '';
    setProgress('pre', 0, 1);
    onExperimentStart?.();
    /* Suspend the live intervention first, so the state both sides fork from
       is an un-intervened brain and "Normal" means exactly that. */
    worker.postMessage({ cmd: 'intervene', ops: [], seed: SEED });
    worker.postMessage({
      cmd: 'experiment', qid: pending, ms, preMs: ms, seed: SEED,
      ops: [...ops].map(([i, o]) => ({ i, ...o })),
    });
  }

  function cancel() {
    if (!running) return;
    worker.postMessage({ cmd: 'experimentCancel', qid: pending });
  }

  function endRun() {
    running = false;
    el.cancelBtn.hidden = true;
    el.progressWrap.hidden = true;
    worker.postMessage({ cmd: 'intervene', ops: [...ops].map(([i, o]) => ({ i, ...o })), seed: SEED });
    onExperimentEnd?.();
    renderBanner();
    renderEstimate();
  }

  const PHASE_LABEL = { pre: 'Baseline (pre-onset)', normal: 'Normal', interv: 'Intervention' };
  function setProgress(phase, done, total) {
    const perPhase = 1 / 3;
    const order = { pre: 0, normal: 1, interv: 2 }[phase] ?? 0;
    const frac = Math.min(1, (order + (total ? done / total : 0)) * perPhase);
    el.progressBar.style.width = `${(frac * 100).toFixed(1)}%`;
    el.progressLabel.textContent = `${PHASE_LABEL[phase]}…`;
  }

  /* Called by app.js's onWorker(). */
  function onMessage(m) {
    if (m.type === 'experimentProgress') {
      if (m.qid === pending) setProgress(m.phase, m.done, m.total);
      return;
    }
    if (m.type === 'experimentCancelled') {
      if (m.qid !== pending) return;
      endRun();
      el.results.innerHTML = '<p class="dim">Comparison cancelled. Nothing was measured.</p>';
      return;
    }
    if (m.type === 'experimentError') {
      if (m.qid !== pending) return;
      endRun();
      el.results.innerHTML = `<p class="dim">Comparison could not start (${esc(m.reason)}).</p>`;
      return;
    }
    if (m.type === 'experiment') {
      if (m.qid !== pending) return;
      lastResult = m;
      endRun();
      renderResults(m);
    }
  }

  /* ---------------- results ---------------- */
  const toHz = (counts, ms) => {
    const hz = new Float32Array(counts.length);
    const sec = ms / 1000;
    for (let i = 0; i < counts.length; i++) hz[i] = counts[i] / sec;
    return hz;
  };

  /* The live Neural activity stat thresholds at 1 Hz. Over a 50-200 ms trial
     the smallest non-zero rate a neuron can have is 1000/ms -- 20 Hz at 50 ms
     -- so that threshold degenerates into "fired at least once" and calling
     it a rate cutoff would be misleading. It is labelled for what it is. */
  function meanFiringHz(counts, ms) {
    const sec = ms / 1000;
    let spikes = 0, n = 0;
    for (let i = 0; i < counts.length; i++) if (counts[i] > 0) { spikes += counts[i]; n++; }
    return { mean: n ? (spikes / n) / sec : 0, n };
  }

  const sumOver = (counts, list) => list.reduce((a, i) => a + counts[i], 0);

  function delta(a, b, digits = 0, unit = '') {
    const d = b - a;
    return `<span class="iv-delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : ''}${d.toFixed(digits)}${unit}</span>`;
  }

  /* The one metric with a precondition. First-spike latency only means
     "the intervention made this channel fire" if the channel was silent going
     into the trial; and a channel that never fires inside the window has no
     latency at all. Both cases are reported as such -- never as a number. */
  function latency(side, list, dt) {
    let best = -1;
    for (const i of list) {
      const s = side.firstSpikeStep[i];
      if (s >= 0 && (best < 0 || s < best)) best = s;
    }
    return best < 0 ? null : best * dt;
  }

  function reactionRows(m) {
    return CHANNEL_NAMES.map(name => {
      const c = channels.channels[name];
      if (!c) return '';
      const list = c.all;
      const pre = sumOver(m.baseline.counts, list);
      if (pre > 0) {
        return row(name, `<span class="iv-nd">Already firing before onset (${pre} spike${pre === 1 ? '' : 's'} in the baseline window) &mdash; latency not defined</span>`, 2);
      }
      const nrm = latency(m.normal, list, m.dt);
      const ivn = latency(m.intervention, list, m.dt);
      if (nrm === null && ivn === null) {
        return row(name, `<span class="iv-nd">No spike within the ${m.ms} ms trial window on either side</span>`, 2);
      }
      const fmt = v => v === null ? '<span class="iv-nd">no spike in window</span>' : `<b class="mono">${v.toFixed(1)} ms</b>`;
      return `<tr><th>${name}</th><td>${fmt(nrm)}</td><td>${fmt(ivn)}</td></tr>`;
    }).join('');
  }
  const row = (name, msg, span) => `<tr><th>${name}</th><td colspan="${span}">${msg}</td></tr>`;

  function renderResults(m) {
    const hzN = toHz(m.normal.counts, m.ms);
    const hzI = toHz(m.intervention.counts, m.ms);
    const bN = computeBehaviorPanel(dec, hzN);
    const bI = computeBehaviorPanel(dec, hzI);
    const rN = meanFiringHz(m.normal.counts, m.ms), rI = meanFiringHz(m.intervention.counts, m.ms);
    const opList = m.ops.map(o => {
      const type = dicts.cell_type[labels.cellType[o.i]];
      return `${MODES[o.mode].label} ${esc(type)} #${o.i}${o.mode === 'off' ? '' : ` @ ${o.hz.toFixed(0)} Hz`}`;
    }).join(' \u00b7 ');

    el.results.innerHTML = `
      <p class="iv-run-desc">${m.ms} ms per side \u00b7 seed ${SEED} \u00b7 ${esc(opList)}</p>
      <table class="iv-table">
        <thead><tr><th></th><th>Normal</th><th>Intervention</th></tr></thead>
        <tbody>
          <tr><th>Behavior</th>
              <td><b>${BEHAVIOUR_LABEL[bN.current]}</b> <span class="mono dim">${bN.score.toFixed(2)}</span></td>
              <td><b>${BEHAVIOUR_LABEL[bI.current]}</b> <span class="mono dim">${bI.score.toFixed(2)}</span></td></tr>
          <tr><th>Neural activity</th>
              <td><b class="mono">${rN.mean.toFixed(1)}</b> Hz <span class="dim">mean over the ${rN.n.toLocaleString()} cells that fired</span></td>
              <td><b class="mono">${rI.mean.toFixed(1)}</b> Hz <span class="dim">over ${rI.n.toLocaleString()} cells</span> ${delta(rN.mean, rI.mean, 1, ' Hz')}</td></tr>
          <tr><th>Spike count</th>
              <td><b class="mono">${m.normal.totalSpikes.toLocaleString()}</b> <span class="dim">whole brain</span></td>
              <td><b class="mono">${m.intervention.totalSpikes.toLocaleString()}</b> ${delta(m.normal.totalSpikes, m.intervention.totalSpikes)}</td></tr>
          ${m.ops.map(o => {
            const type = dicts.cell_type[labels.cellType[o.i]];
            return `<tr><th class="iv-sel">${esc(type)} #${o.i}</th>` +
                   `<td><b class="mono">${m.normal.counts[o.i]}</b> <span class="dim">spikes</span></td>` +
                   `<td><b class="mono">${m.intervention.counts[o.i]}</b> ${delta(m.normal.counts[o.i], m.intervention.counts[o.i])}</td></tr>`;
          }).join('')}
        </tbody>
      </table>

      <h4 class="iv-sub">Behaviour activations <span class="dim">the decoder&rsquo;s own output for each side, not just its argmax</span></h4>
      <table class="iv-table iv-acts">
        <thead><tr><th></th><th>Normal</th><th>Intervention</th></tr></thead>
        <tbody>${BEHAVIOURS.map(b => {
          const a = bN.values[b] || 0, c = bI.values[b] || 0;
          if (a < 0.005 && c < 0.005) return '';
          return `<tr${b === bI.current || b === bN.current ? ' class="on"' : ''}><th>${BEHAVIOUR_LABEL[b]}</th>` +
                 `<td class="mono">${a.toFixed(2)}</td><td class="mono">${c.toFixed(2)} ${Math.abs(c - a) >= 0.005 ? delta(a, c, 2) : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="3" class="iv-nd">Every activation was zero on both sides.</td></tr>'}</tbody>
      </table>

      <h4 class="iv-sub">Channel activity <span class="dim">spikes inside each named channel &mdash; where a whole-brain total hides the effect</span></h4>
      <table class="iv-table iv-chan">
        <thead><tr><th></th><th>Normal</th><th>Intervention</th></tr></thead>
        <tbody>${CHANNEL_NAMES.map(name => {
          const c = channels.channels[name];
          if (!c) return '';
          const a = sumOver(m.normal.counts, c.all), b = sumOver(m.intervention.counts, c.all);
          return `<tr><th>${name}</th><td class="mono">${a}</td><td class="mono">${b} ${a !== b ? delta(a, b) : ''}</td></tr>`;
        }).join('')}</tbody>
      </table>

      <h4 class="iv-sub">Reaction time <span class="dim">first spike in each channel, measured from intervention onset at ${m.dt} ms resolution</span></h4>
      <table class="iv-table iv-react">
        <thead><tr><th></th><th>Normal</th><th>Intervention</th></tr></thead>
        <tbody>${reactionRows(m)}</tbody>
      </table>`;
  }

  /* ---------------- wiring ---------------- */
  el.trial.innerHTML = TRIALS.map(v => `<option value="${v}"${v === 100 ? ' selected' : ''}>${v} ms</option>`).join('');
  el.trial.addEventListener('change', renderEstimate);
  el.runBtn.addEventListener('click', run);
  el.cancelBtn.addEventListener('click', cancel);
  el.bannerReset.addEventListener('click', clearAll);
  renderBanner();
  renderList();
  renderEstimate();

  return {
    setMode, clear, clearAll, modeOf, hzOf, onMessage, noteFrame,
    get size() { return ops.size; },
    get lastResult() { return lastResult; },
    set onChange(fn) { onChange = fn; },
  };
}
