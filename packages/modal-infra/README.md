# Open-Inspect Modal Infrastructure

Modal-based sandbox infrastructure for the Open-Inspect coding agent system.

## Overview

This package provides the data plane for Open-Inspect:

- **Sandboxes**: Isolated development environments running OpenCode
- **Images**: Pre-built container images with all development tools
- **Snapshots**: Filesystem snapshots for fast startup and session persistence
- **Scheduler**: Image rebuilding infrastructure for repositories with pre-builds enabled

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Session Sandbox                              │
│  ┌──────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │  Supervisor      │  │  OpenCode       │  │  Bridge       │  │
│  │  (entrypoint.py) │──│  Server         │──│  (bridge.py)  │  │
│  └──────────────────┘  └─────────────────┘  └───────────────┘  │
│           │                    │                    │           │
│           └────────────────────┼────────────────────┘           │
│                                │                                │
│                        WebSocket to                             │
│                      Control Plane                              │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### Images (`src/images/`)

Base image definition with:
- Debian slim + git, curl, build-essential
- Node.js 22, pnpm, Bun
- Python 3.12 with uv
- OpenCode CLI
- agent-browser CLI + headless Chrome

### Sandbox (`src/sandbox/`)

- **manager.py**: Sandbox lifecycle (create, warm, snapshot)
- **entrypoint.py**: Supervisor process (runs as PID 1)
- **bridge.py**: WebSocket bridge to control plane
- **types.py**: Event and configuration types

### Auth (`src/auth/`)

- **github_app.py**: GitHub App token generation for repo access
- **internal.py**: HMAC authentication for control plane requests

### API (`src/`)

- **web_api.py**: HTTP endpoints called by the control plane

### Scheduler (`src/scheduler/`)

- **image_builder.py**: Repo image build workers and the 30-minute rebuild scheduler

## Usage

> **Full deployment guide**: See [docs/GETTING_STARTED.md](../../docs/GETTING_STARTED.md) for complete setup
> instructions including all required secrets and configuration.

### Prerequisites

1. Install Modal CLI: `pip install modal`
2. Authenticate: `modal setup`
3. Choose the Modal environment. Terraform sets `MODAL_ENVIRONMENT` for secrets and deploys:

```bash
export MODAL_ENVIRONMENT=main
```

4. Create secrets via Modal CLI:

```bash
# LLM API keys
modal secret create llm-api-keys ANTHROPIC_API_KEY="sk-ant-..."

# GitHub App credentials (for repo access)
modal secret create github-app \
  GITHUB_APP_ID="123456" \
  GITHUB_APP_PRIVATE_KEY="$(cat private-key-pkcs8.pem)" \
  GITHUB_APP_INSTALLATION_ID="12345678"

# Internal API secret (for control plane authentication)
modal secret create internal-api \
  MODAL_API_SECRET="$(openssl rand -hex 32)" \
  INTERNAL_CALLBACK_SECRET="<terraform-internal-callback-secret>" \
  CONTROL_PLANE_URL="https://your-control-plane.workers.dev" \
  ALLOWED_CONTROL_PLANE_HOSTS="your-control-plane.workers.dev"
```

See `.env.example` for a full list of environment variables.

### Install local packages

`sandbox-runtime` is a sibling package in this monorepo (not published to PyPI).
If you use `uv`, it is resolved automatically. Otherwise install it first:

```bash
pip install -e ../sandbox-runtime
pip install -e ".[dev]"
```

### Deploy

```bash
# Deploy the app (recommended)
export MODAL_ENVIRONMENT=main
modal deploy deploy.py

# Alternative: deploy the src package directly
modal deploy -m src

# Run locally for development
modal run src/
```

> **Note**: Never deploy `src/app.py` directly - it only defines the app and shared resources.
> Use `deploy.py` or `-m src` to ensure all function modules are registered.

## HTTP API

The control plane communicates with Modal via HTTP endpoints. All endpoints (except health)
require HMAC authentication via the `Authorization` header.

Endpoint URLs follow the pattern `https://{workspace-slug}--open-inspect-{endpoint}.modal.run`.
The workspace slug is `{workspace}` when `modal_environment_web_suffix` is empty and
`{workspace}-{suffix}` when it is set. `modal_environment` selects the Modal CLI and dashboard
environment; the web suffix only controls endpoint hostnames.

### Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `api-health` | GET | No | Health check |
| `api-create-sandbox` | POST | Yes | Create a new sandbox |
| `api-warm-sandbox` | POST | Yes | Pre-warm a sandbox |
| `api-snapshot-sandbox` | POST | Yes | Take filesystem snapshot |
| `api-restore-sandbox` | POST | Yes | Restore sandbox from snapshot |
| `api-build-repo-image` | POST | Yes | Start an async repo image build |
| `api-delete-provider-image` | POST | Yes | Best-effort cleanup for a replaced provider image |

### Sandbox Payloads

`api-create-sandbox` requires `session_id`, `repo_owner`, `repo_name`, `control_plane_url`, and
`sandbox_auth_token`. Optional fields are `sandbox_id`, `snapshot_id`, `opencode_session_id`,
`provider`, `model`, `timeout_seconds`, `branch`, `user_env_vars`, `repo_image_id`,
`repo_image_sha`, `code_server_enabled`, `agent_slack_notify_enabled`, `mcp_servers`, and
`sandbox_settings`.

`api-restore-sandbox` requires `snapshot_image_id`, `session_config`, `sandbox_id`,
`control_plane_url`, and `sandbox_auth_token`. `session_config` carries `session_id`, `repo_owner`,
`repo_name`, `provider`, `model`, and optional `branch` and `mcp_servers`. Optional top-level fields
are `timeout_seconds`, `user_env_vars`, `code_server_enabled`, `agent_slack_notify_enabled`, and
`sandbox_settings`.

`sandbox_settings` may include `terminalEnabled`, `tunnelPorts`, `cpuCores`, and `memoryMib`.
`cpuCores` maps to Modal CPU cores and `memoryMib` maps to Modal memory in MiB. Both sandbox
endpoints return `sandbox_id`, `modal_object_id`, `status`, and any `code_server_url`,
`code_server_password`, `ttyd_url`, or `tunnel_urls` created for the sandbox.

### Example: Create Sandbox

```bash
curl -X POST "https://${WORKSPACE_SLUG}--open-inspect-api-create-sandbox.modal.run" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "session-123",
    "repo_owner": "your-org",
    "repo_name": "your-repo",
    "control_plane_url": "https://your-control-plane.workers.dev",
    "sandbox_auth_token": "your-token"
  }'
```

### Example: Health Check

```bash
curl "https://${WORKSPACE_SLUG}--open-inspect-api-health.modal.run"
# {"success": true, "data": {"status": "healthy", "service": "open-inspect-modal"}}
```

### Repo Image Builds

`api-build-repo-image` starts an async image build and returns immediately:

```json
{
  "repo_owner": "your-org",
  "repo_name": "your-repo",
  "default_branch": "main",
  "build_id": "img-your-org-your-repo-1730000000000",
  "callback_url": "https://your-control-plane.workers.dev/repo-images/build-complete",
  "user_env_vars": {
    "EXAMPLE_SECRET": "value"
  }
}
```

`user_env_vars` is optional and comes from the control plane's merged global and repo secrets for
the build sandbox. The response is:

```json
{
  "success": true,
  "data": {
    "build_id": "img-your-org-your-repo-1730000000000",
    "status": "building"
  }
}
```

The build worker snapshots the completed filesystem and posts the result to `callback_url`. Failures
are posted to the matching `/repo-images/build-failed` callback.

`api-delete-provider-image` accepts `{ "provider_image_id": "..." }` and returns the requested ID
with `deleted: true`. Modal images are garbage-collected when they are no longer referenced, so this
endpoint records the cleanup request for auditability.

### Scheduled Rebuilds

`rebuild_repo_images` runs every 30 minutes. It reads enabled repositories from the control plane,
checks the current GitHub `main` SHA, triggers builds when the latest ready image is stale, marks old
building rows as failed, and deletes old failed rows. It requires `CONTROL_PLANE_URL` in the
`internal-api` secret; Terraform injects this value during deployment. Without it, the scheduler logs
`scheduler.no_control_plane_url` and exits.

## Environment Variables

Set via Modal secrets:

| Variable | Secret | Description |
|----------|--------|-------------|
| `ANTHROPIC_API_KEY` | `llm-api-keys` | Anthropic API key for Claude |
| `GITHUB_APP_ID` | `github-app` | GitHub App ID for repo access |
| `GITHUB_APP_PRIVATE_KEY` | `github-app` | GitHub App private key (PKCS#8) |
| `GITHUB_APP_INSTALLATION_ID` | `github-app` | GitHub App installation ID |
| `MODAL_API_SECRET` | `internal-api` | Shared secret for control plane auth |
| `INTERNAL_CALLBACK_SECRET` | `internal-api` | Shared secret for Modal to sign control plane callbacks; must match control plane `INTERNAL_CALLBACK_SECRET` |
| `CONTROL_PLANE_URL` | `internal-api` | Control-plane base URL used by scheduled repo image rebuilds |
| `ALLOWED_CONTROL_PLANE_HOSTS` | `internal-api` | Comma-separated allowed hostnames for URL validation |

## Verification Criteria

| Criterion | Test Method |
|-----------|-------------|
| App deploys successfully | `modal deploy deploy.py` completes without errors |
| Health endpoint responds | `curl https://{workspace-slug}--open-inspect-api-health.modal.run` |
| Sandbox creation works | POST to `api-create-sandbox` returns success |
| Git sync completes | Verify HEAD matches origin after sandbox start |
| Snapshot/restore works | Take snapshot, restore, verify workspace state |

## Development

```bash
# Using uv (recommended — resolves sandbox-runtime automatically)
uv sync --frozen --extra dev

# Using pip (install sandbox-runtime first)
pip install -e ../sandbox-runtime
pip install -e ".[dev]"

# Run tests
pytest tests/

# Type check
mypy src/
```

### Health Check

The health endpoint is available at `GET /api_health` (no authentication required).
