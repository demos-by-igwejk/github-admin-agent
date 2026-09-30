# Distribution and licensing

## Source distribution

The supported runtime is a full source checkout outside `node_modules`, on Node `^24.0.0` or `^26.0.0`, with its locked runtime dependencies installed. The entry point is `node src/cli.ts`. There is no package bin, packed npm installation, standalone bundle, or compilation step. GitHub CLI is a separately installed prerequisite for live authentication; it is not bundled with this project.

The package is `private: true` and `UNLICENSED`. These fields prevent accidental npm publication and do not grant a redistribution or reuse license. Confirm applicable permissions before sharing the source or dependencies. This documentation does not establish third-party rights or provide legal clearance.

## Dependency notices

Runtime dependencies are pinned in `package.json` and `package-lock.json`:

| Dependency | Version | License |
| --- | --- | --- |
| `lossless-json` | 4.3.1 | MIT |
| `zod` | 4.6.5 | MIT |

Their copyright and permission notices remain in the installed dependency distributions under `node_modules` and are reproduced in [third-party notices](third-party-notices.md). Preserve those files with any permitted dependency redistribution. Dependency licenses apply independently of this project's license status.

TypeScript and Node type definitions are development dependencies; TypeScript is used for the no-emit typecheck, not runtime compilation. Node, GitHub CLI, and Copilot clients are external tools with their own distribution terms. A lockfile or source hash is not a license grant.

## Source identity and integrity

`getSourceIdentity()` computes `sourceSha256` over the sorted runtime source tree, `package.json`, and `package-lock.json`, anchored to the source checkout. Its `codeVersion` is `<packageVersion>+<first12hex>`, captured by the CLI at startup. Recovery and acceptance bind results to this source identity.

The digest detects changes to those source inputs; it does not hash installed dependency bytes, native adapter files, acceptance scripts, or documentation. Dependency integrity relies on the locked npm installation. Hashes provide consistency checks, not immutable execution, authenticity, or provider completeness. See [acceptance](acceptance.md#source-identity-and-dependency-boundary) for the precise evidence boundary.

Host acceptance separately binds `adapterSha256` for the shared agent, skills, repository instructions, and VS Code settings, plus `corpusSha256` for the intent corpus. `node scripts/host-acceptance.mjs --identity` reports these non-secret bindings without contacting GitHub or retrieving a token.

## Customer-safe sharing

Share only authorized source, synthetic examples, documentation, and retained dependency notices. Keep operational reports, acceptance captures, real repository/owner mappings, local policies/configuration, environment files, credentials, and private state out of the distributed checkout. The default paths are ignored by Git; custom output paths require equivalent controls.

Removing a sensitive file from the current checkout does not remove it from Git history. Before distributing repository history, review that history and any external attachments under your organization's data-handling policy. No live data or credential is necessary to demonstrate this implementation.

Reference deployment, live endpoint acceptance, and Copilot-host acceptance are separate decisions. Offline tests and generated digests do not certify a production deployment.
