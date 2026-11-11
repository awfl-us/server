// Native deployments are site-wide release aliases, not user-owned uploads.
// The trusted CI pipeline builds/signs artifacts; only the explicitly
// configured site owner may activate or withdraw an approved artifact.
// No public HTTP route is provided while the shared launcher is unfinished.

const DIGEST = /^[a-f0-9]{64}$/;
const WORKFLOW_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const COLLECTION = 'nativeDeployments';

export class NativeDeploymentService {
  constructor({ db, registry, siteOwnerUid = process.env.MCP_OWNER_UID,
                clock = () => Date.now() }) {
    if (typeof db?.collection !== 'function') {
      throw new Error('trusted deployment Firestore required');
    }
    if (typeof registry?.resolve !== 'function') {
      throw new Error('trusted signed native registry required');
    }
    // Unlike the private MCP fallback, the deployment authority MUST be an
    // explicitly configured stable UID. Project ownership and API keys are
    // not permission to deploy site-wide native executables.
    if (typeof siteOwnerUid !== 'string' || !siteOwnerUid.trim()) {
      throw new Error('site owner UID must be explicitly configured');
    }
    if (typeof clock !== 'function') throw new Error('deployment clock required');
    this.db = db;
    this.registry = registry;
    this.siteOwnerUid = siteOwnerUid;
    this.clock = clock;
  }

  requireSiteOwner(authenticatedUserId) {
    if (typeof authenticatedUserId !== 'string' ||
        authenticatedUserId !== this.siteOwnerUid) {
      throw new Error('site owner required for native deployment');
    }
  }

  ref(workflowName) {
    if (typeof workflowName !== 'string' || !WORKFLOW_NAME.test(workflowName)) {
      throw new Error('invalid native deployment name');
    }
    return this.db.collection(COLLECTION).doc(workflowName);
  }

  /** Activate a CI-signed artifact for all users of a workflow name.
    * authenticatedUserId MUST come from verified Firebase/OAuth identity,
    * never from request body, path, headers, or project membership.
    */
  async deploy({ authenticatedUserId, workflowName, artifactSha256,
                 protocolVersion } = {}) {
    this.requireSiteOwner(authenticatedUserId);
    const ref = this.ref(workflowName);
    if (!DIGEST.test(artifactSha256 || '') || ![1, 2].includes(protocolVersion)) {
      throw new Error('approved artifact SHA-256 and protocol required');
    }
    // This is intentionally a read-only registry call: deployment cannot
    // compile, upload, sign or approve arbitrary caller-supplied binaries.
    const approved = await this.registry.resolve({
      sha256: artifactSha256, protocolVersion,
    });
    const record = {
      schemaVersion: 1,
      artifactSha256,
      protocolVersion,
      publisherKeyId: approved.publisherKeyId,
      allowedOperations: [...approved.allowedOperations],
      deployedBy: this.siteOwnerUid,
      updatedAt: this.clock(),
    };
    await ref.set(record);
    return { workflowName, ...record };
  }

  /** Site owner can withdraw a native mapping. Ordinary users cannot. */
  async undeploy({ authenticatedUserId, workflowName } = {}) {
    this.requireSiteOwner(authenticatedUserId);
    await this.ref(workflowName).delete();
    return { workflowName, undeployed: true };
  }

  /** Safe for a future execution launcher: users may execute, not deploy.
    * The registry signature is rechecked in case the on-disk approval was
    * revoked or replaced after activation.
    */
  async resolveActive({ workflowName } = {}) {
    const snap = await this.ref(workflowName).get();
    if (!snap.exists) return null;
    const record = snap.data();
    if (record?.schemaVersion !== 1 ||
        !DIGEST.test(record.artifactSha256 || '') ||
        ![1, 2].includes(record.protocolVersion) ||
        record.deployedBy !== this.siteOwnerUid ||
        !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
      throw new Error('invalid active native deployment');
    }
    const approved = await this.registry.resolve({
      sha256: record.artifactSha256,
      protocolVersion: record.protocolVersion,
    });
    if (approved.publisherKeyId !== record.publisherKeyId ||
        JSON.stringify(approved.allowedOperations) !== JSON.stringify(record.allowedOperations)) {
      throw new Error('active native deployment approval changed');
    }
    return {
      workflowName,
      artifactSha256: record.artifactSha256,
      protocolVersion: record.protocolVersion,
      allowedOperations: [...approved.allowedOperations],
    };
  }
}
