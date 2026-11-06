# Connect GitHub to AWFL through a GitHub App

GitHub App is the preferred connection for AWFL projects. Personal access
tokens continue to work and are not migrated or deleted.

## 1. Register the GitHub App

In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub App**
(or the organization's Developer settings). Name it e.g. `AWFL Cloud`.

- Homepage URL: `https://awfl.us`
- **Callback URL**: `https://api.awfl.us/github-app/callback`
- **Setup URL** (optional, recommended):
  `https://awfl.us/?github_app=installed`
- **Request user authorization (OAuth) during installation**: **OFF**.
  AWFL starts the OAuth web application flow itself with a one-time state.
- Webhooks: not required for the first release; disable Active webhook.
- Repository permissions: **Metadata: Read** (automatic), **Contents:
  Read and write**, **Pull requests: Read and write**. Optionally add
  Workflows: Read/write if the AWFL integration needs to edit GitHub Actions
  workflows. Grant the least permissions you need.
- Choose appropriate installability: private to the owning account if only
  your account/organization uses it; otherwise allow installations on other
  accounts. You do not need to publish a GitHub Marketplace listing.

After creating the app, record **App ID**, **Client ID**, **App slug**,
generate a **Client Secret**, and generate/download a **Private Key (.pem)**.
Keep the client secret and private key out of GitHub and AWFL source.

## 2. Configure the existing Cloud Run service

Put these **non-secret** values into the server repository's
`.github/actions-variables.json` so existing deploy-on-merge propagates
them to Cloud Run:

- `GITHUB_APP_ID` — numeric App ID
- `GITHUB_APP_CLIENT_ID` — GitHub App client ID (not App ID)
- `GITHUB_APP_SLUG` — public slug used in the app installation URL

Optional values already default correctly:

- `GITHUB_APP_CALLBACK_URL=https://api.awfl.us/github-app/callback`
- `GITHUB_APP_WEB_ORIGIN=https://awfl.us`

Add the following two **Secret Manager secrets** under GCP project
`awfl-us` (using Google Cloud Console or Cloud Shell):

- `GITHUB_APP_CLIENT_SECRET` — the actual GitHub App Client Secret
- `GITHUB_APP_PRIVATE_KEY_B64` — base64 of the full downloaded GitHub
  App private key PEM (single line, no spaces or line breaks)

For a Linux/macOS host, encode the private key without line breaks:

```bash
base64 < path/to/github-app.private-key.pem | tr -d '\n'
```

Add the *names only* of these new secrets to the existing `secrets.txt`
once the secrets exist and the Cloud Run runtime service account can access
them. The deployment workflow's `--set-secrets` configuration reads that
file and injects secret values only into the existing Cloud Run services.
**Do not add names to `secrets.txt` before creating the secrets**, or
automatic deployment will fail. Don't put secret values into GitHub
repository variables, PRs, messages, or shell logs.

The GitHub deployer does not need access to the secret *values*, nor any
new GKE namespace or service. Only the existing Cloud Run runtime needs
Secret Manager secret-access permissions.

## 3. Install/connect a project

After the configured deployment completes:

1. Open https://awfl.us, sign in with Google, and select your existing
   project.
2. Ensure the project has a GitHub remote, e.g.
   `https://github.com/awfl-us/server.git`.
3. Click the **Edit project** pencil icon, then **Connect GitHub**.
4. GitHub asks you to authorize the AWFL app. AWFL redirects back to the
   project modal. If the App is not yet installed with access to that
   repository, click **Install GitHub App**, choose the account and
   repositories in GitHub, return to AWFL and **Connect GitHub** again.
5. The UI should show **Connected to owner/repo**. Test GitHub API access
   through the project's existing Git integration. To switch repositories,
   save the new project remote and reconnect.

The AWFL `/workflows/github-app/start` endpoint requires a Firebase ID
token, verifies the project belongs to that user, and creates a 10-minute
single-use state in Firestore. The public callback validates/consumes the
state, exchanges the GitHub OAuth code, and confirms the authorized GitHub
user has write access to the repository through an installation of **this
GitHub App**. A supplied `installation_id` is **never trusted** as proof
of access. The GitHub user access token is not persisted.

Firestore stores only the installation ID and repository identity under
`users/{uid}/projects/{projectId}/integrations/githubApp`.

## 4. Runtime credential resolution

`resolveGithubAppCredential` generates a GitHub App JWT, mints an
installation token **restricted to the linked repository ID**, and caches
it in-process until close to expiry. Installation tokens last at most one
hour. The existing AWFL Git API and `jobs/producer/credentials.js` prefer
this token for linked projects, otherwise fall back to existing PATs.

The existing Python cloud consumer receives the token in `GITHUB_TOKEN`
as before. Long-lived cloud sessions may require creating a fresh consumer
after token expiry; an MCP workspace already has a one-hour lifetime.

Disconnecting the GitHub App in AWFL removes the project's binding but
does not uninstall it from GitHub or revoke already-running consumers'
tokens. Revoke the installation from GitHub settings if necessary and stop
any active cloud workspace.

## Operational checks

- Before registration, the UI displays `GitHub App not configured`.
  This is expected; manual PAT remains available under Manage.
- `node --test workflows/githubApp/tests/*.test.js`
- `npm run typecheck` in `awfl-us/web`
- Ensure `POST /workflows/github-app/start` requires Firebase auth.
- Complete a real GitHub redirect/installation and verify a repository file
  request and a cloud consumer `GITHUB_TOKEN` presence. Unit tests alone
  do not prove the integration is active.
