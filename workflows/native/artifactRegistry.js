// Trusted native artifact approval, deliberately independent of workflow
// inputs. Provision signed approvals and binary blobs through an authorized
// build/release pipeline; workers only READ those approved artifacts.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const MAX_BINARY = 64 * 1024 * 1024;
const MAX_APPROVAL = 16 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_-]{1,80}$/;
const METHODS = new Set(['http.get', 'http.post', 'http.patch', 'http.delete']);
const APPROVAL_FIELDS = [
  'allowedOperations', 'artifactSha256', 'protocolVersion',
  'publisherKeyId', 'runtimeAbi', 'schemaVersion',
];

async function readRegularNoFollow(path, max) {
  // O_NOFOLLOW protects the final file component; the configured registry
  // directory itself must be trusted and non-writable by workflow users.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > max) {
      throw new Error('invalid native artifact file type or size');
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function approvalMetadata(value, digest) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(APPROVAL_FIELDS)) {
    throw new Error('invalid native artifact approval schema');
  }
  const { schemaVersion, publisherKeyId, artifactSha256, protocolVersion,
    runtimeAbi, allowedOperations } = value;
  if (schemaVersion !== 1 || !NAME.test(publisherKeyId) ||
      artifactSha256 !== digest ||
      !((runtimeAbi === 2 && protocolVersion === 1) ||
        (runtimeAbi === 3 && protocolVersion === 2)) ||
      !Array.isArray(allowedOperations) || allowedOperations.length > METHODS.size ||
      new Set(allowedOperations).size !== allowedOperations.length ||
      !allowedOperations.every(op => METHODS.has(op))) {
    throw new Error('invalid native artifact approval metadata');
  }
  return value;
}

/** Read-only trust store for approved binaries named by their SHA-256.
  *
  * Directory layout:
  *   <digest>.bin
  *   <digest>.approval.json   {manifest, signature}
  *
  * signature = base64 Ed25519 signature over UTF-8 JSON.stringify(manifest).
  * trustedPublishers are supplied exclusively by server deployment config,
  * never from the uploaded approval, workflow input or caller.
  */
export class NativeArtifactRegistry {
  constructor({ directory, trustedPublishers, allowScriptsForTests = false }) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) {
      throw new Error('absolute trusted artifact directory required');
    }
    if (!trustedPublishers || typeof trustedPublishers !== 'object' ||
        Object.keys(trustedPublishers).length === 0) {
      throw new Error('trusted publisher public keys required');
    }
    this.directory = directory;
    this.allowScriptsForTests = allowScriptsForTests;
    this.trustedKeys = new Map();
    for (const [name, key] of Object.entries(trustedPublishers)) {
      if (!NAME.test(name)) throw new Error('invalid trusted publisher identity');
      const publicKey = key?.type === 'public' ? key : createPublicKey(key);
      if (publicKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('Ed25519 trusted publisher key required');
      }
      this.trustedKeys.set(name, publicKey);
    }
  }

  async resolve({ sha256, protocolVersion }) {
    if (!SHA256.test(sha256 || '') || ![1, 2].includes(protocolVersion)) {
      throw new Error('pinned artifact SHA-256 and protocol required');
    }
    const dir = await lstat(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) {
      throw new Error('native artifact directory must be a real directory');
    }
    if (dir.mode & 0o022) {
      throw new Error('native artifact directory must not be group/world writable');
    }
    const approvalFile = join(this.directory, sha256 + '.approval.json');
    const binaryFile = join(this.directory, sha256 + '.bin');
    const approvalBytes = await readRegularNoFollow(approvalFile, MAX_APPROVAL);
    let envelope;
    try { envelope = JSON.parse(approvalBytes.toString('utf8')); } catch {
      throw new Error('invalid signed native approval JSON');
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(['manifest', 'signature'])) {
      throw new Error('invalid signed native approval envelope');
    }
    const manifest = approvalMetadata(envelope.manifest, sha256);
    if (manifest.protocolVersion !== protocolVersion) {
      throw new Error('native artifact approval protocol differs from execution');
    }
    const key = this.trustedKeys.get(manifest.publisherKeyId);
    if (!key || typeof envelope.signature !== 'string' ||
        !/^[A-Za-z0-9+/]{84,88}={0,2}$/.test(envelope.signature) ||
        !verify(null, Buffer.from(JSON.stringify(manifest)), key,
          Buffer.from(envelope.signature, 'base64'))) {
      throw new Error('native artifact approval signature not trusted');
    }
    const bytes = await readRegularNoFollow(binaryFile, MAX_BINARY);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new Error('native approved binary SHA-256 mismatch');
    }
    // AWFL's GKE execution target is native Linux. Reject scripts and
    // interpreter shebangs from the production registry, even if signed.
    if (!this.allowScriptsForTests &&
        !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('native approved artifact must be a Linux ELF executable');
    }
    return {
      executable: binaryFile, sha256, protocolVersion,
      allowedOperations: Object.freeze([...manifest.allowedOperations]),
      publisherKeyId: manifest.publisherKeyId,
    };
  }
}
