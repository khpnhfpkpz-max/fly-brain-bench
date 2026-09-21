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

export function renderBehaviorPanel(container, panel) {
  container.querySelector('.beh-mode').textContent = panel.label;
  container.querySelector('.beh-current').textContent = BEHAVIOUR_LABEL[panel.current];
  container.querySelector('.beh-score').textContent = `${panel.label}: ${panel.score.toFixed(2)}`;
  for (const b of BEHAVIOURS) {
    const row = container.querySelector(`.beh-row[data-b="${b}"]`);
    if (!row) continue;
    const v = panel.values[b] || 0;
    row.querySelector('.beh-bar > i').style.width = `${Math.max(0, Math.min(100, v * 100)).toFixed(0)}%`;
    row.querySelector('.beh-num').textContent = v.toFixed(2);
    row.classList.toggle('on', b === panel.current);
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
