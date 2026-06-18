# Terraform Deployment

This Terraform config deploys Surface as a production application.

The supported stack is:

- Cloudflare Workers, Durable Objects, D1, KV, and R2 for the web app and control plane
- Modal for sandbox execution and repo image builds
- GitHub OAuth, optional Google OAuth, and one GitHub App installation for GitHub repository access

There is no selectable web platform, sandbox backend, or source-control provider in this deployment
module.

## Layout

```text
terraform/
├── environments/
│   └── production/
│       ├── *.tf
│       └── terraform.tfvars.example
└── modules/
    ├── cloudflare-worker/
    └── modal-app/
```

## Required Inputs

Create `terraform/environments/production/terraform.tfvars` from `terraform.tfvars.example` and fill
in:

- Cloudflare account, API token, and Workers subdomain
- Modal token, workspace, environment, and `modal_api_secret`
- `deployment_name`
- GitHub OAuth client credentials
- optional Google OAuth credentials, `google_client_id` and `google_client_secret`, if enabling
  Google login
- GitHub App ID, private key, and installation ID for repository access
- Anthropic API key
- encryption, callback, and auth secrets: `token_encryption_key`, `repo_secrets_encryption_key`,
  `internal_callback_secret`, and `nextauth_secret`
- at least one access-control allowlist, either `allowed_users`, `allowed_email_domains`, or
  `allowed_emails`

Keep `terraform.tfvars` and `backend.tfvars` local and uncommitted.

## First Deployment

From the production environment directory:

```bash
wrangler r2 bucket create open-inspect-terraform-state
cp backend.tfvars.example backend.tfvars
```

Fill `backend.tfvars` with the R2 access key, secret key, and account endpoint:

```hcl
endpoints = {
  s3 = "https://<cloudflare_account_id>.r2.cloudflarestorage.com"
}
```

```bash
terraform init -backend-config=backend.tfvars
terraform plan
terraform apply
```

For a first deployment, set:

```hcl
enable_durable_object_bindings = false
enable_service_bindings        = false
```

After the first successful apply, set both values to `true` and apply again.

## Verification

After apply, use the Terraform outputs:

```bash
curl <control_plane_url>/health
curl <modal_health_url>
curl <web_app_url>
```

The `/sessions` endpoint should require authentication.
