// Shared Prakriya/Yoj/Ista helpers (JS server-side)
// Centralizes Firestore access, path builders, Kala promotion, and Yoj message building
// so routers can remain thin and mirror the modular Scala structure.

import { getDocumentStorage, readDocuments } from '../../../storage/service.js';
import { projectScopedCollectionPath } from '../../userAuth.js';
import { timestampContextMessage } from './chronologicalMessages.js';

// -----------------------------------
// Collection path helpers
// -----------------------------------
export const convoCollection = (sessionId, name) => `convo.sessions/${sessionId}/${name}`;
export const logSessionsCollection = (name) => `log.sessions.${name}`;
export const logWeeklyCollection = (name) => `log.weekly.${name}`;
export const logTermsCollection = (name) => `log.terms.${name}`;

// -----------------------------------
// Generic document Storage readers
// -----------------------------------
export async function listBetweenFlat(userId, projectId, collectionPath, begin, end, opts={}) {
  const store=await getDocumentStorage();
  const where=[
    {field:'create_time',op:opts.includeBegin ? '>=' : '>',value:begin},
    {field:'create_time',op:'<=',value:end + (opts.publishedAheadSeconds || 0)},
  ];
  if(opts.user_id!=null&&String(opts.user_id))
    where.push({field:'user_id',op:'==',value:opts.user_id});
  const docs=await readDocuments(store,{
    collection:projectScopedCollectionPath(userId,projectId,collectionPath),where,
  });
  // A summary may be written before its logical Kala end. Only expose the
  // ahead-of-window document once it *actually exists* as of this read's end;
  // historical reads must not pull a document created in the future.
  const eligible = opts.publishedAheadSeconds ? docs.filter(doc => {
    if (doc.data.create_time <= end) return true;
    const writtenAt = Date.parse(doc.createdAt ?? '');
    return Number.isFinite(writtenAt) && writtenAt / 1000 <= end;
  }) : docs;
  eligible.sort((a,b)=>a.data.create_time-b.data.create_time||a.path.localeCompare(b.path));
  return eligible.map(doc=>({id:doc.id,data:doc.data,createdAt:doc.createdAt}));
}

export async function listBetween(userId, projectId, collectionPath, begin, end, opts={}) {
  const documents=await listBetweenFlat(userId,projectId,collectionPath,begin,end,opts);
  const store=await getDocumentStorage();
  const scoped=projectScopedCollectionPath(userId,projectId,collectionPath);
  return {documents:await Promise.all(documents.map(async d=>({
    ...d,subcollections:await store.listCollections(`${scoped}/${d.id}`),
  })))};
}

export async function readDoc(userId, projectId, collectionPath, id) {
  const scoped=projectScopedCollectionPath(userId,projectId,collectionPath);
  const doc=await (await getDocumentStorage()).get(`${scoped}/${id}`);
  return doc?.data??null;
}

// -----------------------------------
// Kala utilities and promotion
// -----------------------------------
export const WEEK_SECONDS = 7 * 24 * 60 * 60;
export const WEEK_ORIGIN = 259200; // aligns with Scala: 259200 seconds
export const QUARTER_SECONDS = (365.230769 * 24 * 60 * 60) / 4;

export function kalaLabel(kala) {
  switch (kala?.kind) {
    case 'SegKala':
      return '(Convo) ';
    case 'SessionKala':
      return '(Session) ';
    case 'WeekKala':
      return '(Week) ';
    case 'TermKala':
      return '(Term) ';
    default:
      return '';
  }
}

export function toWeekEnd(endSeconds) {
  const n = Math.floor((endSeconds - WEEK_ORIGIN) / WEEK_SECONDS);
  return WEEK_ORIGIN + (n + 1) * WEEK_SECONDS;
}

export function toTermBounds(endSeconds) {
  const n = Math.floor((endSeconds - 0) / QUARTER_SECONDS);
  const begin = 0 + n * QUARTER_SECONDS;
  const end = 0 + (n + 1) * QUARTER_SECONDS;
  return { begin, end };
}

export function promoteKala(kala) {
  if (!kala || !kala.kind) return null;
  switch (kala.kind) {
    case 'SegKala': {
      const { sessionId, end } = kala;
      const sessionEnd = end;
      return { kind: 'SessionKala', sessionId, sessionEnd };
    }
    case 'SessionKala': {
      const { sessionEnd } = kala;
      const weekEnd = toWeekEnd(sessionEnd);
      return { kind: 'WeekKala', weekEnd };
    }
    case 'WeekKala': {
      const { weekEnd } = kala;
      const { begin, end } = toTermBounds(weekEnd);
      return { kind: 'TermKala', begin, end };
    }
    case 'TermKala':
      return null; // terminal case
    default:
      return null;
  }
}

// -----------------------------------
// Yoj builders (maps records -> ChatMessage-like {role, content} or raw payloads)
// -----------------------------------
export async function buildYojMessages({ name, kala, userId, projectId, framing = '', includeDocId = false }) {
  // Preserve prior behavior: omit raw chat message history for any Kala except SegKala
  if (name === 'messages' && kala?.kind !== 'SegKala') {
    return [];
  }

  let documents = [];

  switch (kala.kind) {
    case 'SegKala': {
      const { sessionId, end, windowSeconds } = kala;
      const begin = end - windowSeconds;
      // SegKala windows are anchored at the first message timestamp. Include
      // that exact lower boundary for chat messages; otherwise the first
      // message is silently omitted from the initial summary. Keep the
      // existing exclusive lower bound for summary reads and all other Kala.
      documents = await listBetweenFlat(userId, projectId, convoCollection(sessionId, name), begin, end,
        { includeBegin: name === 'messages',
          // These records use the FUTURE Kala window-end as `create_time`,
          // even when written early. Include already-persisted results from
          // the 20-minute segment lookahead, not just matured window ends.
          publishedAheadSeconds: ['summaries', 'topicInfos', 'topicInfo'].includes(name) ? 1200 : 0 });
      break;
    }
    case 'SessionKala': {
      const { sessionId, sessionEnd } = kala;
      const eightHours = sessionEnd - 60 * 60 * 8;
      const sessions = await listBetweenFlat(userId, projectId, convoCollection(sessionId, name), eightHours, sessionEnd);
      documents = sessions;
      break;
    }
    case 'WeekKala': {
      const { weekEnd } = kala;
      const weekBegin = weekEnd - WEEK_SECONDS;
      // Return all session-level documents during the week window (one per session)
      documents = await listBetweenFlat(
        userId,
        projectId,
        logSessionsCollection(name),
        weekBegin,
        weekEnd
      );
      break;
    }
    case 'TermKala': {
      const { begin, end } = kala;
      documents = await listBetweenFlat(userId, projectId, logWeeklyCollection(name), begin, end);
      break;
    }
    default:
      documents = [];
  }

  const label = kalaLabel(kala);

  // Reinstate legacy behavior: encode summaries and topicInfos as system chat messages
  if (name === 'summaries' || name === 'topicInfos' || name === 'topicInfo') {
    return documents.map((doc) => {
      const datum = doc?.data ?? {};
      const value = (datum && typeof datum === 'object' && 'value' in datum) ? datum.value : datum;
      const msg = { role: 'system', content: `${label}${framing}${JSON.stringify(value)}` };
      // Copy cost and callingExecId/currentExecId from wrapper (same level as create_time) back into message if present
      const wrapperCost = datum && typeof datum === 'object' ? datum.cost : undefined;
      const wrapperExecId = datum && typeof datum === 'object' ? datum.execId : undefined;
      if (wrapperCost !== undefined) {
        msg.cost = msg.cost === undefined ? wrapperCost : msg.cost;
      }
      if (wrapperExecId !== undefined && msg.execId === undefined) {
        msg.execId = wrapperExecId;
      }
      if (includeDocId && doc?.id) msg.docId = doc.id;
      // Kala create_time is the logical segment END. It may be in the future
      // when the summary finishes before the segment closes. Keep that value
      // for window/dedup queries, but order this generated system message by
      // when its storage document was actually inserted.
      const insertedAt = Date.parse(doc?.createdAt ?? '');
      return timestampContextMessage(msg,
        Number.isFinite(insertedAt) ? insertedAt / 1000 : datum.create_time);
    });
  }

  // For raw chat history, return exactly as stored in Firestore, but copy wrapper cost/callingExecId/currentExecId back onto the message object
  if (name === 'messages') {
    return documents.map((doc) => {
      const datum = doc?.data ?? {};
      const wrapperCost = datum && typeof datum === 'object' ? datum.cost : undefined;
      const wrapperExecId = datum && typeof datum === 'object' ? datum.execId : undefined;
      const value = datum?.value ?? {};

      if (value && typeof value === 'object') {
        // Create a shallow copy to avoid mutating the original
        const msg = { ...value };
        if (wrapperCost !== undefined && msg.cost === undefined) {
          msg.cost = wrapperCost; // place next to content/tool_calls/etc.
        }
        if (wrapperExecId !== undefined && msg.execId === undefined) {
          msg.execId = wrapperExecId;
        }
        if (includeDocId) msg.docId = doc.id;
        return timestampContextMessage(msg, datum.create_time);
      }
      // Non-object payloads are returned as-is
      return value;
    });
  }

  // Default: return the original message payloads without added labels/framing or stringification.
  // If a message-like object is detected (has a role), also backfill cost/callingExecId/currentExecId from the wrapper when available.
  return documents.map((doc) => {
    const datum = doc?.data ?? {};
    if (datum && typeof datum === 'object' && 'value' in datum && datum.value != null) {
      const wrapperCost = datum.cost;
      const wrapperCallingExecId = datum.callingExecId;
      const wrapperCurrentExecId = datum.currentExecId;
      const value = datum.value;
      if (value && typeof value === 'object') {
        const msg = { ...value };
        if (wrapperCost !== undefined && msg.cost === undefined && 'role' in msg) {
          msg.cost = wrapperCost;
        }
        if (wrapperCallingExecId !== undefined && msg.callingExecId === undefined && 'role' in msg) {
          msg.callingExecId = wrapperCallingExecId;
        }
        if (wrapperCurrentExecId !== undefined && msg.currentExecId === undefined && 'role' in msg) {
          msg.currentExecId = wrapperCurrentExecId;
        }
        if (includeDocId) msg.docId = doc.id;
        return timestampContextMessage(msg, datum.create_time);
      }
      return value;
    }
    // datum is already the payload
    if (includeDocId && datum && typeof datum === 'object') {
      return timestampContextMessage({ ...datum, docId: doc.id }, datum.create_time);
    }
    return timestampContextMessage(datum, datum?.create_time);
  });
}
