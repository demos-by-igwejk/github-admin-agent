---
name: repository-billing-report
description: Report exact observed repository/product/SKU costs for completed UTC months with explicit attribution, currency, and coverage limitations.
---

# Repository billing report

Use this skill for observed repository costs, not enterprise totals, invoices, license reclamation, or savings promises. Resolve the organization and concrete completed UTC months before executing; "last month" is not enough without the relevant clock and organization. A maximum of six distinct completed months may be requested using repeated `--month`. This is a product bound, not an API retention guarantee.

Use only `node src/cli.ts` in the reviewed full source checkout outside `node_modules`, with runtime dependencies installed and Node `^24.0.0 || ^26.0.0`. No compiler, build step, `tsx`, or custom loader is needed or authorized.

```sh
node src/cli.ts demo --scenario repository-billing-report --month 2026-08
node src/cli.ts demo --scenario repository-billing-report --outcome partial
```

Before proposing live use, inspect the credential-free authentication plan:

```sh
node src/cli.ts auth-plan repository-billing-report --org example-org --credential-class classic-pat
```

The plan's login/refresh commands are operator guidance, not authorization to run them. Never execute login, grant refresh, or account switching. The sole credential source is `gh-cli`; only the reviewed collector resolves its token privately. Never retrieve or display the token, dump the environment, or construct an environment-variable bridge. Copilot sign-in does not authorize billing reads.

For deliberate live use, explain that the reviewed detail endpoint reads organization billing; repository selectors filter the accepted result locally and do not reduce that source authorization scope. After the operator confirms scope, profile, credential class, grant choice, month, and normal command approval:

```sh
node src/cli.ts inspect repository-billing-report --org example-org --month 2026-08 --live --profile operator-assisted-local --credential-class classic-pat
```

This classic-PAT example follows the documented billing tutorial path, not a live-tested grant claim. Organization owner/billing-manager access and exact endpoint acceptance remain to be verified. Standard GitHub CLI OAuth is not a verified billing credential path. Public billing documentation is inconsistent about fine-grained PAT support; do not generalize or silently switch token types. App support for an enterprise endpoint does not establish organization-detail billing support. Consult `docs/support-matrix.md` and `docs/authentication.md`. Default restricted-reader live mode blocks because effective no-write grants cannot be established here.

The source is `GET /organizations/{org}/settings/billing/usage`, not `/usage/summary`. A summary probe cannot certify detail. No documented currency appears in the organization-detail schema: missing currency remains unspecified, never assumed USD. Preserve optional response currency and provenance when supplied. Do not invent pagination; an unmodelled continuation is a partial-contract problem.

Preserve exact decimal strings, signed adjustments, legitimate duplicate source rows, null-versus-zero, currencies, and units. Report included, excluded-by-selection, unattributed, and unresolved usage separately. Reconciliation is over accepted evidence only; unknown partitions are not zero or invoice bounds. Do not allocate user-level Copilot spend to repositories or equate inactive cost with avoidable cost.

Inventory composition is enabled unless explicitly opted out with `--no-inventory`. Only in-run composition is currently supported; do not invent an option to import another run's inventory. Valid billing evidence survives inventory failures, with actionable inventory reasons retained. Current activity observations do not reconstruct activity in the billing month.

```sh
node src/cli.ts result RUN_ID --view rows --repository example-org/api --sku actions-linux --limit 10
```

Page with the returned cursor and identical filters; use `--generation` for immutable historical selection. Read bounded views rather than entire evidence files. Copy numeric values exactly; do not recompute them in prose. Completed collection still leaves population unverified and provider finality unknown.

Use ordinary approvals and stop on denial without retries or alternative tools. This skill grants no tool approvals or optional hooks; the supplied VS Code help-command exception does not authorize collection. Only the source collector's reviewed reads are in scope, not arbitrary TypeScript entry points, endpoints, replacement scripts, improvised writes, or a host-wide sandbox claim. Honor cumulative recovery allowances and explicit `refresh --fresh` decisions.
