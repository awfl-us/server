// Durable, bounded child scheduling for future native CFG fork/join.
// NOT wired to the public launcher or effect dispatcher until a compiled
// branch-entry protocol and parent effect journal are implemented.
import { createHash } from 'node:crypto';

const EXECUTION = /^native_[a-f0-9]{32}$/;
const NODE = /^[A-Za-z0-9_.-]{1,120}$/;
const GENERATION = /^[A-Za-z0-9_.:-]{1,160}$/;
const SELECTOR = /^[A-Za-z0-9_.-]{1,120}$/;
const SHA = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A lane identity is independent of the Scala label and input value. */
export function forkLaneId({ parentExecutionId, nodeId, generation, index }) {
  if (!EXECUTION.test(parentExecutionId || '') || !NODE.test(nodeId || '') ||
      !GENERATION.test(generation || '') || !Number.isSafeInteger(index) || index < 0 || index >= 10000) {
    throw new Error('invalid native fork lane identity');
  }
  return 'native_' + digest([parentExecutionId, nodeId, generation, index]).slice(0, 32);
}

function parentFields(parent, effectId, nodeId) {
  if (!parent || !EXECUTION.test(parent.executionId || '') ||
      typeof parent.userId !== 'string' || !parent.userId ||
      typeof parent.projectId !== 'string' || !parent.projectId ||
      typeof parent.workflowName !== 'string' || !parent.workflowName ||
      !SHA.test(parent.artifactSha256 || '') ||
      parent.protocolVersion !== 2 || parent.parallelVersion !== 1 ||
      !Array.isArray(parent.allowedOperations) ||
      parent.pendingEffect?.effectId !== effectId ||
      parent.pendingEffect?.nodeId !== nodeId ||
      parent.pendingEffect?.operation !== 'native.parallel') {
    throw new Error('unauthorized or unpinned native fork intent');
  }
  return parent;
}

/**
 * A future native.parallel handler calls this only after persisting the
 * authenticated parent fork intent in the ordinary native effect journal.
 * The server's runLane callback must execute the pinned child artifact via
 * the existing NativeExecutionStore lease/journal, NEVER an unjournaled
 * direct network effect. We do not wire that callback until the compiled
 * branch selector is available.
 */
export class NativeForkCoordinator {
  constructor({ store, runLane, maxConcurrency = 8, maxLanes = 1000 }) {
    if (!store?.create || !store?.get || typeof runLane !== 'function' ||
        !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64 ||
        !Number.isSafeInteger(maxLanes) || maxLanes < 1 || maxLanes > 10000) {
      throw new Error('native fork requires a durable store, lane runner and bounded capacity');
    }
    this.store = store;
    this.runLane = runLane;
    this.maxConcurrency = maxConcurrency;
    this.maxLanes = maxLanes;
  }

  async execute({ parent, effectId, nodeId, generation, lanes }) {
    parentFields(parent, effectId, nodeId);
    if (!GENERATION.test(generation || '') || !Array.isArray(lanes) ||
        lanes.length > this.maxLanes) throw new Error('native fork exceeds bounded lane limits');
    const results = Array(lanes.length);
    let cursor = 0, firstError;

    const run = async () => {
      while (cursor < lanes.length && !firstError) {
        const index = cursor++;
        const lane = lanes[index];
        try {
          if (!lane || !SELECTOR.test(lane.entry || '') ||
              !lane.slots || Array.isArray(lane.slots) || typeof lane.slots !== 'object') {
            throw new Error('invalid compiled native branch entry or slot snapshot');
          }
          const childId = forkLaneId({
            parentExecutionId: parent.executionId, nodeId, generation, index,
          });
          const forkLane = {
            parentExecutionId: parent.executionId, nodeId, generation,
            index, entry: lane.entry,
            snapshotSha256: digest({ input: parent.input, slots: lane.slots, entry: lane.entry }),
            slots: lane.slots,
          };
          const create = {
            executionId: childId, userId: parent.userId, projectId: parent.projectId,
            workflowName: parent.workflowName, artifactSha256: parent.artifactSha256,
            input: parent.input, protocolVersion: parent.protocolVersion,
            allowedOperations: parent.allowedOperations,
            ...(parent.trustedGlobalsVersion === 1 && { trustedGlobalsVersion: 1 }),
            parallelVersion: 1, forkLane,
          };
          let stored = await this.store.get(childId);
          if (!stored) {
            try { stored = await this.store.create(create); }
            catch (error) {
              // Another worker may have won the deterministic child-create
              // transaction; only a genuine persisted duplicate is reusable.
              if (error.code !== 'CONFLICT') throw error;
              stored = await this.store.get(childId);
            }
          }
          if (!stored || stored.parallelVersion !== 1 ||
              stored.protocolVersion !== parent.protocolVersion ||
              stored.workflowName !== parent.workflowName ||
              stored.trustedGlobalsVersion !== parent.trustedGlobalsVersion ||
              stored.forkLane?.nodeId !== nodeId ||
              stored.forkLane?.generation !== generation ||
              stored.forkLane?.index !== index ||
              stored.forkLane?.parentExecutionId !== parent.executionId ||
              stored.forkLane?.entry !== lane.entry ||
              stored.executionId !== childId ||
              stored.userId !== parent.userId || stored.projectId !== parent.projectId ||
              stored.artifactSha256 !== parent.artifactSha256 ||
              stored.forkLane?.snapshotSha256 !== forkLane.snapshotSha256 ||
              stored.forkLane?.parentExecutionId !== parent.executionId ||
              stored.forkLane?.index !== index || stored.forkLane?.entry !== lane.entry) {
            throw new Error('persisted native fork lane identity mismatch');
          }
          if (stored.status === 'failed' || stored.status === 'cancelled') {
            throw new Error('native fork lane failed or was cancelled');
          }
          if (stored.status !== 'completed') {
            await this.runLane({ executionId: childId, userId: parent.userId,
              projectId: parent.projectId, parentExecutionId: parent.executionId,
              nodeId, generation, index });
            stored = await this.store.get(childId);
          }
          if (stored?.status !== 'completed') {
            throw new Error('native fork lane has no durable completed result');
          }
          results[index] = stored.result;
        } catch (error) {
          firstError ||= error; // Allow already-running siblings to settle.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxConcurrency, lanes.length) }, run));
    if (firstError) throw firstError;
    return results; // Input order, not completion order.
  }
}
