/* NEURAL GOD — Behavior panel.

   Reuses the existing Decoder (web/js/decoder.js) unmodified, through its
   already-public methods (`rules`, `features`, `predict`). It never invents a
   9-way probability where the decoder does not actually produce one:

   - rules mode (no trained model yet): `rules()` returns independent 0..1
     drive strengths per channel, not a probability distribution over the
     nine behaviours. We label these "Activation", not "Confidence".
   - learned mode (a model has been trained): `predict()` returns a real
     softmax over the nine BEHAVIOURS classes. We label these "Confidence". */
import { BEHAVIOURS } from '../../js/decoder.js';

export const BEHAVIOUR_LABEL = {
  rest: 'Standing', walk: 'Walking', turnL: 'Turning left', turnR: 'Turning right',
  backward: 'Walking backward', stop: 'Frozen', escape: 'Escape takeoff',
  feed: 'Extending proboscis', groom: 'Grooming',
};

/* Turn the rules() drive dict into one non-exclusive "activation" value per
   BEHAVIOURS entry. `rest` has no direct channel of its own in rules(), so it
   is shown as "how little else is active" -- explicitly a derived value, not
   a measured one. */
function activationsFromDrive(d) {
  const walk = d.walk || 0, turn = d.turn || 0, backward = d.backward || 0,
        stop = d.stop || 0, escape = d.escape || 0, proboscis = d.proboscis || 0, groom = d.groom || 0;
  const turnL = Math.max(0, -turn), turnR = Math.max(0, turn);
  const rest = Math.max(0, 1 - Math.max(walk, turnL, turnR, backward, stop, escape, proboscis, groom));
  return { rest, walk, turnL, turnR, backward, stop, escape, feed: proboscis, groom };
}

export function computeBehaviorPanel(dec, hz) {
  const learned = dec.mode === 'learned' && !!dec.model;
  let values, current, score;
  if (learned) {
    const p = dec.predict(dec.features(hz));   // aligned to BEHAVIOURS order
    values = {};
    BEHAVIOURS.forEach((b, i) => { values[b] = p[i]; });
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    current = BEHAVIOURS[best]; score = p[best];
  } else {
    values = activationsFromDrive(dec.rules(hz));
    current = 'rest'; score = values.rest;
    for (const b of BEHAVIOURS) if (values[b] > score) { current = b; score = values[b]; }
  }
  return { label: learned ? 'Confidence' : 'Activation', values, current, score };
}

/* Element lookups (querySelector) and any write whose value has not actually
   changed are both real, avoidable DOM cost at a 5 Hz readout rate -- and
   most of these nine rows sit at 0.00 for long stretches. Cache the former
   per container, skip the latter by remembering what was last written. */
const panelCache = new WeakMap();

function writeText(el, text, prev, key) {
  if (!el || prev[key] === text) return;
  el.textContent = text;
  prev[key] = text;
}

export function renderBehaviorPanel(container, panel) {
  let c = panelCache.get(container);
  if (!c) {
    c = { mode: container.querySelector('.beh-mode'), current: container.querySelector('.beh-current'),
          score: container.querySelector('.beh-score'), rows: {}, prev: {} };
    for (const b of BEHAVIOURS) {
      const row = container.querySelector(`.beh-row[data-b="${b}"]`);
      if (row) c.rows[b] = { row, bar: row.querySelector('.beh-bar > i'), num: row.querySelector('.beh-num') };
    }
    panelCache.set(container, c);
  }
  writeText(c.mode, panel.label, c.prev, 'mode');
  writeText(c.current, BEHAVIOUR_LABEL[panel.current], c.prev, 'current');
  writeText(c.score, `${panel.label}: ${panel.score.toFixed(2)}`, c.prev, 'score');
  for (const b of BEHAVIOURS) {
    const r = c.rows[b];
    if (!r) continue;
    const v = panel.values[b] || 0;
    const pct = `${Math.max(0, Math.min(100, v * 100)).toFixed(0)}%`;
    if (c.prev[`w${b}`] !== pct) { r.bar.style.width = pct; c.prev[`w${b}`] = pct; }
    writeText(r.num, v.toFixed(2), c.prev, `n${b}`);
    const on = b === panel.current;
    if (c.prev[`o${b}`] !== on) { r.row.classList.toggle('on', on); c.prev[`o${b}`] = on; }
  }
}

export function buildBehaviorRows(container) {
  container.innerHTML = BEHAVIOURS.map(b => `
    <div class="beh-row" data-b="${b}">
      <span class="beh-name">${BEHAVIOUR_LABEL[b]}</span>
      <span class="beh-bar"><i></i></span>
      <span class="beh-num mono">0.00</span>
    </div>`).join('');
}
