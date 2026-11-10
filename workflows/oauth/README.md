# AWFL OAuth for ChatGPT and API clients

AWFL uses the **same user identity** across the web API, Cloud Terminal MCP and
Agents MCP. OAuth is an additional way to obtain an AWFL API bearer credential,
not a separate MCP user or permission system.

## Connect

Add **two** custom remote MCP connections in ChatGPT Plugins:

- Cloud Terminal: `https://api.awfl.us/mcp`
- Agents: `https://api.awfl.us/mcp/agents`

Select OAuth. The discovery endpoints automatically provide the authorization
and token URLs. Both connections use the *same* OAuth issuer and
`https://api.awfl.us` protected resource. Sign in on `awfl.us` using the
existing Firebase/Google account and approve ChatGPT access.

ChatGPT may still show an individual **Connect** flow per connector because the
client manages two separate connection records, but a bearer token issued for
either connection authorizes the same AWFL API account at either endpoint.

## Authentication and authorization

- Existing Firebase ID bearer tokens continue working on ordinary AWFL API
  routes and now also authenticate the MCPs.
- New AWFL OAuth bearer tokens work on all authenticated AWFL API routes and
  on both MCP endpoints. Both resolve to the *same Firebase UID*.
- Existing AWFL API keys continue to authenticate legacy MCP integrations,
  but do not become general API credentials.
- Every route keeps its existing authorization checks. In particular, both
  MCPs **still enforce their existing owner-only policy** after authentication.
  Signing in via OAuth does not grant that policy to another AWFL user.
- Scopes: `awfl:access`. JWT issuer/audience:
  `https://api.awfl.us`. This authorizes the existing API capabilities; it
  does **not** authorize unrelated Google Cloud or third-party services.
- Access tokens expire after 15 minutes; refresh tokens are opaque, hashed at
  rest, bound to their OAuth client, and rotated at use (30-day maximum).
  Authorization codes are single-use, valid for 5 minutes; consent requests
  expire after 10 minutes.
- Existing `ENCRYPTION_SECRET_KEY` from Secret Manager signs access tokens
  using a distinct HMAC-derived key. No static client secret is required.
- OAuth supports authorization-code **PKCE S256**, ChatGPT's stable OAuth
  callback with issuer identification, **CIMD** client metadata and **DCR**.
- The OAuth server authenticates any signed-in AWFL user. Per-route authorization
  remains with existing API and MCP services.

## Endpoints

- Protected-resource metadata:
  `GET /.well-known/oauth-protected-resource`,
  `GET /.well-known/oauth-protected-resource/mcp`,
  `GET /.well-known/oauth-protected-resource/mcp/agents`
- Authorization server metadata:
  `GET /.well-known/oauth-authorization-server`
- Client registration: `POST /oauth/register`
- Authorization: `GET /oauth/authorize`
- AWFL web consent: `https://awfl.us/oauth/consent?request=...`
- Consent verification: `GET /oauth/requests/:id`
- Consent decision: `POST /oauth/decide`
- Token exchange / refresh: `POST /oauth/token`

No credentials, tokens, or authorization codes should be logged.
