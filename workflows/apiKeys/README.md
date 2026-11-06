# AWFL API keys for MCP clients

AWFL users sign in to the web app with Firebase Authentication and manage
their **own** MCP API keys under Settings. These keys are not OpenAI keys.

Management API (Firebase ID token only, no project header required):
- `GET /workflows/api-keys` — metadata for the current user
- `POST /workflows/api-keys` — `{ "name": "My MCP client" }`; returns the raw key **once**
- `DELETE /workflows/api-keys/:id` — immediately revokes a key

New keys use `awfl_v1_<24 hex chars>_<43 base64url chars>`, expire after
90 days, and have the sole scope `mcp:invoke`. Firestore collection
`apiKeys` contains the key ID, SHA-256 hash, user ID, metadata, and expiry,
**never the plaintext token**.

For the future MCP server, import `requireAwflApiKey()` from
`workflows/apiKeys/verify.js` and mount it on **MCP routes only**. A valid
`Authorization: Bearer <key>` sets `req.userId`, `req.apiKeyId`, and
`req.apiKeyScopes`. Verification performs a Firestore read on each call so
revocation and expiry take effect immediately. Do not use the general Firebase
ID-token management middleware to authenticate MCP calls.

Keep the `apiKeys` Firestore collection inaccessible to client SDKs and to
generic user document APIs. Configure the deployment's Firestore Security
Rules and IAM accordingly; this repo does not currently deploy rules.
All key management responses disable caching. Never log raw keys,
Authorization headers, or full key creation responses.

Tests: `node --test workflows/apiKeys/__tests__/core.test.mjs`.
