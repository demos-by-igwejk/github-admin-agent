import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type {
    Config,
    CredentialProfile,
    JsonObject,
    OperationId,
    ScenarioDefinition,
    Signal,
} from "./contracts.ts";
import { digest } from "./redact.ts";

export const GH_AUTH_TIMEOUT_MS = 10_000;
export const GH_AUTH_MAX_OUTPUT_BYTES = 16 * 1024;
const ghBaselineScopes = ["repo", "read:org", "gist"];
const references = {
    token: "https://cli.github.com/manual/gh_auth_token",
    login: "https://cli.github.com/manual/gh_auth_login",
    refresh: "https://cli.github.com/manual/gh_auth_refresh",
    environment: "https://cli.github.com/manual/gh_help_environment",
    scopes: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps",
    billing: "https://docs.github.com/en/billing/tutorials/automate-usage-reporting",
    discussions:
        "https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions",
};

export interface CredentialRequest {
    host: "github.com";
    signal: AbortSignal;
    timeoutMs: number;
}
export type CredentialResolver = (
    request: CredentialRequest,
) => Promise<string>;

function childEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const name of ["GH_DEBUG", "DEBUG", "GH_FORCE_TTY", "GH_PAGER", "PAGER"])
        delete env[name];
    return {
        ...env,
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
        GH_TELEMETRY: "false",
        GH_SPINNER_DISABLED: "1",
        NO_COLOR: "1",
    };
}

export const resolveGhToken: CredentialResolver = async (request) => {
    if (
        request.host !== "github.com" ||
        !Number.isInteger(request.timeoutMs) ||
        request.timeoutMs < 1 ||
        request.timeoutMs > GH_AUTH_TIMEOUT_MS
    )
        throw new Error(
            "invalid_auth_request: GitHub CLI authentication requires github.com and a timeout from 1 to 10000 ms",
        );
    if (request.signal.aborted)
        throw new Error("operator_cancelled: Authentication was cancelled");
    return new Promise<string>((resolve, reject) => {
        let child: ChildProcessByStdio<null, Readable, Readable>;
        try {
            child = spawn(
                "gh",
                ["auth", "token", "--hostname", request.host],
                {
                    shell: false,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"],
                    env: childEnvironment(),
                },
            );
        } catch {
            reject(
                new Error(
                    "gh_auth_failed: GitHub CLI could not start; check the local installation and environment without displaying credentials",
                ),
            );
            return;
        }
        let settled = false;
        let bytes = 0;
        const chunks: Buffer[] = [];
        const fail = (message: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            request.signal.removeEventListener("abort", cancel);
            child.kill("SIGKILL");
            child.stdout.destroy();
            child.stderr.destroy();
            reject(new Error(message));
        };
        const cancel = () =>
            fail("operator_cancelled: Authentication was cancelled");
        const timer = setTimeout(
            () =>
                fail(
                    "gh_auth_timeout: GitHub CLI did not supply a credential within the bounded authentication preflight; check local credential-store access before an explicit retry",
                ),
            request.timeoutMs,
        );
        const failed =
            "gh_auth_failed: GitHub CLI could not supply a credential; use auth-plan for the selected scenario and complete appropriate authentication outside Copilot";
        child.on("error", (error) => {
            if (
                "code" in error &&
                (error.code === "ENOENT" || error.code === "EACCES")
            )
                fail(
                    "gh_cli_unavailable: Install GitHub CLI and make its gh executable available on PATH for live collection; offline commands do not require it",
                );
            else fail(failed);
        });
        const capture = (chunk: Buffer, stdout: boolean) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > GH_AUTH_MAX_OUTPUT_BYTES) {
                fail(
                    "gh_auth_output_too_large: GitHub CLI exceeded the private authentication output limit; inspect the local gh installation without printing credentials",
                );
                return;
            }
            if (stdout) chunks.push(chunk);
        };
        child.stdout.on("data", (chunk: Buffer) => capture(chunk, true));
        child.stderr.on("data", (chunk: Buffer) => capture(chunk, false));
        child.stdout.on("error", () => fail(failed));
        child.stderr.on("error", () => fail(failed));
        child.once("close", (code) => {
            if (settled) return;
            if (request.signal.aborted) {
                cancel();
                return;
            }
            if (code !== 0) {
                fail(failed);
                return;
            }
            let token: string;
            try {
                token = new TextDecoder("utf-8", { fatal: true })
                    .decode(Buffer.concat(chunks))
                    .replace(/\r?\n$/, "");
            } catch {
                fail(
                    "gh_auth_invalid_output: GitHub CLI returned invalid credential encoding; inspect the local installation without displaying its output",
                );
                return;
            }
            if (token.length === 0 || /[^\x21-\x7e]/.test(token)) {
                fail(
                    "gh_auth_invalid_output: GitHub CLI did not return one nonempty credential line; check the local gh installation without displaying its output",
                );
                return;
            }
            settled = true;
            clearTimeout(timer);
            request.signal.removeEventListener("abort", cancel);
            resolve(token);
        });
        request.signal.addEventListener("abort", cancel, { once: true });
        if (request.signal.aborted) cancel();
    });
};

const signalOperations: Partial<Record<Signal, OperationId>> = {
    commits: "activity.commits",
    issues: "activity.issues",
    pull_requests: "activity.pull-requests",
    discussions: "activity.discussions",
    actions: "activity.actions",
};

export function authorizationPlan(
    config: Config,
    scenario: ScenarioDefinition,
    options: { inventory?: boolean } = {},
): JsonObject {
    const billing = scenario.manifest.capabilities.some(
        (capability) => capability.operation === "billing.usage",
    );
    const declaredClass = config.credential.credentialClass;
    const candidateClass: CredentialProfile["credentialClass"] =
        declaredClass === "none"
            ? billing
                ? "classic-pat"
                : "oauth"
            : declaredClass;
    const operations = new Set<OperationId>();
    if (billing) operations.add("billing.usage");
    if (!billing || options.inventory !== false) {
        operations.add("repositories.get");
        if (
            config.selection.mode !== "declared-targets" &&
            config.selection.repositories.length === 0
        )
            operations.add("repositories.list");
        if (Object.keys(config.selection.properties).length)
            operations.add("repositories.properties");
        if (scenario.manifest.id !== "repository-settings-audit")
            for (const signal of config.activity.signals) {
                const operation = signalOperations[signal];
                if (operation) operations.add(operation);
            }
    }
    const capabilities = scenario.manifest.capabilities.filter((capability) =>
        operations.has(capability.operation),
    );
    const oauthCandidate = candidateClass === "oauth" && !billing;
    const classicCandidate = candidateClass === "classic-pat";
    const login: string[][] = oauthCandidate
        ? [
              [
                  "gh",
                  "auth",
                  "login",
                  "--hostname",
                  config.host,
                  "--web",
                  "--git-protocol",
                  "https",
              ],
          ]
        : classicCandidate
          ? [
                [
                    "gh",
                    "auth",
                    "login",
                    "--hostname",
                    config.host,
                    "--git-protocol",
                    "https",
                    "--with-token",
                ],
            ]
          : [];
    const refresh: string[][] = oauthCandidate
        ? [["gh", "auth", "refresh", "--hostname", config.host]]
        : [];
    return {
        schemaVersion: "1",
        status: "planned",
        scenario: scenario.manifest.id,
        secretRead: false,
        authorizationVerified: false,
        credential: {
            source: config.credential.source,
            declaredClass,
            candidateClass,
            profile: config.credential.name,
        },
        scope: {
            host: config.host,
            org: config.org,
            mode:
                config.selection.repositories.length > 0
                    ? "declared-targets"
                    : (config.selection.mode ?? "api-visible"),
            repositories: config.selection.repositories.slice(0, 25),
            repositoryCount: config.selection.repositories.length,
            repositoryListComplete: config.selection.repositories.length <= 25,
            selectionHash: digest(config.selection),
            sourceReadScope: billing
                ? "Organization usage is read before local repository filtering."
                : "Declared repositories or the API-visible organization population.",
        },
        capabilities: capabilities.map((capability) => ({
            operation: capability.operation,
            resource: capability.resource,
            permissions: capability.permissions,
        })),
        grants: {
            ghLoginMinimumScopes: ghBaselineScopes,
            additionalOAuthScopes: [],
            accountAccess: billing
                ? "Documented classic-PAT candidate: organization owner or billing manager; exact endpoint acceptance remains pending."
                : "Read access to the selected repositories, subject to organization policy, SSO, token approval, and feature availability.",
            billingScopeRecipe: billing ? "not-established" : "not-applicable",
            effectiveGrants: "unverified",
        },
        operatorCommands: { login, refresh },
        references: [
            ...new Set([
                ...Object.values(references).filter(
                    (reference) =>
                        billing || reference !== references.billing,
                ),
                ...capabilities.map((capability) => capability.reference),
            ]),
        ],
        caveats: [
            "This is a local authorization plan, not a login, scope change, permission verification, or live acceptance result. No gh command was executed.",
            "The repository list is a preview of at most 25 configured targets; repositoryCount and selectionHash describe the full selection, not a reduced request scope.",
            "Run authentication commands outside Copilot only after choosing the account and grants. Never print gh auth token output, dump the environment, or put a credential in a prompt, file, or command argument.",
            "GitHub CLI uses GH_TOKEN, then GITHUB_TOKEN, then stored credentials. The source does not prove token class; declare the class based on how the credential was provisioned.",
            "Normal gh browser OAuth and classic-PAT login have a repo, read:org, gist minimum. repo and gist grant write capabilities; these commands cannot create a read-only credential.",
            "Refresh applies to stored OAuth authorization, not to permissions of an environment token or a PAT. Do not use it to silently replace a credential or change its class.",
            "Classic-PAT --with-token imports an existing credential from private stdin; it does not create one or set billing permissions. Fine-grained PATs should use operator-managed GH_TOKEN as recommended by gh; App tokens require external provisioning.",
            ...(billing
                ? [
                      "The billing tutorial documents classic PATs. The exact organization-detail endpoint does not establish an OAuth, fine-grained PAT, or GitHub App scope recipe; these declarations are not verified support. Do not infer organization support from an enterprise endpoint.",
                  ]
                : []),
            "The restricted-reader profile remains blocked for live work. Every live invocation needs --live, --profile operator-assisted-local, and an explicit endpoint-appropriate credential class.",
            "A read succeeds only for the observed scope; it does not prove no-write grants, complete population, or billing finality. Live/API and Copilot-host acceptance remain pending.",
        ],
    };
}
