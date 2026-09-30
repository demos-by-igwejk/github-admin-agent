---
name: repository-settings-audit
description: Compare selected repository settings with an explicit versioned baseline and explain compliant, drift, unknown, and not-applicable findings without remediation.
---

# Repository settings audit

Use this skill for supported repository settings comparisons. Clarify the organization, selected repositories, explicit baseline path, and synthetic/live intent before execution. Do not invent a policy from a vague request for compliance.

Use only `node src/cli.ts` in the reviewed full source checkout outside `node_modules`, with runtime dependencies installed and Node `^24.0.0 || ^26.0.0`. No compiler, build step, `tsx`, or custom loader is needed or authorized.

```sh
node src/cli.ts demo --scenario repository-settings-audit
node src/cli.ts demo --scenario repository-settings-audit --outcome partial
```

The no-config demo uses its built-in synthetic baseline. Real audits require the reviewed local policy, defaulting to `config/policies/repositories.json`. Before proposing live use, inspect the credential-free authentication plan:

```sh
node src/cli.ts auth-plan repository-settings-audit --org example-org --repo example-org/api
```

Explain the plan's operator-run setup commands and required reads without executing login, grant refresh, or account switching. The sole credential source is `gh-cli`; only the reviewed collector resolves its token privately. Never retrieve or display the token, dump the environment, or construct an environment-variable bridge. Copilot sign-in does not authorize the collector.

After explicit scope/profile/class/grant decisions and ordinary command approval:

```sh
node src/cli.ts inspect repository-settings-audit --org example-org --repo example-org/api --policy config/policies/repositories.json --live --profile operator-assisted-local --credential-class oauth
```

The example credential class must be checked against the endpoint matrix; it does not prove effective grants. Standard GitHub CLI OAuth grants can permit writes. Default restricted-reader live mode is blocked because no-write effective grants cannot be independently established here.

The versioned baseline accepts repository visibility, archived state, default branch, merge-commit/squash/rebase settings, and delete-branch-on-merge. Each finding preserves rule identity, expected value, observed value when available, outcome, observation time, and evidence. Missing fields or denied reads are unknown, not drift. A rule excluded for a repository is not applicable, not proof that a missing feature is compliant.

```sh
node src/cli.ts result RUN_ID --view rows --repository example-org/api --limit 50
```

Use the returned cursor with the same filters, and `--generation` for a fixed historical generation. Full findings remain in local artifacts; bounded summary rows are not the complete export. Do not feed enormous evidence files into the model.

Explain the comparison and qualified scope, then label suggested follow-up as non-executed advice. This is not a compliance certification. Apply, changes, archival, deletion, and improvised remediation are unsupported, even if a user says "yes."

Ordinary approvals remain necessary and denial stops execution without retries or alternative tools. This skill grants no tool approvals or optional hooks; the supplied VS Code help-command exception does not authorize collection. The reviewed runner's read-only operations do not sandbox shell access. Never call arbitrary endpoints, write replacement scripts, or promote assurance using synthetic results or hashes. Resume/refresh must retain the shared lineage and cumulative-budget rules.
