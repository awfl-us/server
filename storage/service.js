// Jobs and shared workflow modules use the same provider-neutral document API.
// Provider clients are constructed only at the composition boundary.
import { configuredNativeComponents } from './nativeMemory.js';

let configured;
let injectedClients;
/** Provider clients may be supplied once by a service composition/test root. */
export function configureDocumentStorageClients(clients) {
  if (configured || injectedClients) throw new Error('Document Storage has already been initialized');
  injectedClients = { ...clients };
}
export function getDocumentStorage() {
  if (!configured) {
    configured = configuredNativeComponents(injectedClients).then(({ storage }) => storage).catch(error => {
      configured = null;
      throw error;
    });
  }
  return configured;
}

// Read all matching documents with a stable document-path cursor. This avoids
// arbitrary truncation when an API historically returned an unbounded query.
export async function readDocuments(storage, spec, { maxDocs = 50000 } = {}) {
  if (!Number.isSafeInteger(maxDocs) || maxDocs < 1) throw new TypeError('invalid scan limit');
  const docs = [];
  // Firestore requires the first ordered field to match any inequality filter.
  const range = (spec.where||[]).find(f=>['<','<=','>','>='].includes(f.op));
  const orderBy = range ? {field:range.field,direction:'asc'} :
    {field:'__name__',direction:'asc'};
  let startAfter;
  do {
    const pageSize = Math.min(1000, maxDocs - docs.length + 1);
    const batch = await storage.query({ ...spec, orderBy,
      limit: pageSize,
      ...(startAfter && { startAfter }) });
    docs.push(...batch);
    if (docs.length > maxDocs) throw new Error('document scan exceeds maximum records');
    if (batch.length < pageSize) break;
    startAfter = batch.at(-1).path;
  } while (true);
  return docs;
}
