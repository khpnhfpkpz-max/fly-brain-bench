/* NEURAL GOD — WORLD CONTROL panel.

   Every entry below is checked against web/js/presets.js (the real, published
   stimulus presets already used by the main bench). Only a control whose
   `presetId` names a preset that actually exists there drives the Brain
   Engine. Everything else is rendered with a visible "Not connected" badge
   and its input disabled where that is meaningful -- never a fake reading.

   Correction versus the original spec draft: Humidity, Temperature and
   Pheromone *do* have real presets in this repository ('humid', 'heat',
   'pheromone') and are wired up here. Light and Wind do not have a matching
   sensory population and are left disconnected. Predator has no
   predator-specific sensory channel in this model -- the only measured
   "something is coming at you" signal is the looming detector already
   exposed as "Visual stimulus" -- so Predator only toggles the placeholder
   3D prop, not the simulation. */
import { PRESETS, resolvePreset } from '../../js/presets.js';

export const WORLD_CONTROLS = [
  { id: 'light', label: 'Light', kind: 'slider', unit: '%', min: 0, max: 100, def: 70, presetId: null,
    reason: 'No matching sensory population in this connectome',
    note: 'No ambient-light sensory channel exists in this model. R7/R8 colour photoreceptors are a separate, narrow pathway (see the science guide) -- not a generic brightness input.' },
  { id: 'temperature', label: 'Temperature', kind: 'slider', unit: '°C', min: 0, max: 50, def: 24, presetId: 'heat',
    note: 'Drives the thermosensory population of the arista.' },
  { id: 'humidity', label: 'Humidity', kind: 'slider', unit: '%', min: 0, max: 100, def: 50, presetId: 'humid',
    note: 'Drives the hygrosensory population.' },
  { id: 'wind', label: 'Wind', kind: 'slider', unit: '%', min: 0, max: 100, def: 10, presetId: null,
    reason: 'No matching sensory population in this connectome',
    note: 'No mechanosensory wind/airflow channel exists in this model.' },
  { id: 'food', label: 'Food', kind: 'toggle', presetId: 'sugar',
    note: 'Drives labellar sugar-taste bristles (LB3) -- direct proboscis contact, the model’s published benchmark stimulus.' },
  { id: 'foodScent', label: 'Food scent', kind: 'slider', unit: '%', min: 0, max: 100, def: 60, presetId: 'food',
    note: 'Drives olfactory receptor neurons tuned to fermenting fruit (ORN_DM1 / ORN_DM2).' },
  { id: 'pheromone', label: 'Pheromone', kind: 'toggle', presetId: 'pheromone',
    note: 'Drives the cVA-sensitive olfactory channel (ORN_DA1).' },
  { id: 'visual', label: 'Visual stimulus (Looming)', kind: 'toggle', presetId: 'loom',
    note: 'Drives looming detectors (LPLC2). Watch for DNp01, the giant fibre, downstream.' },
  { id: 'predator', label: 'Predator', kind: 'toggle', presetId: null,
    reason: 'No predator-shape-specific sensory channel in this connectome',
    note: 'This model has no predator-shape-specific sensory channel -- only the generic looming signal above. This switch shows/hides the 3D prop only.' },
  { id: 'touch', label: 'Touch stimulus', kind: 'toggle', presetId: 'touch',
    note: 'Drives bristle mechanosensory neurons around the eye (BM_InOm).' },
];

/* Measured basis for the slider curve (see tools/measure-world-control-response.mjs,
   headless, seeded, averaged over 4 runs against the real Engine + Decoder):

   preset   neurons   ignition point (whole-brain response goes from ~0 to its
                       steady plateau of ~7,800-8,000 responding cells, ~5.5 Hz
                       mean descending rate)
   heat        29      ~2-3 Hz
   humid       74      ~5-7.5 Hz
   food       122      ~1-1.5 Hz

   Past that point, raising the drive further barely changes the plateau --
   e.g. heat's responding-cell count is 7,804 at 3 Hz and 7,911 at 150 Hz, a
   1.4% change over a 50x increase in drive. A linear 0-100% -> 0-RPOI mapping
   therefore spends the first 1-5% of the slider doing all the work and the
   remaining 95%+ doing almost nothing -- "barely move it and it's already
   maxed out" is not a UI bug, it is what these three small populations
   (29-122 cells apiece) actually do to this recurrent network.

   INTENSITY_GAMMA reshapes the slider, not the biology: hz = RPOI * frac^4
   spreads that same real ignition point out to roughly the 30-50% mark of the
   slider's travel for all three controls (worked out from the measured
   thresholds above), so dragging through the middle of the slider is where
   the brain visibly switches on, instead of the first pixel of movement. The
   ceiling is still exactly RPOI at 100% -- the same rate every toggle in this
   app uses for its "on" state -- and 0% is still exactly 0 Hz. Only the shape
   of the ramp between those two measured, unchanged endpoints is different. */
const INTENSITY_GAMMA = 4;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const findPreset = id => PRESETS.find(p => p.id === id) || null;

/* `onStimulusChange({idx, rates, activeCount})` is debounced and drives the
   worker. `onStateChange(state)` fires immediately, for visual-only effects
   (the predator prop) that never touch the simulation. */
export function initWorldControl({ container, dicts, labels, defaultHz, onStimulusChange, onStateChange }) {
  const state = {};
  const resolvedIdx = {};
  for (const c of WORLD_CONTROLS) {
    state[c.id] = c.kind === 'toggle' ? false : c.def;
    if (c.presetId) {
      const preset = findPreset(c.presetId);
      resolvedIdx[c.id] = preset ? resolvePreset(preset, labels, dicts) : [];
      if (!preset) console.warn(`world-control: preset "${c.presetId}" not found for "${c.id}"`);
    }
  }

  function buildStimulus() {
    const idxList = [];
    const rateList = [];
    let activeCount = 0;
    for (const c of WORLD_CONTROLS) {
      if (!c.presetId) continue;
      const ids = resolvedIdx[c.id];
      if (!ids || !ids.length) continue;
      const v = state[c.id];
      const on = c.kind === 'toggle' ? v : v > 0;
      if (!on) continue;
      const frac = c.kind === 'toggle' ? 1 : Math.min(1, v / c.max);
      const hz = defaultHz * Math.pow(frac, INTENSITY_GAMMA);
      for (const i of ids) { idxList.push(i); rateList.push(hz); }
      activeCount += ids.length;
    }
    return { idx: Int32Array.from(idxList), rates: Float32Array.from(rateList), activeCount };
  }

  let debounceT = null;
  function scheduleStimulus() {
    clearTimeout(debounceT);
    debounceT = setTimeout(() => onStimulusChange(buildStimulus()), 120);
  }

  const fields = renderUI(container, state, () => { onStateChange(state); scheduleStimulus(); });

  /* Programmatic control, for Scenario presets (js/scenarios.js). Updates the
     same `state` object and the same rendered inputs a manual drag/click
     would, then runs through the identical onStateChange + stimulus path --
     a scenario is not a separate code path from a person's own hand on the
     controls, just a batch of the same writes. */
  function applyValues(values) {
    for (const c of WORLD_CONTROLS) {
      if (!(c.id in values)) continue;
      const v = values[c.id];
      state[c.id] = v;
      const f = fields[c.id];
      if (!f) continue;
      if (c.kind === 'toggle') {
        f.el.textContent = v ? 'ON' : 'OFF';
        f.el.classList.toggle('on', !!v);
      } else {
        f.el.value = String(v);
        f.out.textContent = `${v}${c.unit}`;
      }
    }
    onStateChange(state);
    scheduleStimulus();
  }

  return { state, initialStimulus: buildStimulus(), applyValues };
}

function renderUI(container, state, onInput) {
  container.innerHTML = '';
  const fields = {};
  for (const c of WORLD_CONTROLS) {
    const row = document.createElement('div');
    row.className = 'wc-row' + (c.presetId ? '' : ' wc-off');
    row.dataset.id = c.id;                 // presentation only: CSS hangs the row icon off this

    const head = document.createElement('div');
    head.className = 'wc-head';
    head.innerHTML = `<span class="wc-label">${esc(c.label)}</span>` +
      (c.presetId ? '' : `<span class="wc-badge" title="${esc(c.reason || 'Not connected')}">Not connected</span>`);
    row.appendChild(head);

    if (c.kind === 'toggle') {
      const btn = document.createElement('button');
      btn.className = 'wc-toggle';
      btn.type = 'button';
      btn.textContent = 'OFF';
      btn.addEventListener('click', () => {
        state[c.id] = !state[c.id];
        btn.textContent = state[c.id] ? 'ON' : 'OFF';
        btn.classList.toggle('on', state[c.id]);
        onInput();
      });
      row.appendChild(btn);
      fields[c.id] = { el: btn };
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'wc-slider';
      const input = document.createElement('input');
      input.type = 'range'; input.min = String(c.min); input.max = String(c.max); input.value = String(c.def);
      if (!c.presetId) input.disabled = true;
      const out = document.createElement('span');
      out.className = 'wc-val mono';
      out.textContent = `${c.def}${c.unit}`;
      input.addEventListener('input', () => {
        state[c.id] = +input.value;
        out.textContent = `${input.value}${c.unit}`;
        onInput();
      });
      wrap.append(input, out);
      row.appendChild(wrap);
      fields[c.id] = { el: input, out };
    }

    const note = document.createElement('p');
    note.className = 'wc-note';
    note.textContent = c.note;
    row.appendChild(note);

    container.appendChild(row);
  }
  return fields;
}
