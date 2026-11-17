// Native effects run with the authenticated execution's userId, but a single
// evaluator may create and operate on several projects belonging to that user.
// Only a project document in that user's own collection authorizes switching
// scope. A DSL-authored projectId or x-project-id is a request, not authority.
const ID = /^[A-Za-z0-9_-]{1,128}$/;

async function defaultStorage() {
  const { getDocumentStorage } = await import('../../storage/service.js');
  return getDocumentStorage();
}

export async function resolveNativeProjectIdentity(identity, {
  projectId, userId, getStorage = defaultStorage,
} = {}) {
  if (!identity || typeof identity.userId !== 'string' ||
      !identity.userId || identity.userId.includes('/') ||
      typeof identity.projectId !== 'string' || !ID.test(identity.projectId)) {
    throw new Error('trusted native execution identity required');
  }
  if (userId !== undefined && userId !== identity.userId) {
    throw new Error('native workflow may not switch authenticated user');
  }
  const requested = projectId === undefined ? identity.projectId : projectId;
  if (typeof requested !== 'string' || !ID.test(requested)) {
    throw new Error('invalid native target project');
  }
  if (requested === identity.projectId) return identity;
  const store = await getStorage();
  const doc = await store.get(`users/${identity.userId}/projects/${requested}`);
  if (!doc || doc.data?.id !== requested) {
    throw new Error('native target project is not owned by authenticated user');
  }
  return Object.freeze({ userId: identity.userId, projectId: requested });
}

// HTTP effects use the standard AWFL x-project-id header from Env; never
// select a target based on a body field that could mean something else.
export function nativeProjectHeader(headers) {
  if (headers == null) return undefined;
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('invalid native request headers');
  }
  let value;
  for (const [key, candidate] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'x-project-id') continue;
    if (value !== undefined && candidate !== value) {
      throw new Error('conflicting native project headers');
    }
    value = candidate;
  }
  return value;
}
