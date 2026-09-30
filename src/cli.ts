import { parseArgs } from "node:util";
import { z } from "zod";
import {
    CODE_VERSION,
    SUMMARY_BYTES,
    configSchema,
    type Config,
    type JsonObject,
    type JsonValue,
    type ResultEnvelope,
} from "./core/contracts.ts";
import {
    configuredReportsPath,
    loadConfiguration,
    loadScenarioInputs,
    type ConfigOverrides,
} from "./core/config.ts";
import { executeScenario, safeError } from "./core/runner.ts";
import { authorizationPlan } from "./core/auth.ts";
import { buildView, readResult } from "./core/artifacts.ts";
import { readRun } from "./core/lineage.ts";
import { declaredIdentity } from "./core/envelope.ts";
import { systemClock, lastCompletedMonth } from "./core/time.ts";
import { getScenario, scenarios } from "./scenarios/index.ts";
import {
    createFixtureTransport,
    DEMO_TIME,
    type DemoOutcome,
} from "./fixtures/transport.ts";

const help = `github-admin ${CODE_VERSION} - read-only GitHub administration

github-admin scenarios list
github-admin auth-plan <id> --org <org> [--config config/admin-agent.json]
github-admin doctor [--config config/admin-agent.json]
github-admin demo --scenario <id> [--outcome completed|partial|failed|deferred|cancelled]
github-admin inspect <id> --org <org> --live --profile operator-assisted-local
github-admin resume <run-id> [--sequence N] --live --profile operator-assisted-local
github-admin refresh <run-id> --fresh --live --profile operator-assisted-local
github-admin result <run-id> [--view summary|rows] [--repository owner/name] [--sku SKU] [--reason CODE] [--cursor CURSOR]

Paths: --config, --policy, --owners, --reports (contained in the current workspace).
Scope: --org, --host github.com, --repo owner/name (repeatable), --signal NAME (repeatable).
Billing: --month YYYY-MM (repeatable, at most six completed UTC months), --no-inventory.
Credentials: source gh-cli; --credential-class oauth|classic-pat|fine-grained-pat|app-installation|app-user.
Budgets: --max-requests N, --max-elapsed-ms N; resume/refresh may add --additional-requests N or --additional-elapsed-ms N with --allowance-reason TEXT.
Live doctor requires --live --scenario <id> and an explicit operator-assisted profile.
Auth-plan/catalog/local doctor/demo/result never retrieve credentials. Live collection requires external GitHub CLI (gh).
Output prefers four-space JSON and falls back to compact JSON when needed to stay within 64 KiB.
Mutation/apply, enterprise, GHE.com and GHES are unsupported.
`;

function print(value: unknown): void {
    let serialized = JSON.stringify(value, null, 4);
    if (Buffer.byteLength(serialized) > SUMMARY_BYTES)
        serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > SUMMARY_BYTES)
        throw new Error(
            "model_view_too_large: The response exceeds 64 KiB; use a bounded result page",
        );
    process.stdout.write(serialized);
}
function integer(value: string | undefined, name: string): number | undefined {
    if (value === undefined) return undefined;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error(`invalid_option: ${name} must be a positive integer`);
    return Number(value);
}
function failure(error: unknown): void {
    const message = safeError(error);
    const match = /^([a-z][a-z0-9_]*):/.exec(message);
    const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
            ? error.code
            : undefined;
    const reason =
        match?.[1] ??
        (code === "ENOENT"
            ? "missing_local_artifact"
            : code?.startsWith("ERR_PARSE_ARGS")
              ? "invalid_option"
              : "execution_error");
    const cancelled = reason === "operator_cancelled";
    const exitCode = cancelled ? 130 : 1;
    print({
        schemaVersion: "1",
        status: cancelled ? "cancelled" : "failed",
        exitCode,
        reasons: [reason],
        message,
    });
    process.stderr.write(`${message}\n`);
    process.exitCode = exitCode;
}
const optionDefinitions = {
    help: { type: "boolean" },
    version: { type: "boolean" },
    live: { type: "boolean" },
    fresh: { type: "boolean" },
    "no-inventory": { type: "boolean" },
    config: { type: "string" },
    org: { type: "string" },
    host: { type: "string" },
    profile: { type: "string" },
    "credential-class": { type: "string" },
    "token-env": { type: "string" },
    reports: { type: "string" },
    policy: { type: "string" },
    owners: { type: "string" },
    scenario: { type: "string" },
    outcome: { type: "string" },
    estate: { type: "string" },
    repo: { type: "string", multiple: true },
    signal: { type: "string", multiple: true },
    month: { type: "string", multiple: true },
    "max-requests": { type: "string" },
    "max-elapsed-ms": { type: "string" },
    sequence: { type: "string" },
    "additional-requests": { type: "string" },
    "additional-elapsed-ms": { type: "string" },
    "allowance-reason": { type: "string" },
    view: { type: "string" },
    repository: { type: "string" },
    sku: { type: "string" },
    reason: { type: "string" },
    cursor: { type: "string" },
    limit: { type: "string" },
    generation: { type: "string" },
} as const;

export async function main(
    argv: string[] = process.argv.slice(2),
): Promise<void> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: optionDefinitions,
        allowPositionals: true,
        strict: true,
    });
    if (values["token-env"] !== undefined)
        throw new Error(
            "legacy_credential_source: --token-env is no longer supported; use credential.source gh-cli and provision the intended gh credential outside Copilot before a new live request",
        );
    if (values.help || argv.length === 0) {
        process.stdout.write(help);
        return;
    }
    if (values.version) {
        process.stdout.write(`${CODE_VERSION}\n`);
        return;
    }
    const [command, target, extra] = positionals;
    if (extra)
        throw new Error("invalid_command: Too many positional arguments");
    if (
        ![
            "scenarios",
            "auth-plan",
            "doctor",
            "demo",
            "inspect",
            "resume",
            "refresh",
            "result",
        ].includes(command ?? "")
    )
        throw new Error(
            "unsupported_operation: Only catalog, auth-plan, doctor, demo, read-only inspect, resume, refresh, and result are implemented; no GitHub mutation was attempted",
        );
    const configurationOptions = [
        "config",
        "org",
        "host",
        "profile",
        "credential-class",
        "reports",
        "policy",
        "owners",
        "repo",
        "signal",
        "max-requests",
        "max-elapsed-ms",
    ];
    const allowedOptions: Record<string, string[]> = {
        scenarios: [],
        "auth-plan": [
            "config",
            "org",
            "host",
            "profile",
            "credential-class",
            "repo",
            "signal",
            "no-inventory",
        ],
        doctor: [
            ...configurationOptions,
            "scenario",
            "live",
            "month",
            "no-inventory",
        ],
        demo: [
            ...configurationOptions,
            "scenario",
            "outcome",
            "estate",
            "month",
            "no-inventory",
        ],
        inspect: [...configurationOptions, "live", "month", "no-inventory"],
        resume: [
            "config",
            "reports",
            "live",
            "profile",
            "sequence",
            "additional-requests",
            "additional-elapsed-ms",
            "allowance-reason",
        ],
        refresh: [
            "config",
            "reports",
            "live",
            "profile",
            "sequence",
            "additional-requests",
            "additional-elapsed-ms",
            "allowance-reason",
            "fresh",
        ],
        result: [
            "config",
            "reports",
            "view",
            "repository",
            "sku",
            "reason",
            "cursor",
            "limit",
            "generation",
        ],
    };
    for (const option of Object.keys(values))
        if (!allowedOptions[command!]!.includes(option))
            throw new Error(
                `invalid_option: --${option} does not apply to ${command}`,
            );
    if (command === "scenarios") {
        if (target !== "list")
            throw new Error("invalid_command: Use scenarios list");
        print(
            scenarios.map((scenario) => ({
                ...scenario.manifest,
                inputSchema: z.toJSONSchema(scenario.inputSchema),
            })),
        );
        return;
    }
    const root = process.cwd();
    if (command === "auth-plan") {
        if (!target)
            throw new Error(
                "scenario_required: Use auth-plan SCENARIO_ID --org ORG",
            );
        const scenario = getScenario(target);
        if (
            values["no-inventory"] &&
            scenario.manifest.id !== "repository-billing-report"
        )
            throw new Error(
                "invalid_option: --no-inventory is only meaningful for billing",
            );
        const { config } = await loadConfiguration(root, values.config, {
            org: values.org,
            host: values.host,
            profile: values.profile,
            credentialClass: values["credential-class"],
            repositories: values.repo,
            signals: values.signal,
        });
        print(
            authorizationPlan(config, scenario, {
                inventory: !values["no-inventory"],
            }),
        );
        return;
    }
    if (command === "result") {
        if (!target) throw new Error("run_id_required: Use result <run-id>");
        if (values.live || values.fresh)
            throw new Error(
                "conflicting_options: Result views never recollect or access GitHub",
            );
        const reportsPath = await configuredReportsPath(
            root,
            values.config,
            values.reports,
        );
        const envelope = await readResult(
            root,
            reportsPath,
            target,
            values.generation,
        );
        const scenario = getScenario(envelope.scenario);
        const limit = integer(values.limit, "--limit");
        if (limit !== undefined && limit > scenario.manifest.views.maxRows)
            throw new Error(
                "view_limit_exceeded: The requested page exceeds the scenario row budget",
            );
        for (const filter of ["repository", "sku", "reason"] as const)
            if (
                values[filter] !== undefined &&
                !scenario.manifest.views.filters.includes(filter)
            )
                throw new Error(
                    `unsupported_filter: ${filter} is not supported by this scenario view`,
                );
        print(
            buildView(
                envelope,
                {
                    view:
                        values.view === undefined
                            ? "summary"
                            : z.enum(["summary", "rows"]).parse(values.view),
                    repository: values.repository,
                    sku: values.sku,
                    reason: values.reason,
                    cursor: values.cursor,
                    limit,
                },
                scenario.manifest.views.defaultRows,
            ),
        );
        return;
    }
    const abort = new AbortController();
    const onInterrupt = () => abort.abort(new Error("operator_cancelled"));
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    try {
        let envelope: ResultEnvelope;
        if (command === "resume" || command === "refresh") {
            if (!target)
                throw new Error(
                    "run_id_required: Resume and refresh need a run ID",
                );
            if (command === "refresh" && !values.fresh)
                throw new Error(
                    "fresh_collection_decision_required: Refresh requires --fresh and retains the root cumulative allowance",
                );
            if (command === "resume" && values.fresh)
                throw new Error(
                    "conflicting_options: Resume does not create fresh observations; use refresh --fresh",
                );
            if (
                values.month ||
                values.repo ||
                values.signal ||
                values.org ||
                values.host ||
                values.policy ||
                values.owners ||
                values["no-inventory"] ||
                values["max-requests"] ||
                values["max-elapsed-ms"]
            )
                throw new Error(
                    "incompatible_resume: Scope and policy overrides require a new explicitly scoped request; resume preserves the stored configuration",
                );
            const reportsPath = await configuredReportsPath(
                root,
                values.config,
                values.reports,
            );
            const stored = await readRun(root, reportsPath, target);
            const scenario = getScenario(stored.binding.scenario);
            const config = values.config
                ? (await loadConfiguration(root, values.config)).config
                : stored.config;
            const inputs = stored.binding.synthetic
                ? stored.inputs
                : await loadScenarioInputs(root, config, scenario);
            const additionalAttempts = integer(
                values["additional-requests"],
                "--additional-requests",
            );
            const additionalElapsedMs = integer(
                values["additional-elapsed-ms"],
                "--additional-elapsed-ms",
            );
            if (
                (additionalAttempts || additionalElapsedMs) &&
                !values["allowance-reason"]?.trim()
            )
                throw new Error(
                    "allowance_decision_required: Additional allowance requires a recorded --allowance-reason",
                );
            if (
                values["allowance-reason"] &&
                !additionalAttempts &&
                !additionalElapsedMs
            )
                throw new Error(
                    "invalid_allowance: A reason requires an explicit additional allowance",
                );
            const clock = systemClock;
            const months = Array.isArray(stored.input.months)
                ? stored.input.months
                : [];
            envelope = await executeScenario({
                root,
                config,
                scenario,
                input: stored.input,
                inputs,
                synthetic: stored.binding.synthetic,
                live: values.live,
                explicitProfile: values.profile,
                mode: command,
                runId: target,
                expectedSequence: integer(values.sequence, "--sequence"),
                ...(stored.binding.synthetic
                    ? {
                          transport: createFixtureTransport({
                              org: config.org,
                              month:
                                  typeof months[0] === "string"
                                      ? months[0]
                                      : lastCompletedMonth(clock.now()),
                              outcome: "completed",
                          }),
                      }
                    : { expectedIdentity: stored.identity }),
                clock,
                signal: abort.signal,
                ...(additionalAttempts || additionalElapsedMs
                    ? {
                          allowance: {
                              additionalAttempts,
                              additionalElapsedMs,
                              reason: values["allowance-reason"]!,
                          },
                      }
                    : {}),
            });
        } else {
            if (command !== "inspect" && target)
                throw new Error(
                    "invalid_command: This command accepts its scenario through --scenario",
                );
            if (command === "inspect" && !values.live)
                throw new Error(
                    "live_authorization_required: Inspect requires --live; use demo for synthetic evidence",
                );
            if (command === "demo" && values.live)
                throw new Error(
                    "conflicting_options: Demo never allows live collection",
                );
            if (
                values.fresh ||
                values["additional-requests"] ||
                values["additional-elapsed-ms"] ||
                values["allowance-reason"] ||
                values.sequence
            )
                throw new Error(
                    "invalid_option: Recovery options only apply to resume or refresh",
                );
            const synthetic = command === "demo";
            const outcome = z
                .enum([
                    "completed",
                    "partial",
                    "failed",
                    "deferred",
                    "cancelled",
                ])
                .parse(values.outcome ?? "completed") as DemoOutcome;
            if (!synthetic && (values.outcome || values.estate))
                throw new Error(
                    "invalid_option: Outcome and estate are synthetic demo options only",
                );
            const overrides: ConfigOverrides = {
                org:
                    values.org ??
                    (synthetic && !values.config ? "example-org" : undefined),
                host: values.host,
                profile: values.profile,
                credentialClass: values["credential-class"],
                policyPath: values.policy,
                ownersPath: values.owners,
                reportsPath: values.reports,
                repositories: values.repo,
                signals: values.signal,
                maxAttempts: integer(values["max-requests"], "--max-requests"),
                maxElapsedMs: integer(
                    values["max-elapsed-ms"],
                    "--max-elapsed-ms",
                ),
            };
            const loaded = await loadConfiguration(
                root,
                values.config,
                overrides,
            );
            let config: Config = loaded.config;
            const scenarioId = command === "inspect" ? target : values.scenario;
            if (command === "doctor" && !values.live) {
                for (const candidate of values.scenario
                    ? [getScenario(values.scenario)]
                    : scenarios) {
                    candidate.inputSchema.parse(
                        candidate.manifest.id === "repository-billing-report"
                            ? {
                                  months: values.month ?? [
                                      lastCompletedMonth(systemClock.now()),
                                  ],
                              }
                            : {},
                    );
                    if (values.scenario)
                        await loadScenarioInputs(root, config, candidate);
                }
                print({
                    schemaVersion: "1",
                    status: "completed",
                    codeVersion: CODE_VERSION,
                    runtime: process.version,
                    runtimeSupported: /^(24|26)\./.test(process.versions.node),
                    host: config.host,
                    org: config.org,
                    identity: declaredIdentity(config, false),
                    budgets: config.budgets,
                    paths: {
                        reports: config.reportsPath,
                        policy: config.policyPath,
                        owners: config.ownersPath,
                    },
                    overrides: loaded.overrides,
                    scenarios: scenarios.map((item) => ({
                        id: item.manifest.id,
                        status: item.manifest.status,
                    })),
                    limitations: [
                        "No secret was read and no API request was made.",
                        "Actual live endpoint and Copilot-host acceptance remain separate opt-in release gates.",
                        "The runner is read-only; shell access and unknown or broader credential grants are not sandboxed.",
                    ],
                });
                return;
            }
            if (!scenarioId)
                throw new Error(
                    "scenario_required: Select a supported scenario from scenarios list",
                );
            const scenario = getScenario(scenarioId);
            if (synthetic && outcome === "partial" && !values.signal)
                config = configSchema.parse({
                    ...config,
                    activity: {
                        ...config.activity,
                        signals: ["push", "issues"],
                    },
                });
            const clock = synthetic
                ? { ...systemClock, now: () => new Date(DEMO_TIME) }
                : systemClock;
            const input: JsonObject = {};
            if (scenarioId === "repository-billing-report")
                input.months = values.month ?? [
                    lastCompletedMonth(clock.now()),
                ];
            else if (values.month || values["no-inventory"])
                throw new Error(
                    "invalid_option: Billing options cannot be supplied to another scenario",
                );
            if (values["no-inventory"]) input.inventory = false;
            let inputs: Record<string, JsonValue>;
            if (
                synthetic &&
                scenarioId === "repository-settings-audit" &&
                !values.policy &&
                !values.config
            ) {
                inputs = {
                    policy: {
                        schemaVersion: "1",
                        name: "synthetic-baseline",
                        rules: [
                            {
                                id: "private-visibility",
                                setting: "visibility",
                                expected: "private",
                            },
                            {
                                id: "default-branch",
                                setting: "default_branch",
                                expected: "main",
                            },
                            {
                                id: "delete-merged-branches",
                                setting: "delete_branch_on_merge",
                                expected: true,
                            },
                        ],
                    },
                };
            } else inputs = await loadScenarioInputs(root, config, scenario);
            if (synthetic && outcome === "cancelled")
                abort.abort(new Error("operator_cancelled"));
            envelope = await executeScenario({
                root,
                config,
                scenario,
                input,
                inputs,
                synthetic,
                live: values.live,
                explicitProfile: values.profile,
                ...(synthetic
                    ? {
                          transport: createFixtureTransport({
                              org: config.org,
                              month:
                                  values.month?.[0] ??
                                  lastCompletedMonth(clock.now()),
                              outcome,
                              estate: z
                                  .enum(["alpha", "beta"])
                                  .parse(values.estate ?? "alpha"),
                          }),
                      }
                    : {}),
                clock,
                signal: abort.signal,
                probeOnly: command === "doctor",
            });
        }
        print(
            buildView(
                envelope,
                undefined,
                getScenario(envelope.scenario).manifest.views.defaultRows,
            ),
        );
        process.exitCode = envelope.exitCode;
    } finally {
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onInterrupt);
    }
}

await main().catch(failure);
