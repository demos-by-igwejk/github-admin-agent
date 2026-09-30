# Validation and assurance

Validation is divided into reproducible offline checks, per-client Copilot-host evaluation, and separately authorized live API collection. Passing one category does not establish the others or certify a production deployment.

## Offline checks

From a full development checkout outside `node_modules`:

```sh
npm ci
npm run check
npm run schemas -- --check
```

`npm run check` performs `tsc --noEmit` and the native TypeScript test suite. `npm test` is the test-only alternative. No compiled JavaScript or custom loader is required. CLI fixture subprocesses use a network-blocking preload; authentication tests use injected or isolated fake `gh` execution rather than real credentials.

The source-checkout distribution tests exercise locked production dependencies without a compiler or development dependencies and reject TypeScript execution beneath `node_modules`. CI targets Linux/macOS with minimum Node 24.0.0, latest Node 24, and latest Node 26. A configured workflow is not an execution record for every target.

`npm run schemas` generates committed JSON schemas by importing `src/schema-export.ts` directly. The `--check` mode rejects drift from executable definitions. Runtime refinements also enforce semantic invariants that JSON Schema cannot express.

## Regression coverage

| Capability | Concrete offline coverage |
| --- | --- |
| Static scenarios and extension contract | `tests/catalog.test.ts`, `tests/core/runner.test.ts`, `tests/scenarios/settings.test.ts` |
| GitHub CLI authentication | `tests/core/auth.test.ts`, `tests/core/runner.test.ts`, `tests/cli/source.test.ts`: non-secret plans, private bounded token resolution, cancellation, failure redaction, explicit live gates, and credential-free offline commands. |
| Activity policies and incomplete evidence | `tests/scenarios/activity.test.ts`: six signals, UTC policy windows, denied or incomplete reads, empty scopes, positive evidence, and retention limits. |
| Exact billing and attribution | `tests/scenarios/billing.test.ts`, `tests/core/client.test.ts`: decimal strings, signed adjustments, legitimate duplicates, missing currency, partitions, reconciliation, and inventory-failure propagation. |
| API client reliability | `tests/core/client.test.ts`: reviewed reads, safe REST/GraphQL pagination, rate guidance, deadlines, retries, concurrency, cancellation, cache reuse, and response limits. |
| Durable recovery | `tests/core/lineage.test.ts`, `tests/core/runner.test.ts`, `tests/core/source-revision.test.ts`: reservations, locks, stale checkpoints, provider deadlines, cumulative allowances, and source/principal binding. |
| Artifact integrity and bounded views | `tests/core/artifacts.test.ts`, `tests/core/paths.test.ts`: staged generations, previous-good preservation, corruption, contained paths, redaction, export safety, and exact UTF-8 size limits. |
| CLI and source installation | `tests/cli/source.test.ts`, `tests/cli/distribution.test.ts`: synthetic outcomes, unsupported commands/hosts/options, configured inputs, saved views, and production-only source checkouts. |
| Delivery and acceptance tooling | `tests/delivery.test.ts`, `tests/host-acceptance/receipts.test.ts`, `tests/host-acceptance/live.test.ts`: native definitions, configuration examples, receipt binding, source mutation, and explicit opt-in gates. |

Tests exercise implementation contracts, not the absence of every possible defect. Offline fixtures do not establish live principal permissions, optional-field availability, Copilot model behavior, approval enforcement, or performance at a customer's estate size.

## Source identity

`node src/cli.ts --version` exposes a content-derived `codeVersion`: the package version plus a short source digest. The full digest covers the runtime source tree and package manifest/lockfile. Recovery and acceptance reject incompatible source identities; acceptance also checks source mutation during capture or validation.

Installed dependency bytes, native agent/skill files, documentation, and acceptance scripts are outside that digest and require their own review. Host receipts additionally bind the shared native adapters through `adapterSha256` and the intent corpus through `corpusSha256`; the offline `node scripts/host-acceptance.mjs --identity` command reports the current bindings. Locked installation and retained notices remain part of the distribution procedure. See [source identity and dependency boundaries](acceptance.md#source-identity-and-dependency-boundary).

## External evaluation

| Evaluation | Required evidence | What it does not establish |
| --- | --- | --- |
| Copilot host | Actual discovery, scenario routing, normal approvals and denials, complete per-case tool history, and exact-value responses for each selected surface. | Live API permissions or equivalence between CLI, VS Code, and app observations. |
| Live/API contract | Explicit source scope, credential class, grant-review record, identity probe, exact scenario endpoint responses, domain-valid results, and retained diagnostics. | Full estate visibility, absence of write reach, complete retained history, or final invoice amounts. |
| Production deployment | Customer-specific access/data controls, measured performance, operational ownership, acceptance records, and distribution permissions. | An unconditional certification based on reference code alone. |

The [acceptance procedures](acceptance.md) record observations and receipt validation while keeping independent review explicit. Live endpoint/credential acceptance, actual host acceptance for each supported surface, production-scale performance, and pilot outcomes remain unestablished unless separately executed and recorded. Do not label those activities as passed based only on synthetic tests, static files, or hashes.
