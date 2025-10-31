// collapseGroupReplacer filter
// Replaces sequences of messages that belong to the same collapsed group with a single
// synthetic placeholder message per group, preserving first-occurrence order.
//
// Behavior summary:
// - Build a mapping from message docId -> { groupName, responseId, description?, items? }
//   by reading (user-scoped when available):
//     users/{userId}/convo.sessions/{sessionId}/indexes/collapsed/messageToGroups/{docId}
//   or (legacy, non-user-scoped):
//     convo.sessions/{sessionId}/indexes/collapsed/messageToGroups/{docId}
//   and, optionally, users/{userId}/convo.sessions/{sessionId}/collapsed/{responseId}
//   (or legacy: convo.sessions/{sessionId}/collapsed/{responseId}) for richer fields.
//   Note: CollapseResponse documents may have shape `{ groups: [...] }` or `{ create_time, value: { groups: [...] } }`.
// - Iterate messages in order; collect those with docIds in the mapping.
// - For each unique group (by name), emit a single synthetic message at the position
//   of its first occurrence and remove the matched originals for that group.
// - Synthetic message content is a JSON-encoded string: {
//     type: 'collapsed_group',
//     name: string,
//     responseId: string,
//     description?: string,
//     items?: any
//   }
//   (Note: messageIds are no longer included in the placeholder payload.)
// - Idempotent within one pass: emits at most one placeholder per group.
// - No-op if sessionId is missing or no docIds present.
//
// Extended behavior (2025-10):
// - Respect per-group UI state stored at indexes/collapsed/groupState/{GROUP}.
//   If a group's state.expanded === true, do NOT collapse that group; pass through
//   the original messages and annotate each message with { collapsedGroupId, collapsedGroup }
//   so the UI can offer a re-collapse toggle and differentiate rendering.

import { getFirestore } from 'firebase-admin/firestore';
import { projectScopedCollectionPath } from '../../userAuth.js';

function isAlreadyCollapsedGroup(msg) {
  if (!msg || typeof msg.content !== 'string') return false;
  try {
    const parsed = JSON.parse(msg.content);
    return parsed && parsed.type === 'collapsed_group' && typeof parsed.name === 'string';
  } catch (_) {
    return false;
  }
}

// Lightweight, opt-in logger with levels. Controlled by (in priority order):
//   ctx.logger (object with info/warn/error/debug) or console
//   level: ctx.logLevel || options.logLevel || process.env.COLLAPSE_LOG_LEVEL || 'warn'
//   sample: options.logSample || 20
function makeLogger(options = {}, ctx = {}) {
  const level = String(ctx?.logLevel || options?.logLevel || process.env.COLLAPSE_LOG_LEVEL || 'warn').toLowerCase();
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = levels[level] ?? 1;
  const base = (ctx && ctx.logger) ? ctx.logger : console;
  const prefix = '[collapseGroupReplacer]';
  const wrap = (method) => (...args) => {
    const rank = levels[method];
    if (rank <= threshold && typeof base[method] === 'function') {
      try { base[method](prefix, ...args); } catch (_) { /* noop */ }
    }
  };
  return {
    error: wrap('error'),
    warn: wrap('warn'),
    info: wrap('info'),
    debug: wrap('debug'),
    sample: Number.isFinite(options?.logSample) ? options.logSample : 20,
  };
}

function sessionRootRef(db, { userId, projectId, sessionId }) {
  if (!sessionId) return null;
  return db.collection(projectScopedCollectionPath(userId, projectId, 'convo.sessions')).doc(String(sessionId));
}

async function fetchMessageGroupMappings(userId, projectId, sessionId, docIds) {
  if (!sessionId || !Array.isArray(docIds) || docIds.length === 0) return new Map();
  const db = getFirestore();
  const root = sessionRootRef(db, { userId, projectId, sessionId });
  if (!root) return new Map();
  const base = root
    .collection('indexes')
    .doc('collapsed')
    .collection('messageToGroups');

  // Fetch per-message mapping docs
  const mappings = new Map(); // docId -> { groupName, responseId, updated_at }

  // Firestore has no batch get by IDs API in admin SDK; perform parallel gets in chunks
  const CHUNK = 300; // conservative parallelism
  for (let i = 0; i < docIds.length; i += CHUNK) {
    const chunk = docIds.slice(i, i + CHUNK);
    const reads = chunk.map(id => base.doc(String(id)).get());
    const snaps = await Promise.all(reads);
    for (let idx = 0; idx < snaps.length; idx++) {
      const snap = snaps[idx];
      if (!snap.exists) continue;
      const data = snap.data() || {};
      const groupsMap = data.groups && typeof data.groups === 'object' ? data.groups : {};
      // Choose the group entry with the most recent updated_at
      let chosen = null;
      for (const [gName, entry] of Object.entries(groupsMap)) {
        if (!entry || !entry.responseId) continue;
        const updated_at = typeof entry.updated_at === 'number' ? entry.updated_at : 0;
        if (!chosen || updated_at > chosen.updated_at) {
          chosen = { groupName: gName, responseId: entry.responseId, updated_at };
        }
      }
      if (chosen) mappings.set(String(chunk[idx]), chosen);
    }
  }
  return mappings;
}

async function fetchResponseGroups(userId, projectId, sessionId, responseIds) {
  if (!sessionId || responseIds.length === 0) return new Map();
  const db = getFirestore();
  const root = sessionRootRef(db, { userId, projectId, sessionId });
  if (!root) return new Map();
  const base = root.collection('collapsed');
  const unique = Array.from(new Set(responseIds));
  const CHUNK = 50;
  const result = new Map(); // responseId -> CollapseResponse data
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const reads = chunk.map(id => base.doc(String(id)).get());
    const snaps = await Promise.all(reads);
    for (let j = 0; j < snaps.length; j++) {
      const snap = snaps[j];
      if (!snap.exists) continue;
      const data = snap.data() || {};
      result.set(String(chunk[j]), data);
    }
  }
  return result;
}

async function fetchGroupStates(userId, projectId, sessionId, groupNames) {
  // Read indexes/collapsed/groupState/{GROUP} for provided groupNames
  if (!sessionId || !Array.isArray(groupNames) || groupNames.length === 0) return new Map();
  const db = getFirestore();
  const root = sessionRootRef(db, { userId, projectId, sessionId });
  if (!root) return new Map();
  const base = root
    .collection('indexes')
    .doc('collapsed')
    .collection('groupState');

  const unique = Array.from(new Set(groupNames));
  const CHUNK = 200;
  const states = new Map(); // groupName -> { expanded?: boolean, responseId?: string, updated_at?: number }
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const reads = chunk.map(name => base.doc(String(name)).get());
    const snaps = await Promise.all(reads);
    for (let j = 0; j < snaps.length; j++) {
      const snap = snaps[j];
      if (!snap.exists) continue;
      const data = snap.data() || {};
      states.set(String(chunk[j]), { expanded: !!data.expanded, responseId: data.responseId ? String(data.responseId) : undefined, updated_at: typeof data.updated_at === 'number' ? data.updated_at : undefined });
    }
  }
  return states;
}

export async function collapseGroupReplacer(messages, options = {}, ctx = {}) {
  const log = makeLogger(options, ctx);
  try {
    const sessionId = ctx?.sessionId || options?.sessionId;
    const userId = ctx?.userId || options?.userId;
    if (!sessionId) {
      log.debug('No sessionId found in ctx/options; returning original messages.');
      return messages;
    }
    const projectId = ctx?.projectId;

    log.info('Start', { sessionIdPresent: !!sessionId, userScoped: !!userId, messageCount: Array.isArray(messages) ? messages.length : 0 });

    // Collect candidate docIds from messages that have a docId and are not already collapsed placeholders
    const docIdsInOrder = [];
    let alreadyCollapsedSeen = 0;
    for (const m of messages) {
      if (!m) continue;
      if (isAlreadyCollapsedGroup(m)) { alreadyCollapsedSeen++; continue; }
      const id = m.docId || m.docID || m.id; // tolerate different field casings if present
      if (id) docIdsInOrder.push(String(id));
    }
    if (docIdsInOrder.length === 0) {
      log.info('No docIds found on messages; collapse is a no-op. Ensure includeDocId=true.', { alreadyCollapsedSeen });
      return messages;
    }

    const uniqueDocIds = Array.from(new Set(docIdsInOrder));
    if (uniqueDocIds.length !== docIdsInOrder.length) {
      log.debug('Duplicate docIds detected; de-duplicated.', { total: docIdsInOrder.length, unique: uniqueDocIds.length });
    }
    if (log.sample > 0) {
      log.debug('Sample docIds', uniqueDocIds.slice(0, log.sample));
    }

    // Build docId -> { groupName, responseId }
    const idToGroup = await fetchMessageGroupMappings(userId, projectId, sessionId, uniqueDocIds);
    log.info('Loaded message->group mappings', { mappedCount: idToGroup.size });
    if (idToGroup.size === 0) {
      log.info('No mappings found for provided docIds; pass-through.');
      return messages;
    }

    // Determine which responseIds we need to load for optional description/items enrichment
    const neededResponseIds = Array.from(new Set(Array.from(idToGroup.values()).map(v => v.responseId).filter(Boolean)));
    log.debug('Needed responseIds', { count: neededResponseIds.length, sample: neededResponseIds.slice(0, log.sample) });

    const responseDataMap = await fetchResponseGroups(userId, projectId, sessionId, neededResponseIds);
    log.debug('Loaded response data for enrichment', { responseCount: responseDataMap.size });

    // First pass: collect grouping and track first-occurrence index
    const groupOrder = [];
    const groupToInfo = new Map(); // groupName -> { responseId, messageIds: [], description?, items? }
    const firstIndexOfGroup = new Map(); // groupName -> index in messages where first occurred

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || isAlreadyCollapsedGroup(m)) continue;
      const id = m.docId || m.docID || m.id;
      if (!id) continue;
      const mapping = idToGroup.get(String(id));
      if (!mapping) continue;
      const { groupName, responseId } = mapping;
      if (!groupToInfo.has(groupName)) {
        groupToInfo.set(groupName, { responseId, messageIds: [] });
        groupOrder.push(groupName);
        firstIndexOfGroup.set(groupName, i);
      }
      const info = groupToInfo.get(groupName);
      info.messageIds.push(String(id));
    }

    if (groupOrder.length === 0) {
      log.info('No groups matched among messages with IDs; pass-through.');
      return messages;
    }

    if (log.sample > 0) {
      log.info('Discovered groups', { groupCount: groupOrder.length, groupsSample: groupOrder.slice(0, log.sample) });
    } else {
      log.info('Discovered groups', { groupCount: groupOrder.length });
    }

    // Fetch per-group UI states (expanded true/false)
    const groupStates = await fetchGroupStates(userId, projectId, sessionId, groupOrder);
    const expandedGroups = new Set(Array.from(groupStates.entries()).filter(([, st]) => st && st.expanded === true).map(([name]) => name));
    log.info('Loaded group states', { states: groupStates.size, expandedCount: expandedGroups.size, expandedSample: Array.from(expandedGroups).slice(0, log.sample) });

    // Optional enrichment: fill description/items from CollapseResponse
    for (const groupName of groupOrder) {
      const info = groupToInfo.get(groupName);
      const resp = responseDataMap.get(String(info.responseId));
      // Normalize groups array from possible shapes
      const groupsArr = Array.isArray(resp?.groups)
        ? resp.groups
        : (Array.isArray(resp?.value?.groups) ? resp.value.groups : []);

      // Try to match by name (case-insensitive). If names are missing and there is exactly one group, take it.
      let found = groupsArr.find(g => String(g?.name || g?.group || '').toUpperCase() === String(groupName).toUpperCase());
      if (!found && groupsArr.length === 1) found = groupsArr[0];

      if (found) {
        const description = typeof found.description === 'string'
          ? found.description
          : (typeof found?.params?.description === 'string' ? found.params.description : (typeof found?.value?.description === 'string' ? found.value.description : undefined));
        if (typeof description === 'string') info.description = description;

        const items = Array.isArray(found.items) ? found.items : (Array.isArray(found?.value?.items) ? found.value.items : undefined);
        if (items) info.items = items;
      }
    }

    // Second pass: build the new message list by replacing the first occurrence of each group
    const newMessages = [];
    const emittedGroups = new Set();
    let removedCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const id = m && !isAlreadyCollapsedGroup(m) ? (m.docId || m.docID || m.id) : null;
      if (!id) {
        // Not a candidate; pass through
        newMessages.push(m);
        continue;
      }

      const mapping = idToGroup.get(String(id));
      if (!mapping) {
        newMessages.push(m);
        continue;
      }

      const { groupName } = mapping;
      const groupIsExpanded = expandedGroups.has(groupName);

      if (groupIsExpanded) {
        // Respect expanded state: pass through original, annotated for UI controls
        const info = groupToInfo.get(groupName) || {};
        const annotated = {
          ...m,
          collapsedGroupId: groupName,
          collapsedGroup: {
            name: groupName,
            expanded: true,
            responseId: info.responseId || mapping.responseId || undefined,
          },
        };
        newMessages.push(annotated);
        continue;
      }

      // Otherwise, collapse: skip originals and insert a single placeholder at first occurrence
      const isFirst = firstIndexOfGroup.get(groupName) === i;
      removedCount++;
      if (isFirst && !emittedGroups.has(groupName)) {
        const info = groupToInfo.get(groupName) || {};
        const payload = {
          type: 'collapsed_group',
          name: groupName,
          responseId: info.responseId || '',
        };
        if (info.description) payload.description = info.description;
        if (info.items) payload.items = info.items;

        newMessages.push({ role: 'system', content: JSON.stringify(payload) });
        emittedGroups.add(groupName);
        log.debug('Emitted placeholder', {
          groupName,
          firstIndex: i,
          responseId: payload.responseId,
          hasDescription: !!info.description,
        });
      }
      // Skip the original matched message (always), since it's replaced by the group placeholder
    }

    log.info('Completed replacement', {
      inputMessages: messages.length,
      outputMessages: newMessages.length,
      placeholdersEmitted: emittedGroups.size,
      originalsRemoved: removedCount,
    });

    return newMessages;
  } catch (err) {
    const log = makeLogger(options, ctx);
    log.error('collapseGroupReplacer error', { message: err?.message, stack: err?.stack });
    // Fail open: return original messages on any error
    return messages;
  }
}

export default { collapseGroupReplacer };
