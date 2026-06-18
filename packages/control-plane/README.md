# Open-Inspect Control Plane

Cloudflare Workers + Durable Objects control plane for session management and real-time streaming.

## Overview

The control plane provides:

- **Session Management**: SQLite-backed Durable Objects for each session
- **Real-time Streaming**: WebSocket connections with hibernation support
- **Multi-client Sync**: Web, Slack, extension clients all see the same state
- **GitHub Integration**: GitHub App for repository access
- **Token Encryption**: AES-256-GCM encryption for GitHub tokens at rest
- **Repo Secrets**: Encrypted repo-scoped secrets stored in D1, injected into sandboxes as env vars

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   API Gateway (router.ts)                 │   │
│  │   POST /sessions  │  GET /sessions/:id  │  WebSocket      │   │
│  └─────────────────────────────┬────────────────────────────┘   │
│                                │                                 │
│  ┌─────────────────────────────┴────────────────────────────┐   │
│  │              Durable Objects (per session)                │   │
│  │  ┌────────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │   SQLite DB    │  │  WebSocket   │  │    Event     │  │   │
│  │  │ - session      │  │    Hub       │  │   Stream     │  │   │
│  │  │ - participants │  │ (hibernation)│  │              │  │   │
│  │  │ - messages     │  └──────────────┘  └──────────────┘  │   │
│  │  │ - events       │                                       │   │
│  │  │ - artifacts    │                                       │   │
│  │  │ - sandbox      │                                       │   │
│  │  │ - ws_mapping   │                                       │   │
│  │  └────────────────┘                                       │   │
│  └───────────────────────────────────────────────────────────┘   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │              D1 Database (repo-scoped secrets)              │   │
│  └───────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## API Endpoints

### Health

| Endpoint  | Method | Description  |
| --------- | ------ | ------------ |
| `/health` | GET    | Health check |

### Sessions

| Endpoint                                 | Method    | Description                    |
| ---------------------------------------- | --------- | ------------------------------ |
| `/sessions`                              | GET       | List user's sessions           |
| `/sessions`                              | POST      | Create new session             |
| `/sessions/:id`                          | GET       | Get session state              |
| `/sessions/:id`                          | DELETE    | Delete session                 |
| `/sessions/:id/title`                    | PATCH     | Update session title           |
| `/sessions/:id/prompt`                   | POST      | Enqueue prompt                 |
| `/sessions/:id/stop`                     | POST      | Stop execution                 |
| `/sessions/:id/ws`                       | WebSocket | Real-time connection           |
| `/sessions/:id/events`                   | GET       | Paginated events               |
| `/sessions/:id/artifacts`                | GET       | List artifacts                 |
| `/sessions/:id/participants`             | GET/POST  | Manage participants            |
| `/sessions/:id/messages`                 | GET       | List messages                  |
| `/sessions/:id/media`                    | POST      | Upload sandbox media artifact  |
| `/sessions/:id/media/:artifactId`        | GET       | Stream media artifact          |
| `/sessions/:id/children`                 | GET       | List child sessions            |
| `/sessions/:id/children`                 | POST      | Spawn child session            |
| `/sessions/:id/children/:childId`        | GET       | Get child session details      |
| `/sessions/:id/children/:childId/cancel` | POST      | Cancel child session           |
| `/sessions/:id/pr`                       | POST      | Create pull request            |
| `/sessions/:id/openai-token-refresh`     | POST      | Refresh sandbox OpenAI token   |
| `/sessions/:id/scm-credentials`          | POST      | Broker sandbox git credentials |
| `/sessions/:id/tunnel-urls`              | GET       | Return sandbox tunnel URLs     |
| `/sessions/:id/ws-token`                 | POST      | Generate WebSocket token       |
| `/sessions/:id/archive`                  | POST      | Archive session                |
| `/sessions/:id/unarchive`                | POST      | Unarchive session              |

`GET /sessions` accepts `status`, `excludeStatus`, `limit`, `offset`, and repeatable `createdBy`
query parameters. `createdBy` values must be canonical 32-character lowercase hex user IDs;
duplicates are ignored. The web `/api/sessions` proxy also accepts `createdBy=me` and resolves it to
the current user's canonical ID before forwarding. The control-plane endpoint rejects `me` directly.

`POST /sessions` requires internal control-plane authentication and accepts JSON with required
`repoOwner` and `repoName`, plus optional `title`, `branch`, `model`, and `reasoningEffort`. Web
clients identify the signed-in user with provider-agnostic `authProvider` (`github` or `google`),
`authUserId`, `authEmail`, `authName`, and `authAvatarUrl` fields. GitHub SCM attribution and OAuth
tokens remain GitHub-only `scm*` fields (`scmUserId`, `scmLogin`, `scmName`, `scmEmail`,
`scmAvatarUrl`, `scmToken`, `scmRefreshToken`, `scmTokenExpiresAt`). Bot-created sessions use
`spawnSource` with GitHub `scm*` fields or Slack/Linear `actor*` fields. Google auth fields are
never used as SCM credentials; if the resolved canonical user has a linked GitHub identity, the
control plane may fill missing GitHub SCM fields from that identity, otherwise git falls back to the
GitHub App. The response is `{ sessionId, status }` with status `201`; invalid JSON, missing repo
fields, or invalid branch names return `400`, uninstalled repos return `404`, and setup failures
return `500`.

`PATCH /sessions/:id/title` requires internal control-plane authentication and accepts JSON with
`userId` and `title`. `userId` must identify a session participant. Titles are trimmed, must be
non-empty, and must be 200 characters or fewer. The endpoint returns `{ title }`, returns `400` for
invalid request data, returns `403` when the user is not a participant, and returns `404` when the
session is missing. Successful updates broadcast `session_title` to connected clients.

`POST /sessions/:id/children` accepts internal control-plane authentication or the parent sandbox
bearer token. The JSON body requires `title` and `prompt`; `model`, `reasoningEffort`, `repoOwner`,
and `repoName` are optional. Child sessions always run in the parent's repository. Optional repo
fields are accepted only when they match the parent repo; otherwise the route returns `403`. The
child inherits the parent model and reasoning effort unless valid overrides are supplied, inherits
GitHub SCM attribution and credentials from the parent session, applies repo sandbox settings, and
enqueues `prompt` as the first child prompt. Spawning is limited by depth and repo child-session
settings, returning `403` when max depth is exceeded and `429` when concurrent or total child limits
are reached. The response is `{ sessionId, status }` with status `201`.

`GET /sessions/:id/children/:childId` accepts `include=result` for the final assistant response and
`include=trajectory` for persisted events. Use `trajectoryLimit` and `trajectoryCursor` to page
through long child runs.

`GET /sessions/:id/events` accepts `cursor`, `limit`, `type`, and `message_id`. Events are returned
newest-first as `{ events, cursor, hasMore }`; each event includes `id`, `type`, `data`, `messageId`,
and `createdAt`. `limit` defaults to 50 and is capped at 200. New clients should pass the returned
composite cursor (`<createdAt>:<url-encoded-event-id>`) to fetch the next page; legacy numeric
timestamp cursors are still accepted for older clients.

### Session Media

`POST /sessions/:id/media` is a sandbox-authenticated multipart upload endpoint. It requires `file`
and `artifactType` (`screenshot` or `video`) and returns:

```json
{
  "artifactId": "artifact-1",
  "objectKey": "sessions/session-1/media/artifact-1.png"
}
```

Screenshot uploads accept `image/png`, `image/jpeg`, or `image/webp`, must be 10 MiB or smaller, and
may include `caption`, `sourceUrl`, `fullPage`, `annotated`, and `viewport` JSON. Video uploads
accept `video/mp4`, must be 100 MiB or smaller, and require `caption`, `durationMs`,
`recordingStartedAt`, `recordingEndedAt`, `dimensions` JSON, and `truncated`; optional `hasAudio`
must be `false`. Sessions are limited to 100 screenshots and 20 videos. Uploads persist an artifact
row and matching `artifact` event on the active prompt; they return `409` when no prompt is active.

`GET /sessions/:id/media/:artifactId` requires internal control-plane authentication and streams
stored screenshot or video artifacts from object storage. It returns the stored content type, `ETag`,
`Accept-Ranges: bytes`, and `Content-Length`; valid `Range` requests return `206` with
`Content-Range`, and unsatisfiable ranges return `416`.

### Provider Identities

| Endpoint                                          | Method | Description                              |
| ------------------------------------------------- | ------ | ---------------------------------------- |
| `/provider-identities/:provider/:providerUserId` | PUT    | Resolve or upsert a canonical user ID    |

Supported providers are `github`, `slack`, `linear`, and `google`. This endpoint requires the same
internal control-plane authentication used by web and bot workers.

Request body fields are optional strings:

- `providerLogin`
- `providerEmail`
- `displayName`
- `avatarUrl`

Response:

```json
{
  "userId": "0123456789abcdef0123456789abcdef"
}
```

The route trims blank optional fields, links identities by provider ID, and may link providers by
email through `UserStore.resolveOrCreateUser`.

### Integration Settings

Supported integration IDs are `github`, `linear`, `code-server`, `sandbox`, and `slack`. All
integration settings routes require internal control-plane authentication.

| Endpoint                                             | Method | Description                    |
| ---------------------------------------------------- | ------ | ------------------------------ |
| `/integration-settings/:id`                          | GET    | Get global settings            |
| `/integration-settings/:id`                          | PUT    | Update global settings         |
| `/integration-settings/:id`                          | DELETE | Delete global settings         |
| `/integration-settings/:id/repos`                    | GET    | List repo overrides            |
| `/integration-settings/:id/repos/:owner/:name`       | GET    | Get repo override              |
| `/integration-settings/:id/repos/:owner/:name`       | PUT    | Update repo override           |
| `/integration-settings/:id/repos/:owner/:name`       | DELETE | Delete repo override           |
| `/integration-settings/:id/resolved/:owner/:name`    | GET    | Get merged runtime config      |

Global writes accept `{ "settings": { "defaults": ..., "enabledRepos": ... } }`. Repo writes
accept `{ "settings": ... }`. `enabledRepos` is `null` when all repos are enabled, an empty array
when no repos are enabled, or a lowercased allowlist.

`GET /integration-settings/:id/resolved/:owner/:name` returns `{ integrationId, repo, config }`
after applying global defaults, repo overrides, and runtime defaults. For `sandbox`, `config`
contains:

```json
{
  "tunnelPorts": [],
  "terminalEnabled": false,
  "maxConcurrentChildSessions": 5,
  "maxTotalChildSessions": 15,
  "cpuCores": null,
  "memoryMib": null,
  "enabledRepos": null
}
```

Sandbox repo settings override only defined keys. `cpuCores` must be a positive number and
`memoryMib` must be a positive integer in MiB. For those resource fields, an undefined repo value
inherits the global default, while `null` explicitly uses the provider default instead of
inheriting.

### Create PR Payload

`POST /sessions/:id/pr` accepts:

- `title` (required)
- `body` (required)
- `baseBranch` (optional)
- `headBranch` (optional)

When `headBranch` is omitted, control-plane resolves it from session state and finally falls back to
the generated `open-inspect/<session>` branch.

### OpenAI Token Refresh

`POST /sessions/:id/openai-token-refresh` is a sandbox-authenticated endpoint used by the sandbox to
refresh OpenAI OAuth access tokens without exposing stored refresh tokens. It returns:

```json
{
  "access_token": "<access-token>",
  "expires_in": 3600,
  "account_id": "acct_123"
}
```

The route reads repo-scoped OpenAI OAuth secrets first, then global secrets. Common failures are
`401` for a missing or invalid sandbox token, `404` when the session or
`OPENAI_OAUTH_REFRESH_TOKEN` is missing, `500` when secret storage is not configured, and `502` when
the upstream OpenAI refresh fails.

### GitHub Credentials

`POST /sessions/:id/scm-credentials` is a sandbox-authenticated endpoint used by the in-sandbox git
credential helper. The route name keeps the historical `scm` path, but the broker is GitHub-only:
it mints a short-lived GitHub App installation token and returns it for git operations in this
shape:

```json
{
  "username": "x-access-token",
  "password": "<short-lived-token>",
  "expires_at_epoch_ms": 1730000000000
}
```

Common failures are `401` for a missing or invalid sandbox token, `404` when the session no longer
exists, and `5xx` when GitHub App configuration is missing or GitHub token minting fails.

### Tunnel URLs

`GET /sessions/:id/tunnel-urls` is a sandbox-authenticated fallback for retrieving the control
plane's resolved Modal tunnel URLs. In-sandbox clients should read `/workspace/.tunnels.env` when it
is present and use this route when that file is missing or incomplete after the bounded wait.

Call it with `Authorization: Bearer <SANDBOX_AUTH_TOKEN>`. It returns:

```json
{
  "tunnelUrls": {
    "3000": "https://example.modal.run"
  }
}
```

The response is `200` with an empty map when tunnels are not resolved yet, `401` for a missing or
invalid sandbox token, `404` when the session has no sandbox, and `500` when the stored tunnel URL
payload is malformed. Responses use `Cache-Control: no-store`.

### Repositories

| Endpoint                           | Method | Description          |
| ---------------------------------- | ------ | -------------------- |
| `/repos`                           | GET    | List repositories    |
| `/repos/:owner/:name/metadata`     | GET    | Get repo metadata    |
| `/repos/:owner/:name/metadata`     | PUT    | Update repo metadata |
| `/repos/:owner/:name/secrets`      | GET    | List secret keys     |
| `/repos/:owner/:name/secrets`      | PUT    | Upsert secrets       |
| `/repos/:owner/:name/secrets/:key` | DELETE | Delete a secret      |

### Repo Images

Repo image routes are available when `SANDBOX_PROVIDER` resolves to Modal.

| Endpoint                           | Method | Auth                         | Description                    |
| ---------------------------------- | ------ | ---------------------------- | ------------------------------ |
| `/repo-images/build-complete`      | POST   | Modal callback token         | Mark a build ready             |
| `/repo-images/build-failed`        | POST   | Modal callback token         | Mark a build failed            |
| `/repo-images/trigger/:owner/:name` | POST   | Internal control-plane token | Start a repo image build       |
| `/repo-images/status`              | GET    | Internal control-plane token | List all build statuses        |
| `/repo-images/toggle/:owner/:name` | PUT    | Internal control-plane token | Enable or disable repo builds  |
| `/repo-images/enabled-repos`       | GET    | Internal control-plane token | List repos enabled for builds  |
| `/repo-images/mark-stale`          | POST   | Internal control-plane token | Fail old building rows         |
| `/repo-images/cleanup`             | POST   | Internal control-plane token | Delete old failed build rows   |

The callback routes are exempt from the worker's regular internal-auth gate, but still require
`Authorization: Bearer <token>` signed with `INTERNAL_CALLBACK_SECRET`. Other repo-image routes use
the normal internal control-plane token.

`POST /repo-images/build-complete` accepts `build_id`, `provider_image_id`, optional `base_sha`, and
optional `build_duration_seconds`. It marks the build ready and returns
`{ ok: true, replacedImageId }`. When a ready image replaces an older provider image, the control
plane asks Modal to delete the replaced `provider_image_id` on a best-effort basis.

`POST /repo-images/build-failed` accepts `build_id` and optional `error`, marks the build failed,
and returns `{ ok: true }`.

`POST /repo-images/trigger/:owner/:name` registers a `modal` build, merges global and repo secrets
for the build sandbox, then calls Modal `api-build-repo-image` with those values as `user_env_vars`.
Repo secrets override global secrets with the same key. The response is `{ buildId, status }` with
status `building`.

`GET /repo-images/status` returns `{ images }` for all builds or for one repo when `repo_owner` and
`repo_name` query parameters are supplied. `PUT /repo-images/toggle/:owner/:name` accepts
`{ enabled: boolean }` and stores whether scheduled image builds are enabled for that repo.

`GET /repo-images/enabled-repos`, `POST /repo-images/mark-stale`, and `POST /repo-images/cleanup`
are used by the Modal scheduler. `mark-stale` accepts optional `max_age_seconds` and returns
`{ ok: true, markedFailed }`; `cleanup` accepts optional `max_age_seconds` and returns
`{ ok: true, deleted }`.

## WebSocket Protocol

### Client → Server Messages

| Type            | Description        | Payload                     |
| --------------- | ------------------ | --------------------------- |
| `ping`          | Health check       | `{}`                        |
| `subscribe`     | Join session       | `{ token, clientId }`       |
| `prompt`        | Send prompt        | `{ content, attachments? }` |
| `stop`          | Stop execution     | `{}`                        |
| `typing`        | User typing (warm) | `{}`                        |
| `presence`      | Update presence    | `{ status, cursor? }`       |
| `fetch_history` | Load older events  | `{ cursor, limit? }`        |

### Server → Client Messages

| Type                    | Description                    |
| ----------------------- | ------------------------------ |
| `pong`                  | Health check response          |
| `subscribed`            | Confirm subscription           |
| `prompt_queued`         | Confirm prompt queued          |
| `sandbox_event`         | Event from sandbox             |
| `history_page`          | Older sandbox event page       |
| `presence_sync`         | Full presence state            |
| `presence_update`       | Presence change                |
| `presence_leave`        | Participant disconnected       |
| `sandbox_spawning`      | Sandbox is being created       |
| `sandbox_warming`       | Sandbox warming                |
| `sandbox_status`        | Sandbox status update          |
| `sandbox_dashboard_url` | Provider sandbox dashboard URL |
| `sandbox_ready`         | Sandbox ready                  |
| `sandbox_error`         | Sandbox error occurred         |
| `sandbox_warning`       | Sandbox warning message        |
| `sandbox_restored`      | Restored from snapshot         |
| `code_server_info`      | Code-server tunnel credentials |
| `ttyd_info`             | Terminal tunnel credentials    |
| `tunnel_urls`           | Runtime tunnel URLs            |
| `artifact_created`      | New artifact event             |
| `snapshot_saved`        | Filesystem snapshot saved      |
| `session_status`        | Session status change          |
| `session_branch`        | Session branch update          |
| `session_title`         | Session title update           |
| `child_session_update`  | Child session status update    |
| `processing_status`     | Prompt processing state        |
| `error`                 | Error occurred                 |

`history_page` carries `{ items, hasMore, cursor }` for older sandbox events requested by
`fetch_history`.

`sandbox_dashboard_url` carries `{ url }` and is emitted after a sandbox provider object is created
or restored.

`code_server_info`, `ttyd_info`, and `tunnel_urls` carry sandbox access URLs and credentials for
the current sandbox instance.

`artifact_created` carries `{ artifact }`. Artifact types include PRs, screenshots, videos,
previews, and branches.

`session_branch` carries `{ branchName }`. `processing_status` carries `{ isProcessing }`.

`session_title` carries `{ title }`. Sandbox-generated titles only fill an empty session title; a
manual title update uses the same broadcast after validation.

`child_session_update` carries `{ childSessionId, status, title }` when a child session is spawned
or changes status.

## Development

### Prerequisites

- Node.js 22+
- Terraform (for deployment)

### Setup

```bash
cd packages/control-plane
npm install
```

### Build

```bash
npm run build
# Outputs to dist/index.js
```

### Deploy

Deployment is managed via Terraform. See [terraform/README.md](../../terraform/README.md) for
details.

All secrets and environment variables are configured through Terraform's `terraform.tfvars` file.

## SQLite Schema

Each session gets its own SQLite database with:

- `session`: Core session state (repo, branch, status)
- `participants`: Users with encrypted GitHub tokens
- `messages`: Prompt queue and history
- `events`: Agent events (tool calls, tokens)
- `artifacts`: PRs, screenshots, videos, previews, branches
- `sandbox`: selected backend sandbox state
- `ws_client_mapping`: WebSocket ID to participant mapping (for hibernation recovery)

See `src/session/schema.ts` for full schema.

## Token Encryption

GitHub OAuth tokens are encrypted at rest using AES-256-GCM:

```typescript
import { encryptToken, decryptToken } from "./auth/crypto";

// Encrypt before storing
const encrypted = await encryptToken(accessToken, env.TOKEN_ENCRYPTION_KEY);

// Decrypt when needed
const token = await decryptToken(encrypted, env.TOKEN_ENCRYPTION_KEY);
```

## Security Model

> **Single-Tenant Only**: This control plane is designed for single-tenant deployment where all
> users are trusted members of the same organization.

### GitHub App Token Flow

The system uses two types of GitHub tokens:

| Token            | Used For           | Delivery                      | Access Scope                     |
| ---------------- | ------------------ | ----------------------------- | -------------------------------- |
| GitHub App Token | Clone, fetch, push | Brokered to credential helper | All repos where App is installed |
| User OAuth Token | Create PRs         | Server-only                   | User's accessible repos          |

Fresh sandboxes do not receive a long-lived `GITHUB_TOKEN`, `GITHUB_APP_TOKEN`, or `VCS_CLONE_TOKEN`
for normal git operations. Git invokes the sandbox credential helper, which calls
`/sessions/:id/scm-credentials` with the sandbox auth token and receives short-lived credentials on
demand. Legacy snapshots, repo images, and one-shot image builds may still receive env-token
fallbacks for compatibility. The helper preserves the existing installation-wide model by serving
credentials for HTTPS git requests to GitHub, including setup/start hooks that clone auxiliary
private repos. This avoids stale embedded credentials in long-running sessions and Modal snapshot
restores.

If a `create-pr` request is triggered by a participant without a user OAuth token (for example,
Slack-created or Google-login sessions), the sandbox can still push the branch with brokered GitHub
App credentials and the control plane returns a manual GitHub `pull/new` URL instead of failing the
request.

### Why This Matters

- **No per-user repo access validation**: When a session is created, the system does not verify that
  the user has access to the requested repository
- **Shared GitHub App installation**: A single `GITHUB_APP_INSTALLATION_ID` is used for all users
- **Trust boundary is the organization**: All users with access to the web app can work with any
  repository the GitHub App is installed on

### Configuration

All secrets are configured via Terraform. Required secrets include:

- `GITHUB_APP_ID` - GitHub App ID
- `GITHUB_APP_PRIVATE_KEY` - GitHub App private key (PKCS#8 format)
- `GITHUB_APP_INSTALLATION_ID` - Single installation for all users
- `REPO_SECRETS_ENCRYPTION_KEY` - AES-GCM key for encrypting repo secrets in D1

See
[terraform/environments/production/terraform.tfvars.example](../../terraform/environments/production/terraform.tfvars.example)
for the complete list.

### Deployment Recommendations

1. Deploy behind SSO/VPN to restrict access to authorized employees
2. Install the GitHub App only on repositories you want the system to access
3. Use GitHub's "Only select repositories" option when installing the App

## Verification Criteria

| Criterion                          | Test Method                           |
| ---------------------------------- | ------------------------------------- |
| Durable Object creates with SQLite | Create session, verify tables exist   |
| WebSocket hibernation works        | Connect, idle 60s, send message       |
| Multiple clients sync state        | Connect 2 clients, verify sync        |
| GitHub OAuth flow completes        | Complete OAuth, verify token stored   |
| Token encryption works             | Store/retrieve token, verify matches  |
| Prompt queue ordering              | Enqueue 3 prompts, verify FIFO        |
| Session survives DO eviction       | Create, wait, reconnect, verify state |
| Ping/pong WebSocket health         | Send ping, verify pong                |
| Typing triggers sandbox warm       | Send typing, verify warming event     |
| Presence sync on connect           | Connect 2 clients, verify presence    |
