/* NEURAL GOD -- Experience Learning Layer.

   Brain -> Behavior candidates -> Experience Learning Layer -> Action
   selection -> World, exactly as agreed in the design report. This module
   never touches the connectome, the LIF engine, the decoder's own logic or
   sim.worker.js -- it only reads `hz` (already-measured firing rates),
   `drive` (the decoder's already-decoded output) and the fly's world
   position, and produces a *second*, separate drive object for the world to
   actually move by. `drive` itself is never mutated, so anything holding a
   reference to it (the Behavior panel, the Inspector, the Overlay) keeps
   seeing the Brain's own unmodified output.

   This is a simulated behavioural-learning layer, not a claim that the
   FlyWire connectome itself is learning anything -- see the README section
   this ships with.

   ---- STATE ----
   (foodLevel, dangerLevel), each in {0,1,2}: 9 combinations, `f${0..2}d${0..2}`.
   Both are measured from `hz[]` over the real sensory neuron IDs the
   matching World Control preset already drives (the same resolvePreset()
   this repository's own world-control.js uses) -- i.e. an actual firing-rate
   readout of a real cell population, not an echo of a UI slider position.
   Light, Wind and Predator are deliberately left out of STATE: none of them
   drives any sensory population in this connectome (world-control.js's own
   "Not connected" badges), so a value keyed on one of them would be a table
   of things the brain never actually sensed. Temperature/Humidity do have
   real channels but are left out of v1 (see the design report) -- adding
   them later only means widening `encodeState()`, nothing else changes.

   ---- ACTION ----
   One of behavior.js's own nine activation keys (`rest / walk / turnL /
   turnR / backward / stop / escape / feed / groom`) -- the same vocabulary
   already shown in the Behavior panel, not a second one invented here.

   ---- EVENTS ----
   Edge-triggered (fire once per episode, not once per tick the condition
   holds), so a sustained state can never inflate reward without bound:
   - FOOD_FOUND      : foodLevel rises from 0 to >0
   - FOOD_EATEN      : drive.proboscis crosses its threshold *while the fly
                        is within FOOD_PROXIMITY_RADIUS of the food's actual
                        3D position* -- proboscis extension alone is not
                        "eating" if the fly is nowhere near the food
   - DANGER_DETECTED : dangerLevel rises from 0 to >0 (reward 0 -- a neutral
                        log entry, not scored)
   - ESCAPE_SUCCESS   : drive.escape crosses its threshold while danger is present
   - ESCAPE_FAILURE   : danger has been present for ESCAPE_FAILURE_TICKS
                        readouts in a row without drive.escape ever crossing
                        its threshold in that stretch
   COLLISION and DEATH/SURVIVAL are never emitted -- see reward-manager.js
   and the design report for why. */
import { resolvePreset } from '../../js/presets.js';

export const ACTIONS = ['rest', 'walk', 'turnL', 'turnR', 'backward', 'stop', 'escape', 'feed', 'groom'];

/* Discretisation thresholds for the two measured sensory levels. Calibrated
   against this build's own real, measured response, not guessed round
   numbers: with the 'sugar'+'food' presets driven continuously, the 244
   resolved neurons' mean rate fluctuated in roughly 0.2-3.5 Hz over an 8-tick
   window (this recurrent network's own noise, not a bug); with 'loom'
   driven, the 210 LPLC2 neurons' mean rate fluctuated in roughly 0-6.5 Hz.
   world-control.js's own measured-response comment notes the same kind of
   population (tens to low-hundreds of cells) never reaches anywhere near
   the connectome's ~15 Hz "fully saturated" range on its own -- these
   thresholds are picked to sit inside the band this build's own presets
   actually produce, so all three levels (0/1/2) are reachable, rather than
   a HIGH threshold so far above the real range that level 2 can never
   occur. */
export const FOOD_LOW_HZ = 0.5, FOOD_HIGH_HZ = 2.5;
export const DANGER_LOW_HZ = 0.5, DANGER_HIGH_HZ = 3.5;

export const PROBOSCIS_THRESHOLD = 0.5;
export const ESCAPE_THRESHOLD = 0.5;
/* World units. Measured, not guessed: the food sits at a fixed (0.62, 0.34)
   -- distance 0.71 from the fly's spawn point at the origin -- and this
   build has no directed navigation (see the design report), so over a
   30-second run with food and looming both driven continuously the fly's
   own undirected wandering stayed within about 0.34 units of the origin,
   never bringing it closer than about 0.68 to the food. A radius smaller
   than that would make FOOD_EATEN structurally unreachable regardless of
   how well anything "learned"; 1.0 comfortably covers the fly's actual,
   measured range of motion around its resting position while still
   excluding it during a large excursion (a long escape run, for instance). */
export const FOOD_PROXIMITY_RADIUS = 1.0;
export const ESCAPE_FAILURE_TICKS = 5;         // ~1s of sustained danger at the 200ms readout cadence

/* Resolves the same two preset -> neuron-ID lists world-control.js already
   builds for its own stimulus wiring, through the same public resolvePreset()
   API -- world-control.js itself is not imported or modified. "food" is the
   union of the two presets that can make foodLevel > 0 (direct contact via
   'sugar' and the scent channel via 'food'), matching how a person can make
   the fly detect food either way from World Control. */
export function resolveSensoryIds(dicts, labels) {
  const byId = id => (id ? resolvePreset({ match: PRESET_MATCH[id] }, labels, dicts) : []);
  return {
    foodIds: [...new Set([...byId('sugar'), ...byId('food')])],
    dangerIds: byId('loom'),
  };
}
/* Mirrors presets.js's own three `match` blocks exactly (cellType/cellClass
   lists), so this file does not need to import the whole PRESETS array just
   to pick three entries back out of it. */
const PRESET_MATCH = {
  sugar: { cellType: ['LB3'] },
  food: { cellType: ['ORN_DM1', 'ORN_DM2'] },
  loom: { cellType: ['LPLC2'] },
};

function measureLevel(hz, ids, lowHz, highHz) {
  if (!ids.length) return 0;
  let s = 0;
  for (let i = 0; i < ids.length; i++) s += hz[ids[i]];
  const mean = s / ids.length;
  return mean >= highHz ? 2 : mean >= lowHz ? 1 : 0;
}

const dist2d = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/* Bounded, symmetric multiplier: value 0 -> 1x (no change); saturates toward
   1±influence as |value| grows, so a learned value can never suppress a
   candidate to zero or amplify it without bound. This modulates *how
   strongly* an already-existing candidate is expressed -- it cannot invent
   a behaviour the Brain did not already propose, matching the "which of the
   existing candidates" framing agreed on in the design report. */
function multiplierFor(value, influence) {
  return 1 + Math.tanh(value / 10) * influence;
}

export function createExperienceLearning({ foodIds = [], dangerIds = [], store, rewards, influence = 0.3 } = {}) {
  let enabled = true;
  let prevFoodLevel = 0, prevDangerLevel = 0;
  let foodEatenLatched = false, escapeSuccessLatched = false, escapeFailureLatched = false;
  let dangerSustainTicks = 0;

  function step({ hz, drive, action, flyPos, foodPos, timestamp }) {
    store.advanceTick();

    const foodLevel = measureLevel(hz, foodIds, FOOD_LOW_HZ, FOOD_HIGH_HZ);
    const dangerLevel = measureLevel(hz, dangerIds, DANGER_LOW_HZ, DANGER_HIGH_HZ);
    const stateKey = `f${foodLevel}d${dangerLevel}`;

    const events = [];
    if (foodLevel > 0 && prevFoodLevel === 0) events.push('FOOD_FOUND');

    const nearFood = !!foodPos && !!flyPos && dist2d(flyPos.x, flyPos.z, foodPos.x, foodPos.z) < FOOD_PROXIMITY_RADIUS;
    const eating = nearFood && drive.proboscis >= PROBOSCIS_THRESHOLD;
    if (eating && !foodEatenLatched) events.push('FOOD_EATEN');
    foodEatenLatched = eating;

    if (dangerLevel > 0 && prevDangerLevel === 0) events.push('DANGER_DETECTED');

    const escaping = dangerLevel > 0 && drive.escape >= ESCAPE_THRESHOLD;
    if (escaping && !escapeSuccessLatched) events.push('ESCAPE_SUCCESS');
    escapeSuccessLatched = dangerLevel > 0 && escaping;

    if (dangerLevel > 0 && !escaping) {
      dangerSustainTicks++;
      if (dangerSustainTicks === ESCAPE_FAILURE_TICKS && !escapeFailureLatched) {
        events.push('ESCAPE_FAILURE');
        escapeFailureLatched = true;
      }
    } else {
      dangerSustainTicks = 0;
      if (dangerLevel === 0) escapeFailureLatched = false;
    }

    prevFoodLevel = foodLevel;
    prevDangerLevel = dangerLevel;

    let currentReward = 0;
    for (const event of events) {
      const reward = rewards.get(event);
      store.experience({ state: stateKey, action, event, reward, resultingBehavior: action, timestamp });
      currentReward = reward;
    }

    const outDrive = enabled ? modulate(drive, stateKey) : drive;
    return { outDrive, stateKey, foodLevel, dangerLevel, events, currentReward };
  }

  function modulate(drive, stateKey) {
    const m = {};
    for (const a of ACTIONS) m[a] = multiplierFor(store.getValue(stateKey, a), influence);
    return {
      ...drive,
      walk: drive.walk * m.walk,
      turn: drive.turn >= 0 ? drive.turn * m.turnR : drive.turn * m.turnL,
      stop: drive.stop * m.stop,
      backward: drive.backward * m.backward,
      escape: drive.escape * m.escape,
      proboscis: drive.proboscis * m.feed,
      // wing/groom: no independent action-value drives them -- rules() ties
      // wing to escape/wing channels directly and always returns groom:0,
      // so there is nothing meaningful to modulate for either yet.
    };
  }

  return {
    step,
    setEnabled(v) { enabled = !!v; },
    get enabled() { return enabled; },
    setInfluence(v) { influence = Number(v) || 0; },
    get influence() { return influence; },
    reset() {
      prevFoodLevel = 0; prevDangerLevel = 0;
      foodEatenLatched = false; escapeSuccessLatched = false; escapeFailureLatched = false;
      dangerSustainTicks = 0;
      store.reset();
    },
  };
}
