# ADR 0001: GitHub-Only Source Control Boundary

## Status

Accepted

## Context

Surface is a production background-agents application. The supported source-control system is GitHub
through one GitHub App installation plus user OAuth for attribution-sensitive actions.

Earlier upstream code explored other source-control providers, but Surface does not ship those
paths. Keeping provider switches in product code, Terraform, tests, or docs makes the application
look like a provider matrix instead of the deployed system we operate.

## Decision

1. Surface source control is GitHub-only.
2. The control plane creates a GitHub source-control provider from GitHub OAuth and GitHub App
   configuration.
3. Sandboxes authenticate git operations through the GitHub credential helper and short-lived GitHub
   App installation tokens.
4. Product code, deployment config, and docs must not expose source-control provider selection.

## Consequences

- GitHub behavior remains direct and auditable.
- Deployment setup is smaller because there is no source-control provider switch.
- Adding another source-control system would require a new ADR and a deliberate product decision.
