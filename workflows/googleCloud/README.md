# Project Google Cloud connection

AWFL exposes **Connect Google Cloud** in the existing project-edit dialog, using an OAuth 2.0 authorization code flow with PKCE and an expiring, single-use state. The browser never receives refresh or access tokens.

## One-time OAuth setup

1. In the Google Cloud project hosting AWFL, configure the OAuth consent screen and create a **Web application** OAuth client. Request the cloud-platform scope plus openid and email. Add your account as a test user while the consent screen is in testing mode; external testing apps may receive refresh tokens that expire in seven days.
2. Set the exact authorized redirect URI to https://api.awfl.us/google-cloud/callback
3. Set GitHub Actions repository variable **GOOGLE_CLOUD_OAUTH_CLIENT_ID** for awfl-us/server to the OAuth client ID.
4. Create a Google Secret Manager secret named **GOOGLE_CLOUD_OAUTH_CLIENT_SECRET** in AWFL's deployment project, containing the OAuth client secret. Grant the Cloud Run runtime service account permission to access it.
5. Deploy awfl-us/server. The deployment attaches the secret only if the client ID is set and the secret exists. Until both are available, the UI shows Google Cloud OAuth as unconfigured. The existing ENCRYPTION_SECRET_KEY must also be configured.
6. Open Edit Project, enter the Google Cloud project ID (e.g. topaigents), and click Connect Google Cloud. After consent, return to the project modal and click Test Secret Manager.

## Runtime and security

- Encrypted refresh token stored under the user's project integration document in Firestore.
- The shared producer's existing loadConsumerCredentials refreshes access tokens server-side only on consumer startup.
- GKE consumers receive short-lived CLOUDSDK_AUTH_ACCESS_TOKEN and CLOUDSDK_CORE_PROJECT. The Google refresh token is never passed to Kubernetes or the web browser.
- The standard consumer image includes gcloud. The user must restart an existing consumer to apply the connection and restart again after token expiry (typically about one hour).
- Short-lived tokens in Kubernetes Job environment variables are visible to users with permission to inspect Job specs. For permanent Secret Manager access, use service-account Workload Identity and least-privilege IAM instead.
- Disconnect removes the stored credential and attempts to revoke it; currently running consumers can retain an already-issued access token until it expires.
- No changes to the existing consumer lock, startup procedure, or tool-call handlers.

## Endpoints

Authenticated routes under /workflows/google-cloud: GET /status?projectId=..., POST /start, POST /test, POST /disconnect. The OAuth callback at /google-cloud/callback is validated by the one-time state.

Do not commit OAuth client credentials to GitHub, or place them in project workspace files.
