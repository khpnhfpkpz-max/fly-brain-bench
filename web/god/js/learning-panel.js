/* NEURAL GOD -- Experience Learning Layer: the LEARNING panel's DOM.

   Same discipline as behavior.js: element lookups cached per container, a
   write only happens when the text/width/class actually changed. Called at
   the same ~5 Hz readout() already runs at -- nothing here is driven by the
   animation frame loop.

   "Action Value", never "probability" or "confidence": these are the plain
   value = value + learningRate * (reward - value) numbers the design report
   promised, not a softmax over anything. */
import { ACTIONS } from './experience-learning.js';

const ACTION_LABEL = {
  rest: 'Rest', walk: 'Walk', turnL: 'Turn left', turnR: 'Turn right',
  backward: 'Backward', stop: 'Stop', escape: 'Escape', feed: 'Feed (proboscis)', groom: 'Groom',
};
const EVENT_LABEL = {
  FOOD_FOUND: 'Food found', FOOD_EATEN: 'Food eaten', DANGER_DETECTED: 'Danger detected',
  ESCAPE_SUCCESS: 'Escape success', ESCAPE_FAILURE: 'Escape failure', COLLISION: 'Collision',
};
const VALUE_SCALE = 15;   // +-15 maps to the full width of the bar; values rarely exceed this given the default rewards (max magnitude 10) and learningRate <= 1

function writeText(el, text, prev, key) {
  if (!el || prev[key] === text) return;
  el.textContent = text; prev[key] = text;
}

export function buildLearningActionRows(container) {
  container.innerHTML = ACTIONS.map(a => `
    <div class="lrn-row" data-a="${a}">
      <span class="lrn-name">${ACTION_LABEL[a]}</span>
      <span class="lrn-bar"><i class="lrn-bar-fill"></i><i class="lrn-bar-zero"></i></span>
      <span class="lrn-num mono">0.00</span>
    </div>`).join('');
}

export function buildRewardsUI(container, rewards, onChange) {
  const all = rewards.all();
  container.innerHTML = Object.keys(all).map(event => `
    <label class="lrn-reward-row">
      <span>${EVENT_LABEL[event] || event}</span>
      <input type="number" step="1" class="mono" data-event="${event}" value="${all[event]}">
    </label>`).join('');
  container.querySelectorAll('input[data-event]').forEach(input => {
    input.addEventListener('change', () => {
      rewards.set(input.dataset.event, input.value);
      onChange?.();
    });
  });
}

const panelCache = new WeakMap();

export function renderLearningPanel(container, snapshot) {
  let c = panelCache.get(container);
  if (!c) {
    c = {
      count: container.querySelector('#lrnCount'),
      totalReward: container.querySelector('#lrnTotalReward'),
      currentReward: container.querySelector('#lrnCurrentReward'),
      cellsTouched: container.querySelector('#lrnCellsTouched'),
      stateLabel: container.querySelector('#lrnStateLabel'),
      log: container.querySelector('#lrnLog'),
      rows: {}, prev: {},
    };
    for (const a of ACTIONS) {
      const row = container.querySelector(`.lrn-row[data-a="${a}"]`);
      if (row) c.rows[a] = { fill: row.querySelector('.lrn-bar-fill'), num: row.querySelector('.lrn-num') };
    }
    panelCache.set(container, c);
  }

  writeText(c.count, String(snapshot.experienceCount), c.prev, 'count');
  writeText(c.totalReward, snapshot.totalReward.toFixed(0), c.prev, 'totalReward');
  writeText(c.currentReward, snapshot.currentReward.toFixed(0), c.prev, 'currentReward');
  writeText(c.cellsTouched, `${snapshot.cellsTouched}/${snapshot.cellsTotal}`, c.prev, 'cellsTouched');
  writeText(c.stateLabel, `state ${snapshot.stateKey}`, c.prev, 'stateLabel');

  for (const a of ACTIONS) {
    const r = c.rows[a];
    if (!r) continue;
    const v = snapshot.actionValues[a] || 0;
    const clamped = Math.max(-VALUE_SCALE, Math.min(VALUE_SCALE, v));
    const pct = ((clamped + VALUE_SCALE) / (2 * VALUE_SCALE)) * 100;
    const widthKey = `w${a}`, numKey = `n${a}`, signKey = `s${a}`;
    const widthStr = `${pct.toFixed(1)}%`;
    if (c.prev[widthKey] !== widthStr) { r.fill.style.width = widthStr; c.prev[widthKey] = widthStr; }
    const sign = v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : 'zero';
    if (c.prev[signKey] !== sign) { r.fill.className = `lrn-bar-fill ${sign}`; c.prev[signKey] = sign; }
    writeText(r.num, v.toFixed(2), c.prev, numKey);
  }

  if (c.log) {
    const key = snapshot.recent.map(e => `${e.timestamp}`).join(',');
    if (c.prev.logKey !== key) {
      c.prev.logKey = key;
      c.log.innerHTML = snapshot.recent.length
        ? snapshot.recent.map(e => `
          <div class="lrn-log-row">
            <span class="mono lrn-log-t">${(e.timestamp / 1000).toFixed(1)}s</span>
            <span>${EVENT_LABEL[e.event] || e.event}</span>
            <span class="dim">${e.state} &rarr; ${ACTION_LABEL[e.action] || e.action}</span>
            <span class="mono ${e.reward > 0 ? 'lrn-reward-pos' : e.reward < 0 ? 'lrn-reward-neg' : ''}">${e.reward > 0 ? '+' : ''}${e.reward}</span>
          </div>`).join('')
        : '<p class="dim lrn-log-empty">No experiences logged yet.</p>';
    }
  }
}
