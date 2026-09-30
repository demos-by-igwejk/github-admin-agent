---
name: repository-activity-inventory
description: Inspect observed repository activity without billing access and distinguish active, inactive under a named policy, and unknown.
---

# Repository activity inventory

Use this skill for repository activity or inactivity questions, not billing, archival, deletion, or general administration. Resolve organization, repository/property selection, time window, enabled signals, synthetic/live intent, and budgets before executing. Ask for clarification if any meaningful decision is missing.

Use only `node src/cli.ts` in the reviewed full source checkout outside `node_modules`, with runtime dependencies installed and Node `^24.0.0 || ^26.0.0`. No compiler, build step, `tsx`, or custom loader is needed or authorized. Start with the credential-free demo when a synthetic result is requested:

```sh
node src/cli.ts demo --scenario repository-activity-inventory
node src/cli.ts demo --scenario repository-activity-inventory --outcome partial
```

Before proposing live use, inspect the credential-free authentication plan:

```sh
node src/cli.ts auth-plan repository-activity-inventory --org example-org --repo example-org/api
```

Explain the plan's operator-run setup commands and endpoint requirements without executing login, grant refresh, or account switching. The sole credential source is `gh-cli`; only the reviewed collector resolves its token privately. Never retrieve or display the token, dump the environment, or construct an environment-variable bridge. Copilot sign-in does not authorize the collector.

After explicit operator scope/profile/class decisions and ordinary command approval, a candidate live invocation is:

```sh
node src/cli.ts inspect repository-activity-inventory --org example-org --repo example-org/api --live --profile operator-assisted-local --credential-class oauth
```

This is an example to verify against the exact endpoint matrix, not proof of permission or read-only reach. Standard GitHub CLI OAuth grants can permit writes. Default restricted-reader live mode blocks because this distribution cannot establish effective no-write grants. No billing request is needed.

The default policy is push-only over six calendar months in UTC. Optional `--signal` values are `push`, `commits`, `issues`, `pull_requests`, `discussions`, and `actions`; repeat the option for the agreed set. Calendar months are not fixed-day approximations. A positive signal can establish active; negative classification needs sufficient evidence for all required enabled signals. Missing timestamps, denied or incomplete reads, and insufficient Actions history remain unknown. Retained Actions history cannot certify negative activity. Disabled and positive-short-circuited signals remain explicitly excluded.

Return the bounded view's counts and requested rows, qualify API-visible versus declared-target scope, and retain reason/evidence references. Say "inactive under the selected policy and observed scope," never "unused" or "safe to archive." Do not infer organization-wide population from successful pagination.

```sh
node src/cli.ts result RUN_ID --view rows --repository example-org/api --limit 25
```

Use the returned `--cursor` with identical view/filter parameters and, when pinning historical output, `--generation`. Do not read enormous evidence files into the model. Result paging makes no requests. Follow the shared agent's cumulative-budget resume/refresh rules; do not change policy during resume.

This skill grants no tool approvals or hooks. The supplied VS Code workspace rule approves only the exact credential-free activity-inspect help command, not collection. Ordinary host approvals still apply; a denial stops execution without retries or alternative tools. The runner's read-only operation set does not sandbox shell access or establish credential grants. Never use arbitrary endpoints, replacement scripts, or improvised writes.
