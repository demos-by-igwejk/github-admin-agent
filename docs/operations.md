# Operations and evidence

## Read execution separately from assurance

| Status      | Exit  | Meaning                                                                                                        |
| ----------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| `completed` | `0`   | All required work has valid evidence or a policy-permitted terminal outcome. Assurance can still be qualified. |
| `partial`   | `2`   | A usable result exists, but required work failed or is unassessed for reasons other than only waiting.         |
| `deferred`  | `3`   | Only provider waiting or an explicit budget decision prevents completion. Honor the recorded deadline.         |
| `failed`    | `1`   | Invalid input, unsupported operation, or no usable requested result.                                           |
| `cancelled` | `130` | Operator cancellation; safe evidence may still be available.                                                   |

Population is `unverified` for repository discovery and `not-applicable` when the result has no population claim. Billing finality remains `unknown`; nonfinancial results can mark it `not-applicable`. Source freshness is observed, not certified. Neither a synthetic marker, completed pagination, operator assertion, nor file digest promotes these dimensions.

Activity evidence describes a collection interval under the named policy. Current inventory and a past billing month are different observations. A negative Actions history search cannot certify inactivity because retention and history coverage are insufficient. A settings comparison is not a compliance certification.

## Bounded result views

The CLI's model-facing JSON is capped at 64 KiB of UTF-8. Default row budgets are 25 inventory rows, 10 billing groups, and 50 settings findings, subordinate to the byte limit. Rows beyond a summary budget remain in the immutable result. Overlong fields are abbreviated with references rather than treated as missing source evidence.

```sh
node src/cli.ts result RUN_ID --view summary
node src/cli.ts result RUN_ID --view rows --repository example-org/api --limit 25
node src/cli.ts result RUN_ID --view rows --sku actions-linux --reason REASON_CODE --limit 10
node src/cli.ts result RUN_ID --view rows --repository example-org/api --limit 25 --generation GENERATION --cursor CURSOR
```

Use actual run IDs, generations, reason codes, and opaque cursors from the collector. Copy cursor text verbatim and retain the view and filter parameters that produced it. Do not assume an activity `classification` flag exists in the CLI; the exposed result filters are `--repository`, `--sku`, and `--reason`. Summary totals retain their all-source label independently of selected rows. A result command performs no collection, requires no token, and does not refresh timestamps.

Preserve numeric strings without rounding or model arithmetic. Billing keeps monthly partitions, currencies, and units separate and records response-supplied currency or null with `not-supplied` provenance. Display null currency as unspecified, not USD. Unattributed user-level Copilot charges remain unattributed. Exact reconciliation covers accepted source evidence, not unresolved partitions or the final invoice.

## Budgets and recovery

Defaults are 1,000 cumulative attempts, 900,000 ms elapsed active/wait allowance, two concurrent reads, a 30,000 ms request timeout, and at most three attempts per request. Retries consume the same allowance. These are bounded starting settings, not performance measurements. [API client reliability](reliability.md) explains exactly which failures are retried, how REST/GraphQL provider waits are persisted, and how response and continuation contracts are validated.

Use `--max-requests` and `--max-elapsed-ms` for a new inspect request or validated configuration values for the other budget fields. Collection stops rather than exceeding a provider wait deadline or silently increasing its allowance. Do not run a loop that starts new inspect runs to evade a stop.

```sh
node src/cli.ts resume RUN_ID --sequence 7 --live --profile operator-assisted-local
node src/cli.ts resume RUN_ID --live --profile operator-assisted-local --additional-requests 50 --additional-elapsed-ms 60000 --allowance-reason "Operator approved retry of the recorded incomplete targets"
node src/cli.ts refresh RUN_ID --fresh --live --profile operator-assisted-local
```

The checkpoint sequence above is illustrative; use the current recorded sequence. Resume preserves the stored scenario, input, configuration, principal binding, observations, and cumulative root allowance. A stale checkpoint or incompatible input does not receive a fresh budget. Repository, policy, host, month, and signal overrides cannot be used to turn resume into a different request.

Recovery also checks the content-derived `codeVersion` captured at CLI startup. Changes to runtime source, `package.json`, or `package-lock.json` can make a previous lineage incompatible even when the package release number is unchanged. Do not rewrite stored versions or receipts to bypass that check; see the [source identity boundary](acceptance.md#source-identity-and-dependency-boundary).

Refresh requires the explicit `--fresh` decision, creates new observations with a parent link, and retains the same root allowance. A `--config` supplied during recovery must remain compatible with the stored binding. Both additional-budget options require a recorded `--allowance-reason`. A reason without an increment is invalid. Use a new independent request only for a genuinely new, explicitly authorized scope.

For live recovery, the collector resolves the current token privately through `gh` and a user credential must reverify the same principal. A `gh` account switch or environment-token override can therefore make recovery incompatible. An App installation token's repository-access probe does not verify its installation identity; this release cannot resume or refresh that unverified live identity. Do not change token classes or declare an identity as verified to work around this restriction.

Managed lineage prevents accidental stale/concurrent replay, not tampering by an operator who controls local files. Do not edit checkpoints or remove locks to manufacture completion or restore allowances. Provider `Retry-After`, REST reset guidance, and GraphQL ISO DateTime `resetAt` can establish a durable not-before deadline.

## Local data handling

The configured output directory contains private lineage state and immutable published generations with result, summary, manifest, evidence, diagnostics, and export artifacts. Use the current generation pointer and manifest rather than guessing filenames or overwriting an earlier generation. Manifests and hashes detect consistency problems, not provider completeness or authentic human approval.

Operational reports can contain sensitive organization names, principal metadata, ownership labels, usage, and policy findings. Default `reports/`, local configuration, local owners/policies, environment files, and state directories are ignored local data, not approved source-distribution content. A custom `--reports` path still needs appropriate local access control and an ignore rule; path containment is not automatic publication consent.

Secrets and authorization headers must not appear in outputs. The collector's `gh` token resolution is private; do not invoke token-printing commands in an agent conversation or capture their output as an acceptance receipt. Redaction, restrictive local file modes, and spreadsheet-safe text exports reduce accidental disclosure; none makes arbitrary shell access safe. Inspect exports in an appropriate local tool rather than pasting full evidence into a model. Do not upload, commit, or externally publish live artifacts without a separate explicit decision.

`retentionDays` defaults to 30 and is recorded configuration for operator-managed retention. There is no automatic purge command or background deletion service in this release. Schedule deletion only through your own approved retention procedure, preserve necessary lineage while recovery remains authorized, and do not recursively delete the workspace. Windows path, locking, and permission behavior remain unclaimed.

## What doctor does not prove

Local `doctor` checks local configuration/runtime metadata without reading the secret or making API requests. Live `doctor --scenario ID` probes identity and a minimal declared operation. Repository scenarios may probe listing without exercising every selected repository, field, or enabled signal. Billing doctor uses the actual organization detail operation, not a summary substitute, but successful transport alone does not validate every domain amount or grant.

The [opt-in live harness](acceptance.md) records both minimal doctor and scoped scenario inspection so an actual detailed response is domain-validated. Any coverage it does not exercise remains pending. Neither command certifies no-write effective grants, estate-wide visibility, historical completeness, or billing finality.
