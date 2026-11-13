// The native equivalent of googleapis.storage.v1.objects.get(alt=media)
// for AWFL's IAM-managed workflow-files bucket. Artifact authors cannot
// redirect Jobs credentials to an arbitrary Cloud Storage bucket.
const MAX_FILE_BYTES = 128 * 1024;
const BUCKET = 'awfl-us-workflow-files';
const PLACEHOLDER = '${workflow_env}';

export function createNativeStorageEffectHandler({
  storage, bucket = BUCKET,
} = {}) {
  if (!storage?.bucket || !/^[a-z][a-z0-9-]{2,120}$/.test(bucket)) {
    throw new Error('trusted native workflow storage configuration required');
  }
  return async ({ args, identity }) => {
    if (typeof identity?.userId !== 'string' || !identity.userId ||
        typeof identity?.projectId !== 'string' || !identity.projectId ||
        !args || typeof args !== 'object' || Array.isArray(args) ||
        args.alt !== 'media' || typeof args.object !== 'string' ||
        typeof args.bucket !== 'string' ||
        Object.keys(args).some(key => !['bucket', 'object', 'alt'].includes(key))) {
      throw new Error('invalid trusted native storage effect request');
    }
    const expected = bucket + (process.env.WORKFLOW_ENV || '');
    const actual = args.bucket.endsWith(PLACEHOLDER)
      ? args.bucket.slice(0, -PLACEHOLDER.length) + (process.env.WORKFLOW_ENV || '')
      : args.bucket;
    if (actual !== expected) {
      throw new Error('native storage read outside workflow file bucket');
    }
    let object;
    try { object = decodeURIComponent(args.object); }
    catch { throw new Error('invalid native storage object path'); }
    if (object.length === 0 || object.length > 512 ||
        object.startsWith('/') || object.includes('\\') ||
        object.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('invalid native storage object path');
    }
    const [meta] = await storage.bucket(actual).file(object).getMetadata();
    const length = Number(meta.size);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_BYTES) {
      throw new Error('native workflow storage read exceeds size limit');
    }
    const [content] = await storage.bucket(actual).file(object).download();
    if (content.length !== length || content.length > MAX_FILE_BYTES) {
      throw new Error('native workflow storage file size changed');
    }
    return content.toString('utf8');
  };
}
