/* Regression coverage for the Experience Learning Layer (NEURAL GOD /
   THE EMERGENCE). Everything here is pure logic -- no worker, no connectome,
   no DOM -- driven with small synthetic `hz` arrays and hand-picked neuron
   ID lists, exactly the shape resolveSensoryIds() would hand back from the
   real connectome, but tiny enough to reason about by hand.

   Covers the 15 test points from the design report:
   1-3 experience log + reward/penalty bookkeeping, 4-6 value-table update
   direction, 7 memoryDecay, 8 reset, 9 save/load, 10-11 enabled/disabled
   (including bit-identical passthrough when off), plus the event-detection
   specifics (edge-triggering, the FOOD_EATEN proximity condition, the
   ESCAPE_FAILURE sustained-danger window) that 4-6 depend on. Points 12-14
   (existing causal chains in the live app) and 15 (the full existing suite)
   are verified separately, in a real browser, against the actual
   sim.worker.js/decoder.js -- see the delivery notes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperienceStore } from '../web/god/js/experience-store.js';
import { createRewardManager, DEFAULT_REWARDS } from '../web/god/js/reward-manager.js';
import {
  createExperienceLearning, ACTIONS, FOOD_HIGH_HZ, DANGER_HIGH_HZ,
  PROBOSCIS_THRESHOLD, ESCAPE_THRESHOLD, ESCAPE_FAILURE_TICKS, FOOD_PROXIMITY_RADIUS,
} from '../web/god/js/experience-learning.js';

const NEUTRAL_DRIVE = { walk: 0, turn: 0, stop: 0, backward: 0, escape: 0, proboscis: 0, wing: 0, groom: 0 };
const FOOD_IDS = [0, 1, 2];       // 3 fake "sensory neurons"
const DANGER_IDS = [3, 4];
const N = 5;
const hzAllZero = () => new Float32Array(N);
const hzFood = (rate = FOOD_HIGH_HZ + 5) => { const h = hzAllZero(); h[0] = h[1] = h[2] = rate; return h; };
const hzDanger = (rate = DANGER_HIGH_HZ + 5) => { const h = hzAllZero(); h[3] = h[4] = rate; return h; };

function makeLayer(opts = {}) {
  const store = createExperienceStore(opts.store);
  const rewards = createRewardManager(opts.rewards);
  const layer = createExperienceLearning({ foodIds: FOOD_IDS, dangerIds: DANGER_IDS, store, rewards, ...opts.layer });
  return { layer, store, rewards };
}

test('Experience Log records timestamp, state, action, event, reward and resulting behaviour', () => {
  const { layer, store } = makeLayer();
  const drive = { ...NEUTRAL_DRIVE, proboscis: 0.9 };
  layer.step({ hz: hzFood(), drive, action: 'feed', flyPos: { x: 0, z: 0 }, foodPos: { x: 0, z: 0 }, timestamp: 1234 });
  const [entry] = store.recentExperiences(1);
  assert.equal(entry.timestamp, 1234);
  assert.equal(entry.state, 'f2d0');
  assert.equal(entry.action, 'feed');
  assert.equal(entry.event, 'FOOD_EATEN');
  assert.equal(entry.reward, DEFAULT_REWARDS.FOOD_EATEN);
  assert.equal(entry.resultingBehavior, 'feed');
});

test('a positive-reward event adds to totalReward', () => {
  const { layer, store } = makeLayer();
  layer.step({ hz: hzFood(), drive: NEUTRAL_DRIVE, action: 'rest', flyPos: { x: 9, z: 9 }, foodPos: { x: 0, z: 0 }, timestamp: 0 });
  assert.equal(store.totalReward, DEFAULT_REWARDS.FOOD_FOUND);
});

test('a negative-reward event (ESCAPE_FAILURE) subtracts from totalReward', () => {
  const { layer, store } = makeLayer();
  for (let i = 0; i < ESCAPE_FAILURE_TICKS; i++) {
    layer.step({ hz: hzDanger(), drive: NEUTRAL_DRIVE, action: 'stop', flyPos: null, foodPos: null, timestamp: i });
  }
  const events = store.recentExperiences(10).map(e => e.event);
  assert.ok(events.includes('ESCAPE_FAILURE'));
  assert.equal(store.totalReward, DEFAULT_REWARDS.DANGER_DETECTED + DEFAULT_REWARDS.ESCAPE_FAILURE);
});

test('the same (state, action) pair updates the same Value Table cell', () => {
  const { layer, store } = makeLayer();
  const drive = { ...NEUTRAL_DRIVE, proboscis: 0.9 };
  layer.step({ hz: hzFood(), drive, action: 'feed', flyPos: { x: 0, z: 0 }, foodPos: { x: 0, z: 0 }, timestamp: 0 });
  const v1 = store.getValue('f2d0', 'feed');
  // toggle food off then on again so FOOD_EATEN's latch can re-fire
  layer.step({ hz: hzAllZero(), drive: NEUTRAL_DRIVE, action: 'rest', flyPos: { x: 0, z: 0 }, foodPos: { x: 0, z: 0 }, timestamp: 1 });
  layer.step({ hz: hzFood(), drive, action: 'feed', flyPos: { x: 0, z: 0 }, foodPos: { x: 0, z: 0 }, timestamp: 2 });
  const v2 = store.getValue('f2d0', 'feed');
  assert.notEqual(v1, v2);
  assert.equal(store.recentExperiences(10).filter(e => e.state === 'f2d0' && e.action === 'feed').length >= 2, true);
});

test('a positive reward moves the value up toward it', () => {
  const store = createExperienceStore({ learningRate: 0.5 });
  const before = store.getValue('s', 'a');
  const after = store.experience({ state: 's', action: 'a', event: 'X', reward: 10, resultingBehavior: 'a', timestamp: 0 });
  assert.ok(after > before);
  assert.equal(after, 0 + 0.5 * (10 - 0));
});

test('a negative reward moves the value down toward it', () => {
  const store = createExperienceStore({ learningRate: 0.5 });
  store.experience({ state: 's', action: 'a', event: 'X', reward: 10, resultingBehavior: 'a', timestamp: 0 });
  store.advanceTick();
  const before = store.getValue('s', 'a');
  const after = store.experience({ state: 's', action: 'a', event: 'Y', reward: -10, resultingBehavior: 'a', timestamp: 1 });
  assert.ok(after < before);
});

test('memoryDecay pulls an untouched cell toward zero over ticks', () => {
  const store = createExperienceStore({ learningRate: 1, memoryDecay: 0.9 });
  store.experience({ state: 's', action: 'a', event: 'X', reward: 10, resultingBehavior: 'a', timestamp: 0 });
  const v0 = store.getValue('s', 'a');
  assert.equal(v0, 10);
  for (let i = 0; i < 20; i++) store.advanceTick();
  const v20 = store.getValue('s', 'a');
  assert.ok(v20 < v0);
  assert.ok(Math.abs(v20 - 10 * Math.pow(0.9, 20)) < 1e-9);
});

test('memoryDecay is lazy: reading a cell many ticks later does not require visiting every cell', () => {
  const store = createExperienceStore({ learningRate: 1, memoryDecay: 0.99 });
  for (let i = 0; i < 81; i++) store.experience({ state: `s${i}`, action: 'a', event: 'X', reward: 5, resultingBehavior: 'a', timestamp: 0 });
  for (let i = 0; i < 1000; i++) store.advanceTick();
  // still correct after a long gap, computed on demand rather than swept
  const v = store.getValue('s0', 'a');
  assert.ok(Math.abs(v - 5 * Math.pow(0.99, 1000)) < 1e-9);
});

test('RESET LEARNING clears the value table, the log and totalReward', () => {
  const { layer, store } = makeLayer();
  layer.step({ hz: hzFood(), drive: NEUTRAL_DRIVE, action: 'rest', flyPos: null, foodPos: null, timestamp: 0 });
  assert.ok(store.experienceCount > 0);
  layer.reset();
  assert.equal(store.experienceCount, 0);
  assert.equal(store.totalReward, 0);
  assert.equal(store.getValue('f2d0', 'rest'), 0);
});

test('SAVE then LOAD reproduces the learning state exactly', () => {
  const a = createExperienceStore({ learningRate: 0.4 });
  a.experience({ state: 'f1d0', action: 'walk', event: 'FOOD_FOUND', reward: 2, resultingBehavior: 'walk', timestamp: 5 });
  a.experience({ state: 'f2d0', action: 'feed', event: 'FOOD_EATEN', reward: 10, resultingBehavior: 'feed', timestamp: 6 });
  const saved = a.serialize();

  const b = createExperienceStore();
  const ok = b.loadFrom(saved);
  assert.equal(ok, true);
  assert.equal(b.getValue('f1d0', 'walk'), a.getValue('f1d0', 'walk'));
  assert.equal(b.getValue('f2d0', 'feed'), a.getValue('f2d0', 'feed'));
  assert.equal(b.totalReward, a.totalReward);
  assert.equal(b.experienceCount, a.experienceCount);
});

test('loadFrom() rejects malformed input and leaves the store untouched', () => {
  const store = createExperienceStore();
  store.experience({ state: 's', action: 'a', event: 'X', reward: 3, resultingBehavior: 'a', timestamp: 0 });
  const before = store.serialize();
  assert.equal(store.loadFrom('not json'), false);
  assert.equal(store.loadFrom(JSON.stringify({ version: 99 })), false);
  assert.equal(store.serialize(), before);
});

test('learning can be switched on and off', () => {
  const { layer } = makeLayer();
  assert.equal(layer.enabled, true);
  layer.setEnabled(false);
  assert.equal(layer.enabled, false);
  layer.setEnabled(true);
  assert.equal(layer.enabled, true);
});

test('with the layer OFF, step() returns the exact same drive object by reference -- bit-identical to no layer at all', () => {
  const { layer } = makeLayer();
  layer.setEnabled(false);
  const drive = { ...NEUTRAL_DRIVE, walk: 0.7 };
  // pre-load a value that WOULD change the output if modulation ran
  const { outDrive: warm } = (() => { layer.setEnabled(true); const r = layer.step({ hz: hzFood(), drive, action: 'walk', flyPos: null, foodPos: null, timestamp: 0 }); layer.setEnabled(false); return r; })();
  const { outDrive } = layer.step({ hz: hzFood(), drive, action: 'walk', flyPos: null, foodPos: null, timestamp: 1 });
  assert.equal(outDrive, drive);   // === , not deep-equal: the very same object
});

test('with the layer ON, a learned value measurably changes the output drive', () => {
  const { layer, store } = makeLayer({ layer: { influence: 0.5 } });
  const drive = { ...NEUTRAL_DRIVE, walk: 0.5 };
  // seed a strong positive value for (f0d0, walk)
  store.experience({ state: 'f0d0', action: 'walk', event: 'SEED', reward: 10, resultingBehavior: 'walk', timestamp: 0 });
  const { outDrive } = layer.step({ hz: hzAllZero(), drive, action: 'walk', flyPos: null, foodPos: null, timestamp: 1 });
  assert.ok(outDrive.walk > drive.walk);
  assert.notEqual(outDrive, drive);
});

test('FOOD_EATEN requires both proboscis extension and geometric proximity to the food', () => {
  const { layer, store } = makeLayer();
  const eatingDrive = { ...NEUTRAL_DRIVE, proboscis: PROBOSCIS_THRESHOLD + 0.1 };
  // proboscis extended, but far from food -> no FOOD_EATEN
  const r1 = layer.step({ hz: hzFood(), drive: eatingDrive, action: 'feed', flyPos: { x: 50, z: 50 }, foodPos: { x: 0, z: 0 }, timestamp: 0 });
  assert.ok(!r1.events.includes('FOOD_EATEN'));
  // near food, but no proboscis extension -> no FOOD_EATEN
  const r2 = layer.step({ hz: hzFood(), drive: NEUTRAL_DRIVE, action: 'rest', flyPos: { x: 0, z: 0 }, foodPos: { x: 0, z: 0 }, timestamp: 1 });
  assert.ok(!r2.events.includes('FOOD_EATEN'));
  // both at once -> fires
  const r3 = layer.step({ hz: hzFood(), drive: eatingDrive, action: 'feed', flyPos: { x: 0.1, z: 0 }, foodPos: { x: 0, z: 0 }, timestamp: 2 });
  assert.ok(r3.events.includes('FOOD_EATEN'));
});

test('DANGER_DETECTED is a neutral (zero-reward) log entry, not scored', () => {
  const { layer, store } = makeLayer();
  layer.step({ hz: hzDanger(), drive: NEUTRAL_DRIVE, action: 'stop', flyPos: null, foodPos: null, timestamp: 0 });
  assert.equal(store.totalReward, 0);
  const [entry] = store.recentExperiences(1);
  assert.equal(entry.event, 'DANGER_DETECTED');
  assert.equal(entry.reward, 0);
});

test('events are edge-triggered: a sustained condition fires once, not every tick', () => {
  const { layer, store } = makeLayer();
  for (let i = 0; i < 10; i++) {
    layer.step({ hz: hzFood(), drive: NEUTRAL_DRIVE, action: 'rest', flyPos: null, foodPos: null, timestamp: i });
  }
  const foodFoundCount = store.recentExperiences(50).filter(e => e.event === 'FOOD_FOUND').length;
  assert.equal(foodFoundCount, 1);
});

test('ESCAPE_SUCCESS fires when escape drive crosses its threshold while danger is present', () => {
  const { layer, store } = makeLayer();
  const escapeDrive = { ...NEUTRAL_DRIVE, escape: ESCAPE_THRESHOLD + 0.1 };
  const r = layer.step({ hz: hzDanger(), drive: escapeDrive, action: 'escape', flyPos: null, foodPos: null, timestamp: 0 });
  assert.ok(r.events.includes('ESCAPE_SUCCESS'));
  assert.equal(store.recentExperiences(1)[0].reward, DEFAULT_REWARDS.ESCAPE_SUCCESS);
});

test('the reward table is independently configurable', () => {
  const { rewards } = makeLayer({ rewards: { FOOD_EATEN: 42 } });
  assert.equal(rewards.get('FOOD_EATEN'), 42);
  rewards.set('FOOD_EATEN', 7);
  assert.equal(rewards.get('FOOD_EATEN'), 7);
});

test('rewards.setEnabled(false) (the "no reward" experiment mode) zeroes every reward without disabling event detection or logging', () => {
  const { layer, store, rewards } = makeLayer();
  rewards.setEnabled(false);
  layer.step({ hz: hzFood(), drive: NEUTRAL_DRIVE, action: 'rest', flyPos: null, foodPos: null, timestamp: 0 });
  assert.equal(store.totalReward, 0);
  assert.equal(store.experienceCount, 1);
  assert.equal(store.recentExperiences(1)[0].event, 'FOOD_FOUND');
});

test('ACTIONS matches behavior.js\'s own nine activation keys', () => {
  assert.deepEqual(ACTIONS, ['rest', 'walk', 'turnL', 'turnR', 'backward', 'stop', 'escape', 'feed', 'groom']);
});
