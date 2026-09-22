/* NEURAL GOD -- Experience Learning Layer: reward table.

   A plain lookup from event name to a number, nothing else. Kept as its own
   tiny module (rather than a constant inside experience-learning.js) so the
   values can be read and changed independently -- from the LEARNING panel's
   UI, from a test, or later from a different reward scheme entirely, without
   touching the event-detection or value-update code at all.

   COLLISION and DEATH are two different situations, both worth naming
   explicitly rather than silently:
   - COLLISION is kept here (at the value the spec asked for) even though
     nothing in this build ever emits it -- world-view.js/fly-rig.js have no
     collision geometry, so detecting it truthfully is out of scope for this
     phase (see the design report). The constant exists so the table has a
     place for it the day collision detection is added, without a reward-side
     change at that point.
   - DEATH/SURVIVAL are left out of this table entirely on purpose: this
     simulation has no concept of the fly dying, and inventing a reward for
     an event that structurally cannot fire would be exactly the kind of
     "looks complete but isn't real" this project's honesty rules forbid. */
export const DEFAULT_REWARDS = {
  FOOD_EATEN: 10,
  ESCAPE_SUCCESS: 10,
  FOOD_FOUND: 2,
  DANGER_DETECTED: 0,
  COLLISION: -5,   // never emitted in this build -- see above
  ESCAPE_FAILURE: -10,
};

export function createRewardManager(overrides = {}) {
  const rewards = { ...DEFAULT_REWARDS, ...overrides };
  let enabled = true;   // the "no reward" experiment mode: events still fire and are still logged, every reward just reads as 0

  return {
    get(event) {
      if (!enabled) return 0;
      return event in rewards ? rewards[event] : 0;
    },
    set(event, value) {
      rewards[event] = Number(value) || 0;
    },
    all() { return { ...rewards }; },
    setEnabled(v) { enabled = !!v; },
    get enabled() { return enabled; },
    reset() {
      for (const k of Object.keys(rewards)) delete rewards[k];
      Object.assign(rewards, DEFAULT_REWARDS);
      enabled = true;
    },
  };
}
