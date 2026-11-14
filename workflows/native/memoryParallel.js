// Memory-first fork/join: all lanes belong to one authenticated root
// execution and have no independent Firestore state. The process-local
// scheduler limits in-flight external effects across nested forks without
// holding a permit while a parent awaits its children.
import { forkLaneId } from './forkCoordinator.js';
import { NativeConfirmedWorkflowFailure } from './effectErrors.js';

const MAX_LANES_PER_FORK = 1000;
const MAX_TOTAL_LANES = 4096;
const MAX_FORK_DEPTH = 3;
const MAX_IN_FLIGHT_EFFECTS = 8;
const ENTRY = /^pc_(0|[1-9][0-9]{0,8})$/;
const NODE = /^[A-Za-z0-9_.-]{1,120}$/;
const GENERATION = /^[A-Za-z0-9_.:-]{1,160}$/;
const SLOT = /^s[0-9]+$/;
// Distinguish a deliberately stopped sibling from a second independent
// failure, so a confirmed branch Raise is not replaced by cancellation noise.
export class NativeMemoryParallelStopped extends Error {
  constructor() {
    super('native parallel sibling stopped');
    this.name = 'NativeMemoryParallelStopped';
  }
}

// A waiting fork never consumes a permit. Only actual external effect
// handlers do, so arbitrarily nested parents cannot starve their children.
export function createMemoryParallelScheduler({
  maxEffects = MAX_IN_FLIGHT_EFFECTS,
  maxLanesPerFork = MAX_LANES_PER_FORK,
  maxTotalLanes = MAX_TOTAL_LANES,
  maxForkDepth = MAX_FORK_DEPTH,
} = {}) {
  if (!Number.isSafeInteger(maxEffects) || maxEffects < 1 || maxEffects > 64 ||
      !Number.isSafeInteger(maxLanesPerFork) || maxLanesPerFork < 1 || maxLanesPerFork > 10000 ||
      !Number.isSafeInteger(maxTotalLanes) || maxTotalLanes < 1 || maxTotalLanes > 100000 ||
      !Number.isSafeInteger(maxForkDepth) || maxForkDepth < 1 || maxForkDepth > 8) {
    throw new Error('invalid native memory parallel bounds');
  }
  let activeEffects = 0, totalLanes = 0;
  const waiting = [];

  const acquire = () => new Promise(resolve => {
    if (activeEffects < maxEffects) {
      activeEffects++;
      resolve();
    } else {
      waiting.push(resolve);
    }
  });
  const release = () => {
    if (waiting.length) waiting.shift()(); // transfer ownership of permit
    else activeEffects--;
  };

  return {
    async withEffectPermit(fn, shouldStop = () => false) {
      await acquire();
      try {
        if (shouldStop()) throw new NativeMemoryParallelStopped();
        return await fn();
      } finally {
        release();
      }
    },

    async runFork({
      effect, executionId, forkDepth, shouldStop = () => false, runLane,
    }) {
      if (typeof runLane !== 'function' ||
          !Number.isSafeInteger(forkDepth) || forkDepth < 0 ||
          forkDepth >= maxForkDepth ||
          !NODE.test(effect?.node_id || '') ||
          !GENERATION.test(effect?.args?.generation || '') ||
          !Array.isArray(effect?.args?.lanes) ||
          effect.args.lanes.length > maxLanesPerFork ||
          shouldStop()) {
        throw new Error('invalid native memory parallel fork');
      }
      const lanes = effect.args.lanes;
      // Reject malformed lane snapshots *before* starting any effect.
      for (const lane of lanes) {
        if (!lane || !ENTRY.test(lane.entry || '') ||
            !lane.slots || typeof lane.slots !== 'object' ||
            Array.isArray(lane.slots) ||
            Object.keys(lane.slots).some(k => !SLOT.test(k))) {
          throw new Error('invalid compiled native parallel lane');
        }
      }
      if (totalLanes + lanes.length > maxTotalLanes) {
        throw new Error('native memory parallel total lane budget exhausted');
      }
      totalLanes += lanes.length;
      const results = Array(lanes.length);
      let cursor = 0, failure = null;
      const errors = [];
      const stopped = () => Boolean(failure || shouldStop());
      const worker = async () => {
        while (cursor < lanes.length && !stopped()) {
          const index = cursor++;
          const lane = lanes[index];
          try {
            const laneId = forkLaneId({
              parentExecutionId: executionId,
              nodeId: effect.node_id,
              generation: effect.args.generation,
              index,
            });
            // The branch's slots must never be mutated by siblings.
            const snapshot = structuredClone(lane.slots);
            results[index] = await runLane({
              index, entry: Number(lane.entry.slice(3)),
              slots: snapshot, laneId, forkDepth: forkDepth + 1,
              shouldStop: stopped,
            });
          } catch (error) {
            errors.push(error);
            failure ||= error;
          }
        }
      };
      await Promise.all(Array.from({
        length: Math.min(maxEffects, lanes.length),
      }, worker));
      if (failure) {
        // Don't hide an uncertain effect/transport failure behind another
        // sibling's confirmed native failure.
        throw errors.find(e => !(e instanceof NativeConfirmedWorkflowFailure) &&
          !(e instanceof NativeMemoryParallelStopped)) || failure;
      }
      return results;
    },
    get activeEffects() { return activeEffects; },
    get totalLanes() { return totalLanes; },
  };
}
