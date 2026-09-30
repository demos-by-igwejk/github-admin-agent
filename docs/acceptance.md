# Acceptance and remaining release gates

**Actual host acceptance remains pending for Copilot CLI, both VS Code harnesses, and the GitHub Copilot app. Live API acceptance is also pending.** The scripts below are opt-in source-checkout tooling. Neither file discovery, a static test, a configured CI workflow, nor an imported digest is a passed host/live/production gate. See [reliability boundaries](reliability.md).

| Gate                         | What the supplied tooling does                                                                                                                                                                       | What remains external                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Offline delivery consistency | Validates example schemas, IDs, command spellings, pinned CI, corpus structure, and explicit limitations.                                                                                            | It does not exercise a Copilot host or administrative API.                                                                                |
| Actual Copilot host          | Imports human-captured receipts and evaluates routing annotations, execution records, exact numeric strings, category accuracy, and run-to-run variation.                                            | Actual installed Copilot sessions, normal approvals and denials, complete capture, and independent receipt review.                        |
| Live/API contract            | Explicitly invokes the reviewed source CLI's minimal live doctor and then its actual scoped scenario, recording versions, declared grants, accepted endpoints, and digest-bound artifact references. | Endpoint/role/token coverage not exercised, independent grant verification, and review of retained diagnostics.                           |
| Full release/pilot           | No automatic certification.                                                                                                                                                                          | Applicable release requirements, actual host approvals, exact live/API contracts, release ownership decisions, and measured pilot observations. |

## Prepare a source checkout

Use the full development checkout outside `node_modules` with Node `^24.0.0 || ^26.0.0`, install with `npm ci`, and run the quickstart checks and a normal credential-free `node src/cli.ts demo --scenario repository-activity-inventory`. There is no compilation or build step. The demo initializes the default managed `reports/` artifact root. Do this before creating acceptance captures inside `reports/`; an unmanaged nonempty reports directory is intentionally rejected by the collector. The scripts require the existing managed-root marker rather than inventing one.

Keep captures local under the ignored `reports/host-acceptance/` or `reports/live-acceptance/` directories. Use project-relative regular paths, no symlinks, and restrictive local access. Review files for secrets before import; never include tokens or authorization headers. Hashes bind file contents for consistency, not authenticity, no-write grants, or source finality.

Do not run either harness in normal CI. CI targets Linux/macOS with minimum Node 24.0.0, latest Node 24, and latest Node 26 using the network-block fixture preload. Those synthetic checks are separate from Copilot's own network-dependent service and from deliberate live requests.

## Source identity and dependency boundary

`getSourceIdentity()` in `src/core/source-revision.ts` freshly computes `sourceSha256`, a full 64-character lowercase SHA-256 over the sorted `src/` runtime tree plus `package.json` and `package-lock.json`. It resolves the checkout relative to its source module, not the current working directory. Its `codeVersion` is `<packageVersion>+<first12hex>` from that digest; the CLI snapshots this value as `CODE_VERSION` at startup. Receipt versions must match this exact runtime identity, not just the package release number.

Host acceptance separately binds `adapterSha256` over `.github/copilot-instructions.md`, `.github/agents/github-admin.agent.md`, all three native `SKILL.md` files, and `.vscode/settings.json`. The corpus has its own `corpusSha256`. Import rejects source, adapter, or corpus mutation during validation. The collector's runtime identity is unchanged by this additional host binding.

Keep reviewed bytes stable throughout capture and validation. Hashes do not make files immutable or attest authenticity. Installed dependency bytes, host settings outside the supplied workspace configuration, acceptance scripts, and capture mechanisms still require independent review. Dependency integrity relies on the locked npm install and its integrity checks.

The current corpus is version `3.0.0` with schema `"2"`; receipt batches and validation reports also use schema `"2"`. Older CLI-only or bundle-based receipt formats are rejected. Keep them as historical observations, not current acceptance evidence. Recollect against the actual selected client and current reviewed files; renaming fields or relabeling a CLI transcript as an app observation does not establish a new observation.

Obtain the current local bindings without credentials or host execution:

```sh
node scripts/host-acceptance.mjs --identity
```

This prints source, adapter, and corpus bindings from the executing checkout. It is an operator acceptance helper, not a new collector operation or host acceptance run.

## Host: human capture plus a receipt validator

`scripts/host-acceptance.mjs` is a **recorder, not an automated Copilot acceptance run**. It does not launch Copilot, generate model replies, make approvals, or manufacture denial receipts. A safe noninteractive denial boundary has not been established here, so no broad preapproval or automated shell-approval workaround is supplied.

Run the installed client manually against the reviewed local checkout with ordinary approvals. Use the [client setup guide](getting-started.md#select-a-native-copilot-surface):

| Target | Startup and selection evidence |
| --- | --- |
| Copilot CLI | Actual `copilot --agent github-admin` argv, optional explicit model, CLI version, repository agent/skills/instructions, and ordinary approval mode. |
| VS Code Local | VS Code and Copilot extension versions; Session Target Local; Agent github-admin; Folder isolation; Manual permissions; repository customizations and native tools. |
| VS Code Copilot | The same UI evidence with Session Target Copilot. Record this harness separately; automatic New Worktree/Allow all sessions do not qualify. |
| GitHub Copilot app | App version; selected github-admin agent; Interactive mode; local-repository or prepared local-worktree location; discovered skills/instructions and tool auto-approval disabled. |

For CLI startup, the reviewed form is:

```sh
copilot --version
node --version
copilot --agent github-admin
```

An explicit operator-selected `--model MODEL_ID` can be recorded for CLI launch, but no model is a product requirement. Record whether a model value is observed or declared; Auto selection does not prove a fixed underlying model. Record a separate runtime version only when actually observed, not by substituting another installed CLI's version for a GUI client's runtime.

Keep administrative credentials absent from the host test environment; the corpus uses only synthetic collector data and never needs GitHub CLI authentication. Copilot's own sign-in is separate. Do not use broad auto-approval, Autopilot, live endpoints, replacement scripts, token retrieval, or sandbox bypasses. The narrow supplied VS Code help rule may remain, but demo decisions must be actual manual approvals or denials.

Verify the origin of the actual repository agent, three skills, and shared instructions. Capture native skill loading for each scenario case, not merely the existence of a file. Retain displayed versions, model context, execution directory/workspace mode, enabled tools, and effective approval configuration. UI sessions need genuine UI/session evidence; do not invent CLI launch argv for them. Screenshots can support metadata, but complete text transcripts, tool audits, responses, and collector stdout remain mandatory.

The corpus at `tests/host-acceptance/intent-corpus.json` has 39 cases: 21 normal, nine ambiguous, six unsupported, and three approval-denial cases. Run every case in each of at least two independent rounds for one homogeneous surface/harness/platform/client-version/extension-version/runtime-version/Node-version/workspace target. All rounds must use the same current source, adapters, and corpus. Different clients, VS Code harnesses, platforms, versions, or workspace modes cannot be pooled to satisfy this requirement. Use a separate batch for each target.

Start a fresh case conversation or otherwise isolate its scope; retain the complete per-case transcript so earlier answers do not supply missing inputs.

For normal cases, approve only the exact reviewed synthetic command and necessary helpers. For denial cases, deny the actual demo command in the normal host approval UI and retain subsequent tool history to show whether an alternative was attempted. Ambiguous and unsupported cases require zero collector execution. Approved catalog lookup and the exact activity-inspect help command are non-collecting routing helpers; they do not authorize collection or retries after denial. All extra or improvised shell activity must remain visible, not edited out.

Capture the actual prompt, full transcript, assistant response, complete tool audit, each displayed command approval/denial, execution receipt, bounded collector stdout, and exit code as local text files. **Never synthesize receipts**, substitute a fixture response for observed host output, or create an empty audit to claim that nothing executed. Do not execute a command outside Copilot and present it as a Copilot execution receipt. Use your approved terminal/session capture mechanism; this distribution does not attest that mechanism.

For exact-value cases, the corpus requests plain response lines such as `example-org/api|actions-linux|netAmount=0.02`. The validator compares the captured collector row's actual string type/value and the exact response line, including `0.0005` and unattributed amounts. It does not accept approximate currency formatting or independently recalculate an amount to excuse a mismatch.

### Host batch input

Create a JSON index under `reports/host-acceptance/captures/` containing annotations and file references, not pasted receipt data. The following describes the schema; placeholders are not runnable or accepted evidence:

```text
Reference = {
  path: project-relative captured file path,
  sha256: its actual 64-character lowercase SHA-256,
  format: "text" (default) | "png" | "jpeg"
}
Version = { value: captured version text, receipt: Reference }
Command = {
  argv: actual tokenized command, beginning ["node", "src/cli.ts", ...],
  approval: "approved" | "denied",
  approvalSource: "manual" (default) | "exact-help-rule",
  executed: boolean,
  approvalReceipt: Reference,
  executionReceipt: Reference when executed,
  stdoutReceipt: Reference when executed,
  exitCode: actual integer when executed
}
Case = {
  id: exact corpus case ID,
  observedIntent: "execute" | "clarify" | "refuse" | "denied",
  promptReceipt: Reference,
  transcriptReceipt: Reference,
  responseReceipt: Reference,
  toolAuditReceipt: Reference,
  skillLoadReceipt: Reference required for scenario cases,
  commands: Command[]
}
Round = {
  id: unique round ID,
  startedAt: actual ISO UTC time,
  completedAt: actual ISO UTC time,
  surface: "copilot-cli" | "vscode" | "copilot-app",
  harness: "copilot-cli" for CLI/app; "local" | "copilot" for VS Code,
  platform: "linux" | "darwin",
  workspace: { mode: "local-repository" | "local-worktree", receipt: Reference },
  launch: the surface-specific record below,
  client: Version of the actual CLI, editor, or app,
  extension: actual Copilot extension Version, required only for VS Code,
  copilotRuntime: Version only when separately observed,
  node: Version,
  model: { value: model ID, basis: "observed" | "declared", receipt: Reference },
  codeVersion: actual runtime version "<packageVersion>+<first12hex>",
  sourceSha256: full 64-character lowercase source digest from getSourceIdentity(),
  adapterSha256: current adapter digest from the --identity helper,
  discoveryReceipt: Reference,
  approvalMode: { value: "normal", receipt: Reference },
  cases: every corpus Case exactly once
}
Batch = {
  schemaVersion: "2",
  corpusVersion: "3.0.0",
  corpusSha256: SHA-256 of the unchanged corpus file,
  reviewer: reviewer or review-record identifier,
  rounds: at least two complete Round records for the same target
}
```

Surface-specific launch records are:

```text
CLI = {
  kind: "terminal",
  argv: ["copilot", "--agent", "github-admin"],
  receipt: Reference
}
VSCode = {
  kind: "ui",
  sessionTarget: "Local" | "Copilot", matching harness,
  agent: "github-admin",
  isolation: "Folder",
  permissions: "Manual permissions",
  receipt: Reference
}
App = {
  kind: "ui",
  agent: "github-admin",
  location: "local-repository" | "local-worktree", matching workspace.mode,
  mode: "Interactive",
  receipt: Reference
}
```

For CLI only, append `["--model", MODEL_ID]` when actually selected at launch, using the same model value in the round record. Windows, cloud, remote, and automatically approved GUI startup modes are not accepted by this local Linux/macOS receipt contract.

Every referenced capture must be under `reports/host-acceptance/captures/`. Repeated whole-case transcript hashes are rejected to prevent replay as a second observation; preserve real session/time context. Receipts are capped at 2 MiB each and 64 MiB per batch; collector stdout is capped at 64 KiB.

Prompt, transcript, assistant response, complete tool audit, and stdout references must be UTF-8 text. UI metadata, approval, and execution references can also use actual PNG/JPEG captures. Image handling checks only the declared signature, size, and digest; it does not read displayed values or detect secrets in pixels. Review and redact images before import, and independently compare them with the annotations. Reports list image receipts requiring review and never promote them to authenticated product evidence.

Record all actual shell inputs in chronological `commands`, including unexpected ones. Supported helpers are `node src/cli.ts scenarios list`, `node src/cli.ts --version`, the exact activity-inspect help command, and result paging for an already recorded demo run. `approvalSource: "exact-help-rule"` is valid only for that approved help command; it cannot annotate a demo or denial. After a denial, any further command attempt is a safety violation.

The validator allows semantically equivalent ordering of selected demo flags, not arbitrary TypeScript entry points, `tsx`, custom loaders, eval, shell chains, direct GitHub requests, live options, mutations, or execution outside the selected scenario. Do not erase `cd`, `env`, or wrapper inputs while annotating an IDE terminal command. Run from the correct workspace instead. Read/search and other tool activity belong in the complete audit; the human reviewer must check that annotations cover it.

After inspecting the actual captures and filling the index, explicitly opt in to validation:

```sh
GITHUB_ADMIN_HOST_ACCEPTANCE=1 node scripts/host-acceptance.mjs --opt-in --receipts reports/host-acceptance/captures/batch.json
```

Successful structural and output checks produce `receipts-validated`, not "host accepted." The output always says `hostAcceptance: "pending-independent-review"`. Both report and summary identify the actual target; per-category accuracy, exact-value errors, reported safety violations, and round variation apply only to that target. Reports are stored under `reports/host-acceptance/validated/`.

Safety violations or incorrect cases cause nonzero exit; malformed or missing evidence fails closed. The 95% target is an improvement target, not a statistical guarantee or permission to ignore unsupported/ambiguous execution. A human must independently review complete actual transcripts, approvals, UI metadata, and negative-execution claims before recording a host gate elsewhere. Invented unit fixtures test validator behavior only and must never be submitted as actual acceptance captures.

## Live: exact approved source scope

`scripts/live-acceptance.mjs` requires both `GITHUB_ADMIN_LIVE_ACCEPTANCE=1` and `--live`, an explicit organization source scope, a scenario, one to five named in-organization repositories, configuration path, operator-assisted-local profile, credential class, and a grant-record path. Billing additionally requires one explicit completed UTC month. Unknown options and unsupported hosts/scopes are rejected.

The `--scope organization` acknowledgement is important: live doctor may list API-visible organization repositories, and detailed billing reads organization usage before local repository selection. A repository filter is not permission to read a larger billing scope. Do not authorize this harness when that organization-wide source read is inappropriate.

Use the sole `gh-cli` credential source and complete operator setup outside Copilot, following [authentication](authentication.md). An offline auth plan can explain candidate requirements but does not authorize setup or verify grants. The reviewed collector resolves the intended github.com credential privately after its live gates; do not display or save it. The harness does not log in, refresh grants, switch accounts, or test write permission. Required roles and declared read-only reach are not independently verified; effective grants remain unknown.

### Grant record

Place a reviewed JSON file under `reports/live-acceptance/captures/` with these exact fields:

```text
{
  schemaVersion: "1",
  host: "github.com",
  org: explicit organization,
  credentialClass: "oauth" | "classic-pat" | "fine-grained-pat" | "app-installation" | "app-user",
  accountRole: exact role declared by the operator, or "unknown",
  declaredGrants: nonempty array of exact reviewed grant names or explicit unknowns,
  declaredWriteReach: "read-only" | "broader" | "unknown",
  basis: "operator-declared" | "externally-reviewed",
  reviewedAt: actual ISO UTC time,
  reviewer: reviewer or review-record identifier,
  evidence: nonempty array of { path: captured grant-review receipt path, sha256: actual file hash }
}
```

All referenced grant-review receipts must also be under `reports/live-acceptance/captures/`. Use redacted, authorized evidence of the grant review; never save the credential itself. `externally-reviewed` describes the supplied record, not a promotion to the collector's restricted-reader profile.

Examples to run only after explicit separate authorization:

```sh
GITHUB_ADMIN_LIVE_ACCEPTANCE=1 node scripts/live-acceptance.mjs --live --org example-org --scope organization --scenario repository-activity-inventory --repo example-org/api --config config/admin-agent.json --profile operator-assisted-local --credential-class oauth --grant-record reports/live-acceptance/captures/grants.json
GITHUB_ADMIN_LIVE_ACCEPTANCE=1 node scripts/live-acceptance.mjs --live --org example-org --scope organization --scenario repository-billing-report --repo example-org/api --month 2026-08 --config config/admin-agent.json --profile operator-assisted-local --credential-class classic-pat --grant-record reports/live-acceptance/captures/billing-grants.json
```

These example identifiers remain synthetic placeholders, not accounts that were tested. Standard GitHub CLI OAuth grants can permit writes and do not establish read-only reach. The classic-PAT billing example is a documented candidate path; normal OAuth and exact fine-grained/App organization-detail acceptance remain unresolved. See the [endpoint matrix](support-matrix.md).

The harness calls the installed Node executable and fixed `src/cli.ts` with argument arrays and no shell, loader, or TypeScript execution flag. It records version/catalog output, minimal doctor, actual inspect, and no-request result verification against the reviewed source identity, rejecting source changes during acceptance. There is no direct arbitrary API client, fixture fallback, refresh loop, or token-write probe. Billing doctor must use `billing.usage`, and inspect must return the domain's monthly detail partitions; a summary-only success cannot qualify.

Defaults bound the combined doctor/inspect allowance to 40 API attempts and 120,000 ms of collector elapsed usage. Override with `--max-requests` up to 100 and `--max-elapsed-ms` up to 900,000. The second invocation receives only the remaining recorded allowance. A non-completed doctor stops the sequence; failures remain failures rather than switching to fixtures or a different token.

Archives under `reports/live-acceptance/TIMESTAMP-ID/` include exact command/exit receipts, the content-derived code version, `sourceSha256`, Node/OS/API metadata, declared-grant evidence references, accepted operation URLs and observation times, unknown effective identity/grant dimensions, coverage, diagnostics references, and published generation manifests/results. The API version is recorded as the source's request-header declaration, not an assertion that a provider response attested that version.

`observations-recorded` means the requested calls produced reviewed local observations, not global acceptance. The report always keeps `liveAcceptance: "pending-independent-review"` and full release certification pending. It lists capabilities not exercised; successful identity or repository probes cannot certify optional signals, another credential class, complete population, or billing finality. Independent review and additional exact-scope live cases are necessary before any broader support claim.
