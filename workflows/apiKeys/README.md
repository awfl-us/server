# AWFL API keys for the HTTP API and MCP

AWFL users sign in to the web app with Firebase Authentication and manage
their **own** AWFL API keys under Settings. These keys are not OpenAI or GCP
credentials. An API key authenticates the same user to `/workflows/*`, `/mcp`
and `/mcp/agents` via the shared identity resolver. Existing project access,
MCP owner checks and Origin policy still apply.

Management API (authenticated AWFL user, no project header required):
- `GET /workflows/api-keys` — metadata for the current user
- `POST /workflows/api-keys` — `{ "name": "My AWFL client" }`; returns the raw key **once**
- `DELETE /workflows/api-keys/:id` — immediately revokes a key

New keys use `awfl_v1_<24 hex chars>_<43 base64url chars>`, expire after
90 days, and are issued with `awfl:access` and `mcp:invoke` scopes. Previously
issued `mcp:invoke`-only keys remain valid at both entrypoints. Firestore collection
`apiKeys` contains the key ID, SHA-256 hash, user ID, metadata, and expiry,
**never the plaintext token**.

`resolveAwflIdentity` in `workflows/auth/identity.js` is the common verifier.
Both `clientAuth` and `requireMcpCredential` use it, alongside Firebase ID and
AWFL OAuth tokens. A valid `Authorization: Bearer <key>` populates `req.userId`,
`req.authMethod = 'api_key'`, `req.apiKeyId`, and `req.apiKeyScopes`.
Verification reads Firestore on **each request**, so deletion and expiry are
effective immediately without service restarts or token caching. Invalid keys
never fall back to Firebase verification. Authentication alone does not grant
access to another user's projects or the owner-only private MCP endpoints.

Keep the `apiKeys` Firestore collection inaccessible to client SDKs and to
generic user document APIs. Configure the deployment's Firestore Security
Rules and IAM accordingly; this repo does not currently deploy rules.
All key management responses disable caching. Never log raw keys,
Authorization headers, or full key creation responses.

Tests: `node --test workflows/apiKeys/__tests__/core.test.mjs workflows/auth/sharedAuth.test.js workflows/oauth/tests/oauth.test.js`.
