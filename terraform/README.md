# Terraform Deployment

This Terraform config deploys Surface as a production application.

The supported stack is:

- Cloudflare Workers, Durable Objects, D1, KV, and R2 for the web app and control plane
- Modal for sandbox execution and repo image builds
- GitHub OAuth plus one GitHub App installation for repository access

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
- Modal token, workspace, environment, and internal API secret
- GitHub OAuth client credentials
- GitHub App ID, private key, and installation ID
- Anthropic API key
- encryption and callback secrets
- at least one access-control allowlist

Keep `terraform.tfvars` local and uncommitted.

## First Deployment

From the production environment directory:

```bash
terraform init
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
