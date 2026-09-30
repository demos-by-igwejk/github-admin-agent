# Authoring a scenario

The extension seam is a reviewed `ScenarioDefinition`, not a dynamic plugin loader or arbitrary script name. The current reference extension is `repository-settings-audit`; the non-repository conformance example lives in the source checkout's `tests/core/runner.test.ts` and is deliberately absent from the shipped catalog.

## Read the executable contract

Start with `src/core/contracts.ts`, `src/core/runner.ts`, `src/scenarios/index.ts`, and the smallest relevant handler. Use `node src/cli.ts scenarios list` to inspect the advertised catalog. The source CLI and executable schemas define supported commands, options, and extension contracts.

Runtime and test code must use native, unflagged erasable TypeScript on Node `^24.0.0 || ^26.0.0`. Use explicit `.ts` extensions for local TypeScript imports and type-only imports for types. Node does not use `tsconfig.json` to transform execution: do not introduce syntax requiring transformation, compiler path aliases, `tsx`, or custom loaders. TypeScript remains only the development `tsc --noEmit` gate, not a runtime dependency.

| Surface             | Contributor responsibility                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest            | Stable ID/version, maturity, title/description/intent examples, risk, modes, hosts, exact capabilities and public references, inputs, artifacts, views, limitations, recovery, skill, and fixtures. |
| Input schema        | Strict validation of supported inputs; reject unknown or contradictory fields. Do not admit module paths, URLs, arbitrary GraphQL, credentials, or executable strings.                              |
| Result schema       | Validate domain rows, totals, work units, coverage, and limitations; enforce domain consistency, not just field presence.                                                                           |
| Handler             | Consume validated input and `ScenarioContext`, call only the reviewed client, and return a schema-valid `ScenarioResult`.                                                                           |
| Static registration | Add the reviewed import/entry in `src/scenarios/index.ts`; do not alter the runner dispatch algorithm or another scenario's business logic.                                                         |
| Native skill        | Matching `.github/skills/ID/SKILL.md`, with the exact reviewed `node src/cli.ts` invocation, scope clarification, bounded results, permissions, and limitations across CLI, VS Code, and app sessions. |
| Fixtures            | Success plus source, scope, permission, continuation, budget, temporal, and uncertainty failures appropriate to the scenario.                                                                       |

The context supplies `client`, `config`, `clock`, cancellation `signal`, run/root identities, budget access, validated inputs, evidence, diagnostics, and evidence/diagnostic appenders. Use `context.client.collect(OPERATION_ID, scopedArguments)`; do not import a transport, read a secret, call `fetch`, or start a shell process in a handler.

Use shared collection work, discovery, time, and exact-decimal helpers when applicable. A non-repository scenario does not need repository selectors or financial fields: the conformance fixture returns runner rows with stable identities and `not-applicable` discovery. Do not add that fixture to the product catalog or expose its test operation live.

## Preserve framework responsibilities

The shared runner owns preflight, private `gh` token resolution, execution status, allowance and lineage, identity revalidation, and publication. The restricted adapter owns operation/host/scope validation, pagination, source-response checks, retries, and shared concurrency. Artifact services own immutable generations, hashes, redaction, exports, and bounded views. Reuse these rather than copying request loops, authentication, or publication code. Declare authorization guidance through the shared `auth-plan` path; a handler must not request additional scopes or select another credential after a denial.

A handler returns required logical work with `valid`, `failed`, `unassessed`, `policy-excluded`, `waiting`, or `cancelled` outcomes. Do not label denied required evidence as a policy exclusion to force completion. Preserve usable observations when other work fails and attach actionable diagnostics and evidence IDs.

The result envelope's assurance is assembled by the runner. A scenario cannot set population to verified or finality to final, and synthetic fixtures, declared operator labels, or digests do not authorize such promotion. Keep current observations separate from historical business periods.

Existing input loaders support reviewed policy and owners inputs. Adding a new input type requires an explicit typed loader review, containment checks, and tests; manifest paths are not arbitrary executable loaders. Declare sensitive inputs correctly and distribute only synthetic examples.

New API operations need reviewed semantics, exact endpoint and credential evidence, scope-preserving continuation rules, bounded timeout/retry behavior, redaction, and production-shaped offline fixtures. A mutation cannot be added by calling POST: GraphQL POST is admitted only for the existing reviewed read queries. Write scenarios require a separate design and are not part of the implemented extension contract.

## Views and diagnostics

Give rows stable IDs and deterministic ordering with a tie-breaker. Preserve requested selection priority, all-source totals, exact financial strings when relevant, and references for abbreviated fields. The model-facing JSON must remain at or below 64 KiB. Do not make the default row budget a cap on retained findings.

The current CLI exposes `summary` and `rows`, exact repository/SKU/reason filters, `--limit`, `--generation`, and opaque cursors. Declaring another filter in a manifest does not automatically implement a CLI option. Wire and test any intentionally expanded interface across artifacts, CLI, skills, docs, and acceptance before advertising it.

## Validate and advertise honestly

```sh
npm run check
npm run schemas -- --check
```

These checks require the full development install in a source checkout outside `node_modules`; `npm run check` already includes the native tests, and `npm test` is the direct test-only alternative. Add targeted tests through the existing runner rather than a second test framework. Network-blocked fixtures must not retrieve credentials or quietly fall back from live requests. Test authentication through an injected resolver or isolated fake `gh`; blocking Node networking alone does not prevent an external process from accessing credentials. CLI tests must use `node src/cli.ts` with the checkout's installed dependencies, not emitted JavaScript or a packed npm installation.

`npm run schemas` writes JSON by directly importing `src/schema-export.ts`; its `--check` mode verifies those generated artifacts without a temporary compiled module. Generated schemas are data, not TypeScript-to-JavaScript compilation or a runtime build step.

`tests/delivery.test.ts` checks static delivery consistency only. It cannot establish discovery, native skill loading, ordinary approvals, exact model output, or live endpoint permissions. Update the host corpus and endpoint matrix for relevant changes, then execute the separately authorized [acceptance procedures](acceptance.md) before claiming those gates. Mark proposed or experimental work honestly; do not list a documentation-only scenario as implemented.
