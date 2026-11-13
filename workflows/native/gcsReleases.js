// GCP IAM is the sole native deployment authority. Only a trusted release
// identity can write active mappings and content-addressed executable objects.
// The Workflows/Jobs services read them with their own GCP service identity.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const SHA = /^[a-f0-9]{64}$/;
const OPERATIONS = new Set(['http.get', 'http.post', 'http.patch', 'http.delete', 'log.write', 'native.parallel', 'workflow.run', 'storage.object_get', 'callback.create', 'callback.await']);
const MAX_METADATA = 16 * 1024;
const MAX_EXECUTABLE = 64 * 1024 * 1024;
// Content-addressed artifact bytes may be cached only in the trusted Jobs
// process. Bound the cache, and still stage a fresh private executable per run.
const MAX_CACHED_ARTIFACT = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 4;

function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error('invalid native workflow release name');
  }
  return name;
}

function validateRelease(data, expectedName) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      data.schemaVersion !== 1 || data.workflowName !== expectedName ||
      !SHA.test(data.artifactSha256 || '') ||
      data.protocolVersion !== 2 || data.runtimeAbi !== 3 ||
      (data.trustedGlobalsVersion !== undefined && data.trustedGlobalsVersion !== 1) ||
      (data.parallelVersion !== undefined && data.parallelVersion !== 1) ||
      (data.parallelVersion === 1) !==
        (Array.isArray(data.allowedOperations) &&
         data.allowedOperations.includes('native.parallel')) ||
      !Array.isArray(data.allowedOperations) ||
      data.allowedOperations.length > OPERATIONS.size ||
      data.allowedOperations.some(op => !OPERATIONS.has(op)) ||
      new Set(data.allowedOperations).size !== data.allowedOperations.length) {
    throw new Error('invalid IAM-published native release manifest');
  }
  return Object.freeze({
    workflowName: expectedName,
    sha256: data.artifactSha256,
    protocolVersion: 2,
    allowedOperations: Object.freeze([...data.allowedOperations]),
    ...(data.trustedGlobalsVersion === 1 && { trustedGlobalsVersion: 1 }),
    ...(data.parallelVersion === 1 && { parallelVersion: 1 }),
  });
}

function isNotFound(error) {
  return error?.code === 404 || error?.code === '404';
}

async function boundedDownload(file, limit) {
  const [metadata] = await file.getMetadata();
  const declared = Number(metadata.size);
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > limit) {
    throw new Error('native GCS artifact exceeds allowed size');
  }
  // Metadata size is not enough: enforce a byte cap while streaming, and
  // validate the SHA-256 before any binary is executed.
  const parts = [];
  let read = 0;
  for await (const part of file.createReadStream()) {
    read += part.length;
    if (read > limit || read > declared) {
      throw new Error('native GCS artifact exceeds allowed size');
    }
    parts.push(part);
  }
  if (read !== declared) throw new Error('native GCS artifact size changed');
  return Buffer.concat(parts, read);
}

/** Read-only release registry, never a deployment/upload API. */
export class NativeGcsReleases {
  constructor({ storage, bucket, prefix = 'native-workflows', verifiedCache = null }) {
    if (!storage?.bucket || typeof bucket !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{2,220}$/.test(bucket) ||
        typeof prefix !== 'string' ||
        !/^[a-z0-9][a-z0-9/-]{0,100}$/.test(prefix) ||
        prefix.includes('//') || prefix.includes('..') || prefix.endsWith('/')) {
      throw new Error('trusted GCS native release configuration required');
    }
    if (verifiedCache !== null && !(verifiedCache instanceof Map)) {
      throw new Error('verified native artifact cache must be a Map');
    }
    this.bucket = storage.bucket(bucket);
    this.bucketName = bucket;
    this.prefix = prefix;
    this.verifiedCache = verifiedCache;
  }

  async active(workflowName) {
    checkName(workflowName);
    const object = this.bucket.file(this.prefix + '/active/' + workflowName + '.json');
    let bytes;
    try {
      bytes = await boundedDownload(object, MAX_METADATA);
    } catch (error) {
      // No native release means use the original Google Workflow. Permission,
      // network and malformed manifest errors must NOT silently downgrade.
      if (isNotFound(error)) return null;
      throw error;
    }
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch {
      throw new Error('invalid IAM-published native release JSON');
    }
    return validateRelease(data, workflowName);
  }

  /** Materialize the exact digest pinned on the Firestore execution.
    * The caller must delete this private directory after the worker exits.
    */
  async materialize(sha256) {
    if (!SHA.test(sha256 || '')) throw new Error('pinned native artifact digest required');
    const cacheKey = `${this.bucketName}/${this.prefix}/${sha256}`;
    let bytes = this.verifiedCache?.get(cacheKey);
    if (bytes) {
      this.verifiedCache.delete(cacheKey);
      this.verifiedCache.set(cacheKey, bytes);
    } else {
      const file = this.bucket.file(this.prefix + '/artifacts/' + sha256 + '.bin');
      bytes = await boundedDownload(file, MAX_EXECUTABLE);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      this.verifiedCache?.delete(cacheKey);
      throw new Error('native GCS executable SHA-256 mismatch');
    }
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      this.verifiedCache?.delete(cacheKey);
      throw new Error('native GCS executable must be a Linux ELF');
    }
    if (this.verifiedCache && bytes.length <= MAX_CACHED_ARTIFACT &&
        !this.verifiedCache.has(cacheKey)) {
      while (this.verifiedCache.size >= MAX_CACHE_ENTRIES) {
        this.verifiedCache.delete(this.verifiedCache.keys().next().value);
      }
      this.verifiedCache.set(cacheKey, bytes);
    }
    const directory = await mkdtemp(join(tmpdir(), 'awfl-native-release-'));
    try {
      const executable = join(directory, 'artifact');
      await writeFile(executable, bytes, { mode: 0o500, flag: 'wx' });
      return {
        executable, sha256,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
