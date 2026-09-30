# Troubleshooting

Start with `node src/cli.ts --version`, `node src/cli.ts scenarios list`, and a credential-free demo from the reviewed checkout. Use `node src/cli.ts doctor --org example-org` for local metadata and `node src/cli.ts auth-plan SCENARIO_ID --org ORG` for authorization guidance. These commands do not retrieve a token or contact GitHub. Never print credentials or dump the environment while diagnosing a failure.

## Runtime and host setup

| Symptom | Interpretation and supported response |
|---|---|
| Missing `src/cli.ts` | Use the full source checkout outside `node_modules`; no standalone CLI artifact or build is required. |
| Missing runtime dependency | Install the locked checkout dependencies with `npm ci`, or use the production-only `npm ci --omit=dev --ignore-scripts` setup. |
| Missing or invalid package/lock metadata | Restore the reviewed source and its package metadata together. Initialization can fail before CLI error handling; do not fabricate versions to force startup. |
| `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | Native Node does not execute TypeScript beneath `node_modules`. Use the supported source-checkout layout, not a loader or packed/global npm installation. |
| Unsupported TypeScript syntax or Node line | Use erasable TypeScript, explicit local `.ts` imports, and Node `^24.0.0` or `^26.0.0`. Other runtime lines have no support claim. |
| Agent or skill not discovered | Follow the host-specific [getting-started guide](getting-started.md). Select the native adapter in the reviewed workspace; file presence alone does not establish host acceptance. |
| Denied host command approval | Stop that operation. Do not rephrase it, switch tools, or create a replacement collector. |
| Remote/host process cannot find `gh` or its account | Configure GitHub CLI in the environment actually running the collector. Copilot login and a local terminal's credential store do not prove access from another process or remote host. |

## Authentication and identity

| Reason | Interpretation and supported response |
|---|---|
| `legacy_credential_source` | Remove `credential.tokenEnv` or `--token-env`; the sole source is `gh-cli`. Select the intended effective `gh` credential outside Copilot rather than falling back to another token. |
| `unverified_credential_reach` | Restricted-reader live mode cannot prove no-write grants and remains blocked. Make a separate explicit operator-assisted or credential-isolated collection decision if appropriate. |
| `explicit_profile_required` | Supply `--profile operator-assisted-local` on this live invocation, even when the profile appears in configuration. |
| `live_authorization_required` | Use a demo for synthetic evidence or explicitly authorize the scoped live request with `--live`. |
| `credential_class_required` | Declare the endpoint-appropriate class based on provisioning. A `gh-cli` source or a token variable name does not establish that class. |
| `gh_cli_unavailable` | Install GitHub CLI or correct its executable permissions and `PATH` in the collector environment. Catalog, auth-plan, local doctor, demo, and result still work without it. |
| `gh_auth_failed` | Use auth-plan and review the intended account, environment-token precedence, and credential-store access privately. The collector deliberately does not expose subprocess output or change authentication for you. |
| `gh_auth_timeout` | Authentication is bounded by the smaller of 10 seconds and configured `maxElapsedMs`. Check credential-store responsiveness and the local elapsed bound before an explicit retry. |
| `gh_auth_output_too_large` or `gh_auth_invalid_output` | Check the local `gh` installation without displaying its output. Combined output is capped at 16 KiB; malformed or multiline output is not a valid credential. |
| `operator_cancelled` before run creation | Preflight stopped with cancellation exit code `130`; no API collection or resumable run was created. |
| `identity_probe_failed` or `identity_mismatch` | Review account selection and authorization externally. `GH_TOKEN` or `GITHUB_TOKEN` can override the stored account. Recovery must reverify the same principal; do not rewrite the identity binding. |
| Unverified installation identity | A repository-access probe does not verify the installation principal. Live recovery is unsupported for that unverified identity; do not mark it verified manually. |

[Authentication](authentication.md) explains private token resolution, candidate setup commands, migration, scope reach, and billing uncertainty. Login/refresh/switch and grant changes are operator actions outside Copilot, not automatic error recovery.

## API, policy, and recovery

| Symptom or reason | Interpretation and supported response |
|---|---|
| 401/403/404 or absent fields | Check the exact endpoint, effective grants, organization policy, OAuth restrictions, SSO/token approval, repository visibility, and feature availability. Denied or missing evidence is unknown, not empty or inactive. Ordinary denials do not justify repeated retries or broader scopes. |
| `unsupported_deployment` | Only github.com organization/repository scope is implemented. Do not substitute another API origin for GHE.com or GHES. |
| Invalid policy, unknown keys, duplicate owners/targets, or `scope_mismatch` | Correct the explicit workspace input. Do not discard malformed files, invent a baseline, or expand the organization scope. |
| Unsafe path or symlink | Use an approved project-relative regular path. Do not bypass containment or write state outside the workspace. |
| Deferred with a deadline | Honor the recorded not-before time and cumulative allowance, then explicitly resume. Do not create new inspect/refresh requests to evade a stop. |
| Stale lineage or incompatible recovery | Preserve the recorded configuration, scope, principal, and exact code version. Changed source or configuration can require a new request; do not edit checkpoints, remove locks, or reset counters. |
| Unspecified billing currency | The detail schema supplies no universal currency. Keep it unspecified rather than assuming USD or converting amounts. |
| Partial billing despite reconciled totals | Reconciliation covers accepted rows only. Inspect unresolved partition and inventory reasons; missing evidence is not zero. |
| Actions activity is unknown | Retained workflow-run history cannot establish complete negative activity. A policy change requires an explicit new scope decision. |
| Cursor/view mismatch or corrupt generation | Use the generation and unchanged filters that produced the cursor, or request a fresh view of the last coherent generation. Paging does not require recollection. |
| Compact rather than indented JSON | CLI output normally uses four-space indentation. If that representation exceeds 64 KiB, the complete bounded value is serialized compactly; no fields or rows are discarded merely to change formatting. |
| `model_view_too_large` | Use a smaller supported result page or inspect referenced local artifacts in an appropriate tool. Both readable and compact stdout remain subject to the final 64 KiB cap. |

The [reliability guide](reliability.md) explains API retry, pagination, timeout, and source-contract behavior. The [operations guide](operations.md) covers status and recovery, and the [support matrix](support-matrix.md) separates documented candidates from live acceptance. The [architecture guide](architecture.md) describes the collector boundary; shell-capable hosts and broader credentials are not sandboxed by the read-only operation list.
