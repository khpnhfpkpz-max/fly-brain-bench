/* NEURAL GOD — Sensory -> Motor pipeline staging.

   This is a UI convenience grouping, not a biological classification. The
   connectome's own `super_class` annotation only distinguishes sensory /
   central / descending / motor / optic / visual_projection / ascending /
   endocrine / unknown; "interneuron" here just means "none of the above",
   folding several real annotated classes together for display. */

const SENSORY = new Set(['sensory', 'sensory_ascending']);
const INTER = new Set(['central', 'optic', 'visual_projection', 'visual_centrifugal', 'ascending']);

/* `hz` is the same per-neuron firing-rate array the rest of the page reads;
   `activeStimCount` is the exact size of the currently driven population
   (known deterministically, not derived from firing rate). `threshold` is the
   same "responding" cutoff already used elsewhere in this codebase
   (web/js/app.js's response-list panel uses 1 Hz). */
export function computeStageCounts({ dicts, labels, hz, activeStimCount, threshold = 1 }) {
  const scNames = dicts.super_class;
  const sc = labels.superClass;
  let sensory = 0, inter = 0, descending = 0, motor = 0;
  for (let i = 0; i < sc.length; i++) {
    if (hz[i] < threshold) continue;
    const name = scNames[sc[i]];
    if (SENSORY.has(name)) sensory++;
    else if (INTER.has(name)) inter++;
    else if (name === 'descending') descending++;
    else if (name === 'motor') motor++;
  }
  return {
    sensoryInput: activeStimCount,
    sensoryNeurons: sensory,
    interneurons: inter,
    descendingNeurons: descending,
    motorOutput: motor,
  };
}
