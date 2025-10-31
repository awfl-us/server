// Shared Prakriya/Yoj/Ista helpers (JS server-side)
// Centralizes Firestore access, path builders, Kala promotion, and Yoj message building
// so routers can remain thin and mirror the modular Scala structure.

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { projectScopedCollectionPath } from '../../userAuth.js';

// Ensure Firebase Admin is initialized once
if (!getApps().length) {
  initializeApp();
}

export const db = getFirestore();

// -----------------------------------
// Collection path helpers
// -----------------------------------
export const convoCollection = (sessionId, name) => `convo.sessions/${sessionId}/${name}`;
export const logSessionsCollection = (name) => `log.sessions.${name}`;
export const logWeeklyCollection = (name) => `log.weekly.${name}`;
export const logTermsCollection = (name) => `log.terms.${name}`;

// -----------------------------------
// Generic Firestore readers
// -----------------------------------
export async function listBetween(userId, projectId, collectionPath, begin, end, opts = {}) {
  let ref = db.collection(projectScopedCollectionPath(userId, projectId, collectionPath));
  if (opts.user_id !== undefined && opts.user_id !== null && `${opts.user_id}`.length > 0) {
    ref = ref.where('user_id', '==', opts.user_id);
  }
  const snapshot = await ref
    .where('create_time', '>', begin)
    .where('create_time', '<=', end)
    .orderBy('create_time', 'asc')
    .get();

  const documents = await Promise.all(
    snapshot.docs.map(async (doc) => {
      const subcollections = await doc.ref.listCollections();
      return {
        id: doc.id,
        data: doc.data() ?? {},
        subcollections: subcollections.map((s) => s.id),
      };
    })
  );
  return { documents };
}

export async function listBetweenFlat(userId, projectId, collectionPath, begin, end, opts = {}) {
  // Variant that returns a flat array of { id, data }
  let ref = db.collection(projectScopedCollectionPath(userId, projectId, collectionPath));
  if (opts.user_id !== undefined && opts.user_id !== null && `${opts.user_id}`.length > 0) {
    ref = ref.where('user_id', '==', opts.user_id);
  }
  const snapshot = await ref
    .where('create_time', '>', begin)
    .where('create_time', '<=', end)
    .orderBy('create_time', 'asc')
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} }));
}

export async function readDoc(userId, projectId, collectionPath, id) {
  const docRef = db.collection(projectScopedCollectionPath(userId, projectId, collectionPath)).doc(id);
  const docSnap = await docRef.get();
  if (!docSnap.exists) return null;
  return docSnap.data();
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
      documents = await listBetweenFlat(userId, projectId, convoCollection(sessionId, name), begin, end);
      break;
    }
    case 'SessionKala': {
      const { sessionId, sessionEnd } = kala;
      const eightHours = sessionEnd - (60 * 60 * 8)
      const sessions = await listBetweenFlat(userId, projectId, convoCollection(sessionId, name), eightHours, sessionEnd);
      const weeklyDoc = await readDoc(userId, projectId, logSessionsCollection(name), sessionId);

      let weeklyDocuments = [];
      if (weeklyDoc) {
        if (Array.isArray(weeklyDoc.documents)) {
          weeklyDocuments = weeklyDoc.documents.map((d, idx) => ({ id: `${sessionId}#${idx}`, data: d.data ?? d }));
        } else {
          weeklyDocuments = [{ id: sessionId, data: weeklyDoc }];
        }
      }
      documents = [...sessions, ...weeklyDocuments];
      break;
    }
    case 'WeekKala': {
      // Yoj.read returns empty for WeekKala in Scala
      documents = [];
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
      return msg;
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
        return msg;
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
        return msg;
      }
      return value;
    }
    // datum is already the payload
    if (includeDocId && datum && typeof datum === 'object') {
      return { ...datum, docId: doc.id };
    }
    return datum;
  });
}
