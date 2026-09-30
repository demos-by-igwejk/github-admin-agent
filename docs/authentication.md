# Authentication and authorization

Live collection requires **GitHub CLI (`gh`) as an external dependency**, available on the collector process's `PATH`. It is not an npm dependency. Use a maintained GitHub CLI release that provides `gh auth token --hostname`, and record the actual `gh --version` during deployment acceptance. The collector supports only `github.com`; it does not fall back to another host or API origin. Catalog, authorization plans, local doctor, synthetic demos, and stored result views require neither `gh` nor a GitHub credential.

Copilot authentication and collector authorization are separate. Copilot CLI, VS Code, and the GitHub Copilot app use the same source collector, but the `gh` account and environment must be available to the process that actually runs it. Do not assume that a VS Code remote environment or another execution host shares a local credential store. See [getting started](getting-started.md) for the host adapters, [architecture](architecture.md) for the execution boundary, and [reliability](reliability.md) for API behavior and acceptance limitations.

## Default configuration

The only supported live credential source is `gh-cli`. A default profile does not retrieve a token or authorize live work:

```json
{
    "name": "restricted-reader",
    "source": "gh-cli",
    "credentialClass": "none"
}
```

`restricted-reader` remains blocked for live execution because this implementation cannot independently establish that a credential has no write reach. The `operator-assisted-local` profile requires `--live` and `--profile operator-assisted-local` on **every** live invocation, including doctor, resume, and refresh. An endpoint-appropriate credential class must also be configured or selected explicitly.

Accepted class declarations are `oauth`, `classic-pat`, `fine-grained-pat`, `app-installation`, and `app-user`. They describe the operator's provisioning choice; they are not verification of token type, permissions, organization role, repository visibility, or endpoint support. `none` is the safe default and cannot execute live reads. A successful read does not change these limitations.

## Plan before authentication

Inspect the candidate grants and operator commands without reading a secret, starting `gh`, contacting GitHub, or changing credentials:

```sh
node src/cli.ts auth-plan repository-activity-inventory --org example-org
node src/cli.ts auth-plan repository-settings-audit --org example-org --credential-class oauth
node src/cli.ts auth-plan repository-billing-report --org example-org --credential-class classic-pat --no-inventory
```

`auth-plan` accepts `--config`, `--org`, `--host github.com`, `--profile`, `--credential-class`, repeatable `--repo` and `--signal`, and billing-only `--no-inventory`. Configuration can supply the organization when `--org` is omitted. It plans potential selected capabilities; positive activity short-circuiting or missing evidence can change the reads actually performed. It does not validate a settings baseline or certify effective grants.

The bounded JSON has `status: "planned"`, `secretRead: false`, and `authorizationVerified: false`. `operatorCommands.login` and `operatorCommands.refresh` contain argument arrays, not executed commands. Empty arrays mean that the selected class/scenario has no recommended login or refresh command in this plan; read its caveats rather than inventing a scope recipe. A large declared selection previews at most 25 repository names with `repositoryCount`, `repositoryListComplete`, and `selectionHash` for the full selection; this display limit does not reduce the requested scope.

## Operator-managed setup

Authenticate and change grants **outside Copilot**, after choosing the intended account and accepting its credential reach. The collector never runs login, refresh, switch, or token-creation commands automatically. Do not print token output, dump the environment, paste credentials into chat, store them in project files, or supply them as command arguments.

For the documentation-reviewed OAuth candidate for activity and settings, the plan presents:

```sh
gh auth login --hostname github.com --web --git-protocol https
gh auth refresh --hostname github.com
```

Normal browser login obtains an OAuth-app user token. GitHub CLI has a minimum `repo`, `read:org`, and `gist` scope set; refresh cannot remove that baseline. `repo` and `gist` include write capabilities, so this is **not a read-only credential recipe**. The current repository read scenarios need no additional OAuth scopes beyond that CLI baseline. Repository Discussions documents `repo` for private repositories and `public_repo` for public repositories; workflow-run reads use `repo` for private repositories. The collector does not request `workflow`, `admin:org`, or an extra discussion scope merely to perform these reads. Actual organization policy, OAuth restrictions, SSO authorization, and feature access can still prevent collection.

GitHub CLI normally stores login credentials in the system credential store, but its documented fallback can write them to a plain-text configuration file when secure storage is unavailable. Check local credential-storage policy before authenticating; this collector does not inspect or certify that store.

For a classic PAT, create and review the endpoint-appropriate token externally. The following command imports an **existing** classic PAT from private stdin; it does not create the token or edit its permissions:

```sh
gh auth login --hostname github.com --git-protocol https --with-token
```

GitHub CLI documents `repo`, `read:org`, and `gist` as the minimum for this import flow. That CLI minimum is not a verified billing-endpoint scope recipe. Use an appropriate protected input mechanism outside Copilot, not a token literal, project token file, or shell-history entry.

GitHub CLI recommends an operator-managed `GH_TOKEN` environment variable for fine-grained PATs rather than `--with-token`. GitHub App user and installation tokens also require external provisioning. The collector still resolves these through `gh`; it does not read a separate administrative token variable or mint tokens. Do not use OAuth refresh to edit a PAT, an App token, or an environment token, or to silently replace its class.

### Billing requires separate endpoint review

The billing tutorial documents a classic-PAT candidate with organization-owner or billing-manager access. The exact `GET /organizations/{org}/settings/billing/usage` reference does not establish a complete OAuth, fine-grained PAT, or GitHub App scope recipe. Ordinary `gh` browser OAuth is **not verified billing support**, and enterprise-endpoint support does not establish organization-detail support. The plan does not propose speculative administrative scopes or refresh commands for those unverified billing classes.

The organization usage endpoint reads organization-wide source data before local repository filtering. A `--repo` selector does not narrow authorization for that source read. Review the [support matrix](support-matrix.md) and use the [opt-in acceptance procedure](acceptance.md) before claiming exact endpoint, role, or token-class support. Live/API and actual Copilot-host acceptance remain pending.

## Which credential is used

For `github.com`, GitHub CLI uses `GH_TOKEN`, then `GITHUB_TOKEN`, then stored credentials. The collector preserves that precedence. Therefore, a successful browser login does not prove that the next collector invocation uses that browser credential when an environment token is present. Do not clear those variables automatically to force a different account.

Declare the class based on how the **effective** credential was provisioned, not its variable name or prefix. Optional `credential.declaredPrincipal` provides a login expectation checked against `GET /user`; live resume and refresh must reverify the same user principal. An installation-token repository probe does not establish its principal, so unverified live installation identity cannot be reused for recovery.

Once the operator has selected the account and grants, live invocation remains explicit:

```sh
node src/cli.ts inspect repository-activity-inventory --org example-org --repo example-org/api --live --profile operator-assisted-local --credential-class oauth
```

This is an invocation example, not a live-tested permission claim. Normal host command approvals still apply. Only the reviewed collector operations are read-only; a shell-capable host holding broader credentials is not a credential sandbox.

## Private authentication preflight

After validating the request and live/profile/class gates, the collector privately invokes `gh auth token --hostname github.com` **once per live invocation**. It uses an argument array with no shell and ignored stdin. The deadline is the smaller of **10,000 ms** and the configured `budgets.maxElapsedMs`; stdout and stderr together are limited to **16,384 bytes**. Timeout, cancellation, or excess output forces the child to stop and closes its output streams.

Only one nonempty printable-ASCII credential line, optionally followed by the CLI's newline, is accepted after strict UTF-8 decoding. The class is not inferred from that line. The token stays in collector memory for the identity and scenario requests; it is not returned, written to configuration, or included in artifacts. Subprocess stdout, stderr, and raw errors are never surfaced. `GH_DEBUG`, `DEBUG`, forced-TTY and pager settings are removed from the child environment; prompts, telemetry, and update notifications are disabled without changing token precedence.

This preflight precedes run creation, so it is separately bounded and is not charged as an API attempt or root-lineage elapsed usage. A preflight failure creates no run to resume and returns a bounded error JSON. Cancellation during preflight returns `status: "cancelled"` and exit code `130`. API collection and recovery retain their existing cumulative allowance and provider-deadline rules.

## Migration and diagnosis

`credential.tokenEnv` and `--token-env` are rejected with `legacy_credential_source`; `GITHUB_ADMIN_TOKEN` is no longer a collector source. Remove the legacy setting, set `credential.source` to `gh-cli`, review the intended effective account and class, and start a new explicitly authorized live request. There is no environment-source fallback or automatic account/scope migration.

Source and configuration changes can make an earlier recovery lineage incompatible. Preserve its observations instead of rewriting checkpoints. Existing published generations can still be read through `result RUN_ID --reports PATH` without a credential or a legacy configuration lookup.

| Reason | Response |
|---|---|
| `gh_cli_unavailable` | Install a supported GitHub CLI release or correct its executable permissions and `PATH` in the collector's execution environment. Offline commands remain available. |
| `gh_auth_failed` | Review the selected scenario's authorization plan and correct account, environment-token, or credential-store setup privately. Never display the token command's output or switch credentials automatically. |
| `gh_auth_timeout` | Check local credential-store responsiveness and the configured elapsed bound before an explicit retry. |
| `gh_auth_output_too_large` | Inspect the local `gh` installation and debug configuration without exposing captured output. |
| `gh_auth_invalid_output` | Check the local `gh` installation; an empty, multiline, malformed, or incorrectly encoded result is not accepted as a token. |
| `operator_cancelled` | Authentication stopped without collection. A new attempt still needs its explicit live/profile decision. |

See [troubleshooting](troubleshooting.md) for identity, policy, path, API, and recovery errors.

## Public references

- [GitHub CLI authentication token](https://cli.github.com/manual/gh_auth_token)
- [GitHub CLI login](https://cli.github.com/manual/gh_auth_login)
- [GitHub CLI refresh](https://cli.github.com/manual/gh_auth_refresh)
- [GitHub CLI environment and token precedence](https://cli.github.com/manual/gh_help_environment)
- [OAuth scopes and their reach](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [GraphQL Discussions authorization](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions)
- [Workflow-run read authorization](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository)
- [Billing automation tutorial](https://docs.github.com/en/billing/tutorials/automate-usage-reporting)
- [Exact organization billing-detail endpoint](https://docs.github.com/en/rest/billing/usage#get-billing-usage-report-for-an-organization)
