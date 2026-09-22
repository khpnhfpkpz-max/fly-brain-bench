/* NEURAL GOD -- Scenario presets.

   A scenario is nothing but a named bundle of World Control values, applied
   through the exact same `applyValues()` path a person's own hand on the
   sliders and toggles uses (world-control.js). It cannot combine anything
   World Control itself could not: every field here names a control that is
   either wired to a real preset in web/js/presets.js, or (predator) a
   visual-only prop, matching WORLD_CONTROLS in world-control.js exactly.

   Light and Wind are never set by a scenario. They drive nothing in the
   simulation (see world-control.js), so a scenario "turning up the wind"
   would be a cosmetic change dressed up as an environmental one -- exactly
   what this project's honesty rules ruled out. Whatever the person last set
   them to is left alone. */
export const SCENARIOS = [
  {
    id: 'default', name: 'Default Arena',
    description: 'The arena at rest: ambient temperature and humidity, a faint food smell, nothing direct.',
    values: {
      temperature: 24, humidity: 50, foodScent: 60,
      food: false, pheromone: false, visual: false, touch: false, predator: false,
    },
  },
  {
    id: 'foraging', name: 'Foraging',
    description: 'Food underfoot as well as its scent -- sugar on the proboscis (LB3) plus a stronger ORN_DM1/DM2 drive.',
    values: {
      temperature: 24, humidity: 50, foodScent: 85,
      food: true, pheromone: false, visual: false, touch: false, predator: false,
    },
  },
  {
    id: 'threat', name: 'Threat',
    description: 'Something expanding in the visual field (LPLC2) with the predator prop shown -- this model’s only measured "something is coming at you" signal.',
    values: {
      temperature: 24, humidity: 50, foodScent: 60,
      food: false, pheromone: false, visual: true, touch: false, predator: true,
    },
  },
  {
    id: 'courtship', name: 'Courtship',
    description: 'The cVA pheromone channel (ORN_DA1) -- the most studied labelled line in the fly.',
    values: {
      temperature: 24, humidity: 50, foodScent: 60,
      food: false, pheromone: true, visual: false, touch: false, predator: false,
    },
  },
  {
    id: 'grooming', name: 'Grooming',
    description: 'A speck of dust on the eye (BM_InOm bristle mechanosensory neurons).',
    values: {
      temperature: 24, humidity: 50, foodScent: 60,
      food: false, pheromone: false, visual: false, touch: true, predator: false,
    },
  },
];
