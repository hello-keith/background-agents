# Getting Started

Surface is a production background-agents application. The supported deployment stack is Cloudflare
Workers for the web and control plane, Modal for sandboxes, and GitHub for repository access.

## Prerequisites

- Node.js and npm
- Python with `uv`
- Terraform
- Wrangler
- Modal CLI
- Cloudflare account with Workers, Durable Objects, D1, KV, and R2 access
- Modal workspace
- GitHub App installed on the repositories Surface may access
- Google OAuth client if enabling Google login

## Local Setup

```bash
npm install
npm run build -w @open-inspect/shared
npm test -w @open-inspect/control-plane
npm test -w @open-inspect/web

cd packages/modal-infra
uv sync --frozen --extra dev
pytest tests/ -v
```

## GitHub App

Create one GitHub App for OAuth login and repository access.

Configure the app with:

- **Callback URL**: `<web_app_url>/api/auth/callback/github`
- **Account permissions**: Email addresses, read-only
- **Repository permissions**: Contents, read and write; Pull requests, read and write; Metadata,
  read-only
- **Optional bot and automation permissions**: Issues, read and write for GitHub bot issue events;
  Checks, read-only for `check_suite.completed` automations

If users outside the app owner should sign in, set **Where can this GitHub App be installed?** to
**Any account**.

After creating the app:

1. Generate a client secret and record the Client ID and Client Secret.
2. Generate a private key and convert it to PKCS#8 format:
   ```bash
   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
     -in ~/Downloads/your-app-name.*.private-key.pem \
     -out private-key-pkcs8.pem
   ```
3. Install the app on the repositories Surface may access.
4. Record the Installation ID from the installation URL.

Required values:

- `github_client_id` from the GitHub App Client ID
- `github_client_secret` from the generated client secret
- `github_app_id` from the GitHub App App ID
- `github_app_private_key` from `private-key-pkcs8.pem`
- `github_app_installation_id` from the installed app URL

Install the app only on repositories Surface should be able to clone, branch, push, and open pull
requests against.

## Optional Google Login

Create a Google OAuth Web client and add this production redirect URI:

```text
<web_app_url>/api/auth/callback/google
```

Set both Terraform values to enable Google login:

- `google_client_id`
- `google_client_secret`

Terraform derives `NEXT_PUBLIC_GOOGLE_ENABLED` for the web build. Google sign-in uses the user's
verified Google email for access control, so configure `allowed_email_domains` or `allowed_emails`.
`allowed_users` matches GitHub usernames and does not admit Google-only users.

## Modal

Create a Modal token and choose the workspace and environment that will host the sandbox API.

Required values:

- `modal_token_id`
- `modal_token_secret`
- `modal_workspace`
- `modal_environment`
- `modal_api_secret`

## Cloudflare

Create a Cloudflare API token with permissions for Workers, Durable Objects, D1, KV, and R2.

Required values:

- `cloudflare_api_token`
- `cloudflare_account_id`
- `cloudflare_worker_subdomain`

## Terraform

Copy the production example file and fill in the values:

```bash
cd terraform/environments/production
cp terraform.tfvars.example terraform.tfvars
```

Fill the provider-specific values from the sections above, plus these required app values:

| Value                         | How to set it                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `anthropic_api_key`           | Create an API key in the Anthropic Console.                                                       |
| `token_encryption_key`        | Generate with `openssl rand -base64 32`.                                                          |
| `repo_secrets_encryption_key` | Generate with `openssl rand -base64 32`.                                                          |
| `internal_callback_secret`    | Generate with `openssl rand -base64 32`; Modal uses the same value as `INTERNAL_CALLBACK_SECRET`. |
| `nextauth_secret`             | Generate with `openssl rand -base64 32`.                                                          |
| `deployment_name`             | Use a unique, stable slug for resource names and URLs.                                            |

Create the R2 bucket used for Terraform state, then copy the backend config:

```bash
wrangler r2 bucket create open-inspect-terraform-state
cp backend.tfvars.example backend.tfvars
```

Fill `backend.tfvars` with the R2 access key, secret key, and endpoint:

```hcl
endpoints = {
  s3 = "https://<cloudflare_account_id>.r2.cloudflarestorage.com"
}
```

For the first apply, keep:

```hcl
enable_durable_object_bindings = false
enable_service_bindings        = false
```

Run:

```bash
terraform init -backend-config=backend.tfvars
terraform plan
terraform apply
```

After the first successful apply, set both flags to `true` and apply again.

## Access Control

Configure at least one of:

- `allowed_users`
- `allowed_email_domains`
- `allowed_emails`

Email allowlists apply to verified emails from any auth provider. GitHub username allowlists apply
only to GitHub sign-in.

Use `unsafe_allow_all_users = true` only for an intentionally open deployment.

## Verify Deployment

Use Terraform outputs:

```bash
curl <control_plane_url>/health
curl <modal_health_url>
curl <web_app_url>
```

Then open the web app, sign in, and create a test session against a repository installed on the
GitHub App.
