// The provider-independent document storage API. Provider SDKs never belong here.
// Paths mirror Firestore's alternating collection/document hierarchy.
export class StorageError extends Error {
  constructor(code, message) { super(message); this.name = 'StorageError'; this.code = code; }
}
export const fail = (code, message) => { throw new StorageError(code, message); };
const segment = x => typeof x === 'string' && x.length > 0 && x.length <= 512 &&
  x !== '.' && x !== '..' && !/[\/\u0000-\u001f]/.test(x);
export function validatePath(path, kind = 'document') {
  if (typeof path !== 'string' || !path || path.length > 1500) return fail('INVALID_PATH','invalid document path');
  const parts = path.split('/');
  if (!parts.every(segment) || (kind === 'document' && parts.length % 2 !== 0) ||
      (kind === 'collection' && parts.length % 2 !== 1)) return fail('INVALID_PATH','invalid document path');
  return path;
}
export function partsOf(path) {
  validatePath(path);
  const parts = path.split('/');
  return { path, collectionPath: parts.slice(0,-1).join('/'),
    collectionId: parts.at(-2), documentId: parts.at(-1) };
}
export function objectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail('INVALID_DATA','document must be a plain object');
  }
  let encoded;
  try { encoded = JSON.stringify(value); } catch { return fail('INVALID_DATA','document is not serializable'); }
  if (!encoded || Buffer.byteLength(encoded) > 1024 * 1024 ||
      !isPlainJson(value)) return fail('INVALID_DATA','document must be JSON-compatible and under 1 MiB');
  return JSON.parse(encoded);
}
function isPlainJson(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v));
  if (Array.isArray(v)) return v.every(isPlainJson);
  if (v && Object.getPrototypeOf(v) === Object.prototype) return Object.entries(v).every(([k,x]) => segment(k) && isPlainJson(x));
  return false;
}
export const patch = {
  increment: amount => ({op:'increment',amount}),
  serverTimestamp: () => ({op:'serverTimestamp'}),
  deleteField: () => ({op:'deleteField'}),
};
export function applyPatch(document, updates, clock = () => new Date()) {
  const result = objectValue(document);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return fail('INVALID_DATA','invalid patch');
  const paths=[];
  for (const [name,value] of Object.entries(updates)) {
    const steps=name.split('.');
    if (!steps.every(segment)) return fail('INVALID_DATA','invalid patch field');
    if (paths.some(p=>name===p || name.startsWith(p+'.') || p.startsWith(name+'.'))) return fail('INVALID_DATA','overlapping patch fields');
    paths.push(name);
    let cursor=result;
    for (const step of steps.slice(0,-1)) {
      if (!Object.hasOwn(cursor,step)) cursor[step]={};
      if (!cursor[step] || typeof cursor[step]!=='object' || Array.isArray(cursor[step])) return fail('INVALID_DATA','cannot traverse non-map');
      cursor=cursor[step];
    }
    const key=steps.at(-1);
    if (value?.op==='deleteField' && Object.keys(value).length===1) delete cursor[key];
    else if (value?.op==='serverTimestamp' && Object.keys(value).length===1) cursor[key]=clock().toISOString();
    else if (value?.op==='increment' && Object.keys(value).length===2) {
      if (typeof value.amount!=='number' || !Number.isFinite(value.amount)) return fail('INVALID_DATA','invalid increment');
      const previous=cursor[key]===undefined?0:cursor[key];
      if (typeof previous!=='number') return fail('INVALID_DATA','cannot increment non-number');
      cursor[key]=previous+value.amount;
      if (!Number.isFinite(cursor[key]) || (Number.isInteger(cursor[key])&&!Number.isSafeInteger(cursor[key]))) return fail('INVALID_DATA','unsafe increment');
    } else cursor[key]=value;
  }
  return objectValue(result);
}
// One Storage object must offer the full shape; an incomplete implementation
// cannot be selected as general production storage.
export function assertStorage(store) {
  for (const name of ['get','create','put','update','delete','query','count','listCollections',
    'batch','transaction','subscribe','close']) {
    if (typeof store?.[name]!=='function') throw new TypeError(`Storage missing ${name}`);
  }
  return store;
}
export function validateQuery(spec) {
  if (!spec || typeof spec!=='object' || (!!spec.collection===!!spec.collectionGroup)) return fail('INVALID_QUERY','collection or collectionGroup required');
  if (spec.collection) validatePath(spec.collection,'collection');
  if (spec.collectionGroup && !segment(spec.collectionGroup)) return fail('INVALID_QUERY','invalid collection group');
  const where=spec.where??[];
  if (!Array.isArray(where) || where.length>12 || where.some(f=>
    !f || typeof f.field!=='string' || !f.field.split('.').every(segment) ||
    !['==','!=','<','<=','>','>=','in','array-contains'].includes(f.op))) return fail('INVALID_QUERY','invalid filters');
  for (const f of where) {
    if (f.op==='in' && (!Array.isArray(f.value) || f.value.length<1 || f.value.length>30)) return fail('INVALID_QUERY','invalid in filter');
  }
  const order=spec.orderBy??{field:'__name__', direction:'asc'};
  if (!order || typeof order.field!=='string' ||
      (order.field!=='__name__' && !order.field.split('.').every(segment)) ||
      !['asc','desc'].includes(order.direction??'asc')) return fail('INVALID_QUERY','invalid orderBy');
  const limit=spec.limit??100;
  if (!Number.isSafeInteger(limit) || limit<1 || limit>1000) return fail('INVALID_QUERY','invalid limit');
  if (spec.startAfter!==undefined && (typeof spec.startAfter!=='string' || !spec.startAfter)) return fail('INVALID_QUERY','invalid startAfter cursor');
  if (spec.endBefore!==undefined && (typeof spec.endBefore!=='string' || !spec.endBefore)) return fail('INVALID_QUERY','invalid endBefore cursor');
  return { ...spec, where, orderBy:order, limit };
}
