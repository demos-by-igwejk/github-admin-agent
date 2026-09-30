# Getting started

## Run a synthetic result from source

Use a full reviewed source checkout outside `node_modules` with Node `^24.0.0 || ^26.0.0`. Node 24 is the baseline; Node 26 is the second declared line. CI targets minimum Node 24.0.0 plus the latest releases of both supported lines; a configured matrix is not an acceptance record.

```sh
npm ci
npm run check
npm run schemas -- --check
node src/cli.ts scenarios list
node src/cli.ts demo --scenario repository-billing-report --month 2026-08
```

Node executes `src/cli.ts` and its erasable TypeScript imports natively, without flags, emitted JavaScript, custom loaders, or `tsx`. There is no build step. Runtime dependencies must be installed in this checkout; it is not a self-contained file that can run without `node_modules`. TypeScript is retained only for the development `tsc --noEmit` gate. `npm run check` combines that gate with native tests, and `npm test` runs the tests directly.

The demo uses a fixed synthetic observation clock of 2026-09-15 and never retrieves a token or contacts GitHub. Its default completed billing month is therefore 2026-08, even if today's month differs. The live default uses the actual last completed UTC month.

Try the other scenarios and failure outcomes without credentials:

```sh
node src/cli.ts demo --scenario repository-activity-inventory --estate beta
node src/cli.ts demo --scenario repository-settings-audit
node src/cli.ts demo --scenario repository-billing-report --outcome partial
node src/cli.ts demo --scenario repository-activity-inventory --outcome deferred
```

`--outcome` accepts `completed`, `partial`, `failed`, `deferred`, or `cancelled`. Non-completed demonstrations intentionally return their corresponding nonzero exit code. Alpha and beta are different synthetic repository sets, not production accounts.

## Select a native Copilot surface

All three clients use `.github/agents/github-admin.agent.md`, the matching `.github/skills/SCENARIO_ID/SKILL.md` files, and `.github/copilot-instructions.md`. No MCP server, custom loader, separate collector, or fixed model is required. The agent discovers the executable catalog before choosing a matching skill. See the [architecture](architecture.md) and [reliability boundaries](reliability.md).

The agent's `read`, `search`, and `execute` aliases are documented by [GitHub](https://docs.github.com/en/copilot/reference/custom-agents-configuration) and as [VS Code tool sets](https://code.visualstudio.com/docs/agents/reference/tools-reference). They advertise available tools, not a shell sandbox or permission to run other collectors. Actual tool availability depends on the selected harness. If required capabilities are missing, stop and correct the supported setup rather than enable all tools or add replacement scripts.

Keep ordinary approvals enabled. The only supplied VS Code auto-approval matches exactly `node src/cli.ts inspect repository-activity-inventory --help`; it approves help, not demos or live collection. No skill grants approvals and no optional hooks are supplied. If an approval is denied, the agent must stop the operation without retrying through another tool.

### GitHub Copilot CLI

Install and sign in to Copilot CLI using its [setup guide](https://docs.github.com/en/copilot/how-tos/copilot-cli). Start it in the reviewed checkout and select the repository agent:

```text
/agent github-admin
/skills list
/instructions
```

Use `/skills info repository-billing-report` to confirm a skill's origin, or `/skills reload` after adding skills. Check that the selected agent is the repository file, because a user-level agent with the same name can override it. Instruction changes may require a new session. See [agent invocation](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents), [skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills), and [instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions).

### Visual Studio Code

Open the reviewed checkout as the workspace. Select the intended **Session Target**, then select **github-admin** in the **Agent** dropdown. Use the Agent Customizations editor to inspect the repository agent, three skills, and instructions.

**Local** uses VS Code's extension-host tools and workspace. **Copilot** uses the shared Copilot runtime on Agent Host; choose **Folder** isolation and **Manual permissions**. Current VS Code documentation states that automatically created **New Worktree** sessions use **Allow all**, so those sessions do not meet this reference's approval-denial procedure. Opening a separately prepared checkout as a folder is distinct from that automatic worktree mode.

For Local, repository instruction discovery requires `github.copilot.chat.codeGeneration.useInstructionFiles` to be enabled. Effective user and managed settings can affect approvals and discovery; inspect them without bypassing policy. See [custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents), [harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses), [instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions), and [approvals](https://code.visualstudio.com/docs/agents/run/approvals). Record Local and Copilot acceptance separately.

### GitHub Copilot app

Use the **GitHub Copilot app**, not GitHub Desktop. [Install and sign in](https://docs.github.com/en/copilot/get-started/quickstart-copilot-app), add the reviewed **Local folder or repository** under **Projects**, and start an **Interactive** session in the local repository or a deliberately prepared local worktree. Do not select a cloud sandbox for this local collector procedure.

Select **github-admin** in the prompt-box agent picker or use `/agent`. Inspect the three repository skills through **Customize > Skills** or `/skills`; use `/skills reload` if necessary. The app is built on Copilot CLI and makes repository/CLI skills available, but actual discovery and approvals still need app-specific receipts. See [customizations](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app) and [session locations](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions).

The app is available on macOS, Linux, and Windows; its Business/Enterprise policy is separate from the CLI policy. This collector still declares only Linux/macOS runtime support. Keep tool auto-approval disabled. A worktree isolates source changes, not credential reach. Optional [local sandboxing](https://docs.github.com/en/copilot/how-tos/github-copilot-app/configure-local-sandboxing) can restrict filesystem, network, and GitHub CLI credentials; a denial must not trigger unsandboxed execution or automatic policy changes.

### First request and acceptance

Ask: "Run a synthetic repository-billing-report demo for 2026-08, preserve the exact decimal strings, and explain missing attribution." Check the selected skill, actual command, scope, status, and limitations. Client file discovery is not proof of routing or approval behavior. [Host acceptance](acceptance.md) requires at least two complete human-captured rounds for each actual surface/harness/platform/version/workspace target; all host gates remain pending until independently reviewed.

## Configuration and precedence

```sh
mkdir -p config/policies
cp config/admin-agent.example.json config/admin-agent.json
cp config/policies/repositories.example.json config/policies/repositories.json
cp examples/owners.example.csv config/owners.csv
node src/cli.ts doctor --config config/admin-agent.json
```

Keep the copied files local and ignored. Replace `example-org` and the example repository mappings only after choosing the intended scope. A missing optional owners file is acceptable; an existing malformed owners file is not silently ignored. Ownership is a label, not authorization or a cost-allocation rule.

| Input                    | Default                             | Override         |
| ------------------------ | ----------------------------------- | ---------------- |
| Configuration            | `config/admin-agent.json`           | `--config PATH`  |
| Settings baseline        | `config/policies/repositories.json` | `--policy PATH`  |
| Optional owners CSV      | `config/owners.csv`                 | `--owners PATH`  |
| Local operational output | `reports`                           | `--reports PATH` |

Paths resolve within the current workspace, not relative to the configuration file. Use project-relative paths. Traversal, symlink escapes, unsupported hosts, unknown keys, duplicate repository targets, and cross-organization targets are rejected. An explicitly named missing configuration fails; omission of the default configuration is allowed only when other inputs provide the required organization, as the built-in demo does.

Schema defaults are filled for omitted fields. Values in the selected configuration replace those defaults; explicit supported CLI options override the corresponding configuration fields. Repeated `--repo` and `--signal` values replace their configured lists rather than append to them. Local `doctor` reports overrides and configuration/runtime metadata without reading the secret or making requests. It is not a full live policy/permission check; required scenario inputs are validated when loading that scenario.

The activity policy can use UTC `calendar-months` or `days`. Six calendar months and `["push"]` are the defaults. The six supported signal names are `push`, `commits`, `issues`, `pull_requests`, `discussions`, and `actions`. Configure string-valued property filters through `selection.properties`; do not invent a `--property` option. `selection.maxAssessments` is an explicit assessment cap, not a pagination or population-completeness claim.

An empty repository list normally requests API-visible discovery. Explicit `selection.mode: "declared-targets"` with an empty list instead represents an intentionally empty declared scope. Nonempty repository selectors request those repositories, not proof of every repository in the organization.

The settings policy requires schema version `"1"`, a name, and uniquely identified rules. Supported settings are `visibility`, `archived`, `default_branch`, `allow_merge_commit`, `allow_squash_merge`, `allow_rebase_merge`, and `delete_branch_on_merge`. Booleans are actual JSON booleans; visibility is `public`, `private`, or `internal`. The example baseline is not a recommended universal policy.

## Deliberate live use

Read the [credential matrix](support-matrix.md) before configuring live access. The default restricted-reader profile blocks because the distribution cannot independently prove no-write effective grants. A successful GET or a declaration in configuration does not change that. If your policy requires a strong read-only host boundary, keep privileged credentials outside Copilot and use operator-managed credential-isolated collection.

The sole credential source is GitHub CLI (`gh-cli`). First inspect an offline authentication plan:

```sh
node src/cli.ts auth-plan repository-activity-inventory --org example-org --repo example-org/api
```

The plan describes candidate grants, role/endpoint limitations, and operator-run setup commands. It does not read a token, contact GitHub, log in, refresh grants, or switch accounts. Have the operator perform any necessary setup outside the agent using the [authentication guide](authentication.md). Never request, display, copy, or bridge a token through chat, configuration, shell arguments, or environment dumps. Copilot sign-in and collector authorization are separate.

For deliberate live use, `gh` and the intended github.com authentication must be available to the actual collector process. A desktop-launched app, VS Code Agent Host, remote environment, or separate worktree may have different PATH, installed dependencies, or credential access from an interactive terminal. Verify the execution environment without printing secrets or weakening sandbox policy. The reviewed collector privately resolves its credential only after the live/profile/class gates.

After explicit scope/profile decisions, use the reviewed source collector with ordinary host approvals:

```sh
node src/cli.ts doctor --config config/admin-agent.json --scenario repository-activity-inventory --live --profile operator-assisted-local --credential-class oauth
node src/cli.ts inspect repository-activity-inventory --config config/admin-agent.json --org example-org --repo example-org/api --live --profile operator-assisted-local --credential-class oauth
node src/cli.ts inspect repository-settings-audit --config config/admin-agent.json --org example-org --repo example-org/api --live --profile operator-assisted-local --credential-class oauth
```

These are invocation examples, not claims that a particular token, role, optional signal, or organization was accepted live. Standard GitHub CLI OAuth grants can include write reach. A declared credential class, offline auth plan, or successful read does not prove effective no-write grants. A local doctor does not establish permission; a live doctor probes identity and a minimal scenario operation, not every optional capability.

Billing uses the documented classic-PAT tutorial path as a candidate, with organization owner/billing-manager access and potentially broader or unknown grants. Confirm the actual exact endpoint rather than assuming fine-grained PAT or App equivalence:

```sh
node src/cli.ts auth-plan repository-billing-report --org example-org --credential-class classic-pat
node src/cli.ts inspect repository-billing-report --config config/admin-agent.json --org example-org --month 2026-08 --live --profile operator-assisted-local --credential-class classic-pat
```

Normal browser-OAuth billing acceptance is not established. The organization detail endpoint reads organization usage before local repository filtering. Obtain approval for that source scope, not just a repository label. Repeat `--month` for at most six distinct completed UTC months. Opt out of current inventory only with an explicit `--no-inventory`; do not interpret missing inventory as historical inactivity. Only in-run inventory composition is supported; there is no CLI option to import inventory from a different run.

## Production-only source checkout

Keep the full reviewed checkout, including `src/`, `package.json`, and `package-lock.json`, outside any `node_modules` directory. In that checkout, runtime-only setup is:

```sh
npm ci --omit=dev --ignore-scripts
node src/cli.ts scenarios list
node src/cli.ts demo --scenario repository-billing-report --month 2026-08
```

The pinned runtime dependencies do not require install scripts, so `--ignore-scripts` is supported, not a native-TypeScript prerequisite. Execution requires neither a compiler nor development dependencies. Development checks, including `npm test`, `npm run typecheck`, and `npm run check`, require the full development install; do not expect them to work after omitting development dependencies.

Native Node prohibits TypeScript stripping beneath `node_modules`. The package remains private and has no package bin or packed-install contract; a global npm install, a copied standalone entry point, or a checkout placed beneath `node_modules` is not supported.

Run the chosen local Copilot surface against that same reviewed checkout. In a new worktree, install the locked dependencies there before invoking the source CLI; ignored configuration and reports are not assumed to be copied. Native adapter presence does not establish discovery, routing, or approvals, and cloud-agent parity is not claimed. Preserve installed dependency notices and review the [source identity and dependency boundary](acceptance.md#source-identity-and-dependency-boundary) before collecting acceptance receipts.
