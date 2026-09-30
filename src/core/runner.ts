import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    CODE_VERSION,
    SCHEMA_VERSION,
    configSchema,
    diagnosticSchema,
    jsonObjectSchema,
    jsonValueSchema,
    scenarioResultSchema,
    type Clock,
    type Collection,
    type Config,
    type Diagnostic,
    type Evidence,
    type Identity,
    type JsonObject,
    type JsonValue,
    type OpenRunOptions,
    type ResultEnvelope,
    type ScenarioContext,
    type ScenarioDefinition,
    type ScenarioResult,
    type Transport,
} from "./contracts.ts";
import { createClient } from "./client.ts";
import { openRun } from "./lineage.ts";
import { publishResult } from "./artifacts.ts";
import { assembleEnvelope, declaredIdentity } from "./envelope.ts";
import { canonicalJson, digest, redact, redactText } from "./redact.ts";
import { systemClock } from "./time.ts";
import {
    GH_AUTH_TIMEOUT_MS,
    resolveGhToken,
    type CredentialResolver,
} from "./auth.ts";
import { collectionWork, object } from "../scenarios/shared.ts";

export interface ExecuteOptions {
    root: string;
    config: Config;
    input: JsonObject;
    inputs?: Record<string, JsonValue>;
    scenario: ScenarioDefinition;
    synthetic: boolean;
    live?: boolean;
    explicitProfile?: string;
    transport?: Transport;
    credentialResolver?: CredentialResolver;
    clock?: Clock;
    signal?: AbortSignal;
    mode?: "new" | "resume" | "refresh";
    runId?: string;
    expectedSequence?: number;
    expectedIdentity?: Identity;
    allowance?: OpenRunOptions["allowance"];
    probeOnly?: boolean;
}

export function safeError(
    error: unknown,
    secrets: readonly string[] = [],
): string {
    const message =
        error instanceof z.ZodError
            ? `invalid_input: ${error.issues
                  .slice(0, 10)
                  .map(
                      (issue) =>
                          `${issue.path.join(".") || "input"}: ${issue.message}`,
                  )
                  .join(
                      "; ",
                  )}${error.issues.length > 10 ? `; ${error.issues.length - 10} additional input issues omitted` : ""}`
            : error instanceof Error
              ? error.message
              : "unexpected_failure: Non-error exception";
    const redacted = redactText(message, secrets);
    return Buffer.byteLength(redacted) <= 8192
        ? redacted
        : `${Buffer.from(redacted).subarray(0, 8000).toString("utf8")} [abbreviated error; inspect local input and diagnostics]`;
}

async function liveToken(
    options: ExecuteOptions,
    signal: AbortSignal,
): Promise<string | undefined> {
    if (options.synthetic) return undefined;
    if (!options.live)
        throw new Error(
            "live_authorization_required: Use demo for synthetic data or explicitly authorize inspect with --live",
        );
    if (options.config.credential.name === "restricted-reader")
        throw new Error(
            "unverified_credential_reach: Live restricted-reader requires independently established read-only grants; this release cannot establish them from a token. Use an explicitly chosen operator-assisted-local profile or credential-isolated operator collection.",
        );
    if (options.explicitProfile !== "operator-assisted-local")
        throw new Error(
            "explicit_profile_required: A broader or unknown credential requires --profile operator-assisted-local on this invocation",
        );
    if (options.config.credential.credentialClass === "none")
        throw new Error(
            "credential_class_required: Configure the endpoint-appropriate credential class",
        );
    if (signal.aborted)
        throw new Error("operator_cancelled: Authentication was cancelled");
    return (options.credentialResolver ?? resolveGhToken)({
        host: options.config.host,
        signal,
        timeoutMs: Math.min(
            GH_AUTH_TIMEOUT_MS,
            options.config.budgets.maxElapsedMs,
        ),
    });
}

function fatalResult(code: string): ScenarioResult {
    return {
        rows: [],
        totals: {},
        work: [
            {
                id: "fatal-preflight",
                required: true,
                outcome: "failed",
                reasonCode: code,
                evidenceIds: [],
            },
        ],
        coverage: {
            discovery: "not-applicable",
            requested: null,
            observed: 0,
            assessed: 0,
            pagination: "not-applicable",
            excluded: [],
            unassessed: [],
            notes: [
                "Collection did not finish because of a fatal preflight or contract error.",
            ],
        },
        limitations: [
            "No usable domain result is claimed by this failure receipt.",
        ],
    };
}

async function verifyIdentity(
    context: ScenarioContext,
    options: ExecuteOptions,
): Promise<{ identity: Identity; collection: Collection }> {
    const installation =
        options.config.credential.credentialClass === "app-installation";
    const collection = await context.client.collect(
        installation ? "identity.installation" : "identity.user",
        { org: options.config.org },
    );
    if (collection.completeness !== "complete")
        return {
            identity: declaredIdentity(options.config, false),
            collection,
        };
    const data = object(collection.pages[0]?.data);
    const principal =
        data && typeof data.login === "string" ? data.login : null;
    const identity: Identity = {
        ...declaredIdentity(options.config, false),
        principal,
        verified: !installation && principal !== null,
        explanation: installation
            ? "The installation-token read probe succeeded, but installation identity and effective grants remain unverified."
            : "The authenticated user was verified by GET /user. Effective resource grants and broader write reach remain unknown; only this runner operation set is read-only.",
    };
    if (options.transport || options.credentialResolver)
        identity.explanation =
            "Identity response used an injected test transport or credential resolver; this does not establish live acceptance or credential grants.";
    if (!installation && !identity.verified)
        throw new Error(
            "invalid_identity: The user identity response lacks a verified login",
        );
    if (
        options.config.credential.declaredPrincipal &&
        principal &&
        options.config.credential.declaredPrincipal.toLowerCase() !==
            principal.toLowerCase()
    )
        throw new Error(
            "identity_mismatch: Authenticated principal differs from the declared credential profile",
        );
    if (
        options.expectedIdentity &&
        (!identity.verified ||
            !options.expectedIdentity.verified ||
            identity.principal !== options.expectedIdentity.principal)
    )
        throw new Error(
            "identity_mismatch: Resume or refresh requires the same independently verified principal; unverified identities cannot be reused",
        );
    return { identity, collection };
}

async function probeScenario(
    scenario: ScenarioDefinition,
    context: ScenarioContext,
    input: JsonObject,
): Promise<ScenarioResult> {
    const capability =
        scenario.manifest.capabilities.find(
            (item) => item.operation === "billing.usage",
        ) ??
        scenario.manifest.capabilities.find(
            (item) => item.operation === "repositories.list",
        ) ??
        scenario.manifest.capabilities[0];
    if (!capability)
        throw new Error(
            "invalid_scenario: A live probe needs a declared capability",
        );
    const month =
        Array.isArray(input.months) && typeof input.months[0] === "string"
            ? input.months[0]
            : undefined;
    const collection = await context.client.collect(capability.operation, {
        org: context.config.org,
        ...(month ? { month } : {}),
    });
    return {
        rows: [],
        totals: { probeOnly: true, operation: capability.operation },
        work: collectionWork("doctor:source-probe", collection),
        coverage: {
            discovery: "not-applicable",
            requested: 1,
            observed: collection.pages.length > 0 ? 1 : 0,
            assessed: collection.completeness === "complete" ? 1 : 0,
            pagination:
                collection.completeness === "complete" ? "complete" : "partial",
            excluded: [],
            unassessed: [],
            notes: [
                "This is an endpoint probe, not a full scenario or credential-grant certification.",
            ],
        },
        limitations: [
            "A successful read does not establish read-only credential reach, full estate visibility, optional signal access, or provider finality.",
        ],
    };
}

export async function executeScenario(
    options: ExecuteOptions,
): Promise<ResultEnvelope> {
    const { scenario, config } = options;
    if (config.host !== "github.com")
        throw new Error("unsupported_deployment: Only github.com is supported");
    if (
        scenario.manifest.status !== "implemented" ||
        scenario.manifest.risk !== "read-only" ||
        scenario.manifest.modes.join(",") !== "inspect"
    )
        throw new Error(
            "unsupported_scenario: Only implemented read-only inspect scenarios may execute",
        );
    if (
        !Number.isInteger(scenario.manifest.views.defaultRows) ||
        scenario.manifest.views.defaultRows < 1 ||
        scenario.manifest.views.defaultRows > scenario.manifest.views.maxRows ||
        scenario.manifest.views.maxRows > 1000
    )
        throw new Error(
            "invalid_scenario_view: View defaults must fit the declared row budget and the shared maximum of 1000",
        );
    configSchema.parse(config);
    const input = scenario.inputSchema.parse(options.input);
    const signal = options.signal ?? new AbortController().signal;
    const token = await liveToken(options, signal);
    const synthetic =
        options.synthetic ||
        options.transport !== undefined ||
        options.credentialResolver !== undefined;
    const secrets = token ? [token] : [];
    const inputs = jsonObjectSchema.parse(
        redact(options.inputs ?? {}, secrets),
    );
    const cleanConfig = configSchema.parse(
        JSON.parse(
            canonicalJson(redact(jsonValueSchema.parse(config), secrets)),
        ),
    );
    const identity =
        options.expectedIdentity ?? declaredIdentity(config, synthetic);
    const clock = options.clock ?? systemClock;
    const binding = {
        scenario: scenario.manifest.id,
        scenarioVersion: scenario.manifest.version,
        schemaVersion: SCHEMA_VERSION,
        codeVersion: CODE_VERSION,
        host: config.host,
        org: config.org,
        configHash: digest(cleanConfig),
        inputHash: digest({ input, inputs }),
        identityHash: digest({
            profile: config.credential,
            identity: {
                profile: identity.profile,
                credentialClass: identity.credentialClass,
            },
        }),
        synthetic,
    };
    const session = await openRun({
        root: options.root,
        reportsPath: config.reportsPath,
        mode: options.mode ?? "new",
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.expectedSequence !== undefined
            ? { expectedSequence: options.expectedSequence }
            : {}),
        binding,
        config: cleanConfig,
        input,
        inputs,
        identity,
        clock,
        ...(options.allowance ? { allowance: options.allowance } : {}),
    });
    const evidence: Evidence[] = [...session.state.evidence];
    const diagnostics: Diagnostic[] = [...session.state.diagnostics];
    const context: ScenarioContext = {
        config,
        inputs,
        clock,
        signal,
        startedAt: session.state.startedAt,
        synthetic,
        runId: session.state.runId,
        rootId: session.state.rootId,
        budget: session,
        evidence,
        diagnostics,
        client: {
            async collect() {
                throw new Error("client_not_ready");
            },
        },
        addEvidence(value) {
            const clean = jsonValueSchema.parse(
                redact(jsonValueSchema.parse(value), secrets),
            );
            const record = object(clean);
            if (!record)
                throw new Error(
                    "invalid_evidence: An evidence record must be an object",
                );
            const item = {
                ...value,
                data: record.data ?? null,
                source: redactText(value.source, secrets),
                target: redactText(value.target, secrets),
                id: `e-${randomUUID()}`,
                synthetic,
            };
            evidence.push(item);
            return item;
        },
        addDiagnostic(value) {
            const item = diagnosticSchema.parse(
                redact(
                    jsonValueSchema.parse({
                        ...value,
                        id: `d-${randomUUID()}`,
                    }),
                    secrets,
                ),
            );
            diagnostics.push(item);
            return item;
        },
    };
    let result: ResultEnvelope | undefined;
    let thrown: unknown;
    try {
        const makeClient = (
            capabilities: readonly import("./contracts.ts").OperationId[],
            cache: Record<string, Collection>,
        ) =>
            createClient({
                host: config.host,
                org: config.org,
                capabilities,
                ...(token ? { token } : {}),
                ...(options.transport ? { transport: options.transport } : {}),
                budget: session,
                clock,
                signal,
                synthetic,
                addEvidence: (value) => context.addEvidence(value),
                addDiagnostic: (value) => context.addDiagnostic(value),
                cache,
                checkpoint: async (updated) => {
                    await session.checkpoint({
                        cache: capabilities.every((item) =>
                            item.startsWith("identity."),
                        )
                            ? session.state.cache
                            : updated,
                        evidence,
                        diagnostics,
                    });
                },
            });
        let preflight: ScenarioResult | undefined;
        if (!options.synthetic) {
            context.client = makeClient(
                ["identity.user", "identity.installation"],
                {},
            );
            const verified = await verifyIdentity(context, options);
            if (verified.collection.completeness !== "complete") {
                preflight = {
                    ...fatalResult("identity_probe_failed"),
                    work: collectionWork(
                        "identity-preflight",
                        verified.collection,
                    ),
                    limitations: [
                        "Identity verification did not finish; no scenario collection was attempted. Correct authorization or resume after the reported provider/budget decision.",
                    ],
                };
            } else await session.checkpoint({ identity: verified.identity });
        }
        context.client = makeClient(
            scenario.manifest.capabilities.map(
                (capability) => capability.operation,
            ),
            session.state.cache,
        );
        let domain: ScenarioResult,
            fatal = false;
        try {
            domain =
                preflight ??
                (options.probeOnly
                    ? await probeScenario(scenario, context, input)
                    : await scenario.handler(input, context));
        } catch (error) {
            fatal = true;
            context.addDiagnostic({
                code: "scenario_contract_error",
                message: safeError(error, secrets),
                retryable: false,
                remediation:
                    "Inspect the source contract and diagnostics; correct configuration or code before a new run.",
            });
            domain = fatalResult("scenario_contract_error");
        }
        const unfinishedEvidence = new Set(
            domain.work
                .filter(
                    (unit) =>
                        unit.required &&
                        [
                            "failed",
                            "unassessed",
                            "waiting",
                            "cancelled",
                        ].includes(unit.outcome),
                )
                .flatMap((unit) => unit.evidenceIds),
        );
        const reusableCache = Object.fromEntries(
            Object.entries(session.state.cache).filter(
                ([, collection]) =>
                    !collection.pages.some((page) =>
                        unfinishedEvidence.has(page.evidenceId),
                    ),
            ),
        );
        await session.checkpoint({
            cache: reusableCache,
            evidence,
            diagnostics,
            work: domain.work,
        });
        const generation = `g-${session.state.sequence}-${randomUUID().slice(0, 8)}`;
        result = assembleEnvelope(
            fatal || preflight || options.probeOnly
                ? { ...scenario, resultSchema: scenarioResultSchema }
                : scenario,
            domain,
            context,
            session.state,
            generation,
            fatal,
        );
        await publishResult(options.root, config.reportsPath, result, {
            defaultRows: scenario.manifest.views.defaultRows,
        });
        await session.finish(result.status, generation);
    } catch (error) {
        thrown = error;
        context.addDiagnostic({
            code: "run_failed",
            message: safeError(error, secrets),
            retryable: false,
            remediation:
                "Resolve the reported preflight or persistence error. Previous immutable generations are not overwritten.",
        });
        try {
            await session.checkpoint({
                evidence,
                diagnostics,
                work: fatalResult("run_failed").work,
            });
            const receipt = assembleEnvelope(
                { ...scenario, resultSchema: scenarioResultSchema },
                fatalResult("run_failed"),
                context,
                session.state,
                `failure-${session.state.sequence}-${randomUUID().slice(0, 8)}`,
                true,
            );
            await publishResult(options.root, config.reportsPath, receipt, {
                defaultRows: scenario.manifest.views.defaultRows,
                advancePointer: false,
            });
            await session.finish(receipt.status, receipt.generation);
        } catch (receiptError) {
            thrown = new Error(
                `${safeError(error, secrets)}; failure_receipt_not_persisted: ${safeError(receiptError, secrets)}`,
            );
        }
    } finally {
        try {
            await session.close();
        } catch (closeError) {
            thrown = new Error(
                `${thrown ? `${safeError(thrown, secrets)}; ` : ""}lineage_close_failed: ${safeError(closeError, secrets)}`,
            );
        }
    }
    if (thrown) throw new Error(safeError(thrown, secrets));
    if (!result) throw new Error("run_failed: No result was published");
    return result;
}
