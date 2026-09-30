import { z } from "zod";
import { getSourceIdentity } from "./source-revision.ts";

export const CODE_VERSION = getSourceIdentity().codeVersion;
export const SCHEMA_VERSION = "1";
export const API_VERSION = "2026-03-10";
export const SUMMARY_BYTES = 64 * 1024;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
    JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number().finite(),
        z.boolean(),
        z.null(),
        z.array(jsonValueSchema),
        z.record(z.string(), jsonValueSchema),
    ]),
);
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
export const repositoryNameSchema = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}\/[a-zA-Z0-9._-]{1,100}$/);
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const signalSchema = z.enum([
    "push",
    "commits",
    "issues",
    "pull_requests",
    "discussions",
    "actions",
]);
export type Signal = z.infer<typeof signalSchema>;
export const activityPolicySchema = z.strictObject({
    name: z.string().min(1).max(200).default("recent-activity"),
    window: z
        .discriminatedUnion("kind", [
            z.strictObject({
                kind: z.literal("days"),
                value: z.number().int().min(1).max(3660),
            }),
            z.strictObject({
                kind: z.literal("calendar-months"),
                value: z.number().int().min(1).max(120),
            }),
        ])
        .default({ kind: "calendar-months", value: 6 }),
    signals: z
        .array(signalSchema)
        .min(1)
        .max(6)
        .refine((v) => new Set(v).size === v.length, "Signals must be unique")
        .default(["push"]),
    positiveShortCircuit: z.boolean().default(true),
    clockSkewSeconds: z.number().int().min(0).max(300).default(60),
});
export type ActivityPolicy = z.infer<typeof activityPolicySchema>;
export const selectionSchema = z.strictObject({
    mode: z.enum(["api-visible", "declared-targets"]).optional(),
    repositories: z.array(repositoryNameSchema).max(10000).default([]),
    properties: z
        .record(z.string().min(1).max(100), z.string().max(1000))
        .default({}),
    maxAssessments: z.number().int().positive().max(100000).optional(),
});
export type Selection = z.infer<typeof selectionSchema>;
export const budgetLimitsSchema = z.strictObject({
    maxAttempts: z.number().int().min(1).max(100000).default(1000),
    maxElapsedMs: z.number().int().min(1).max(86400000).default(900000),
    requestTimeoutMs: z.number().int().min(1).max(300000).default(30000),
    maxAttemptsPerRequest: z.number().int().min(1).max(10).default(3),
    concurrency: z.number().int().min(1).max(10).default(2),
});
export type BudgetLimits = z.infer<typeof budgetLimitsSchema>;
export const credentialProfileSchema = z.strictObject({
    name: z
        .enum(["restricted-reader", "operator-assisted-local"])
        .default("restricted-reader"),
    credentialClass: z
        .enum([
            "oauth",
            "classic-pat",
            "fine-grained-pat",
            "app-installation",
            "app-user",
            "none",
        ])
        .default("none"),
    source: z.literal("gh-cli").default("gh-cli"),
    declaredPrincipal: z.string().max(200).optional(),
});
export type CredentialProfile = z.infer<typeof credentialProfileSchema>;
export const configSchema = z.strictObject({
    schemaVersion: z.literal("1").default("1"),
    host: z.literal("github.com").default("github.com"),
    org: slug,
    credential: credentialProfileSchema.default({
        name: "restricted-reader",
        credentialClass: "none",
        source: "gh-cli",
    }),
    selection: selectionSchema.default({ repositories: [], properties: {} }),
    activity: activityPolicySchema.default({
        name: "recent-activity",
        window: { kind: "calendar-months", value: 6 },
        signals: ["push"],
        positiveShortCircuit: true,
        clockSkewSeconds: 60,
    }),
    budgets: budgetLimitsSchema.default({
        maxAttempts: 1000,
        maxElapsedMs: 900000,
        requestTimeoutMs: 30000,
        maxAttemptsPerRequest: 3,
        concurrency: 2,
    }),
    policyPath: z.string().min(1).default("config/policies/repositories.json"),
    ownersPath: z.string().min(1).default("config/owners.csv"),
    reportsPath: z.string().min(1).default("reports"),
    retentionDays: z.number().int().min(1).max(3650).default(30),
});
export type Config = z.infer<typeof configSchema>;

export const operationIds = [
    "identity.user",
    "identity.installation",
    "repositories.list",
    "repositories.get",
    "repositories.properties",
    "activity.commits",
    "activity.issues",
    "activity.pull-requests",
    "activity.discussions",
    "activity.actions",
    "billing.usage",
    "conformance.runners",
] as const;
export type OperationId = (typeof operationIds)[number];
export interface OperationArgs {
    org: string;
    repo?: string;
    branch?: string;
    month?: string;
    since?: string;
}
export interface Diagnostic {
    id: string;
    code: string;
    message: string;
    operation?: OperationId;
    target?: string;
    status?: number;
    requestId?: string;
    retryable: boolean;
    remediation: string;
    evidenceId?: string;
    notBefore?: string;
}
export interface Evidence {
    id: string;
    operation: OperationId;
    target: string;
    observedAt: string;
    source: string;
    synthetic: boolean;
    data: JsonValue;
}
export interface SourcePage {
    evidenceId: string;
    observedAt: string;
    data: JsonValue;
}
export type ProblemKind =
    | "denied"
    | "invalid"
    | "exhausted"
    | "provider-wait"
    | "unavailable"
    | "cancelled"
    | "unsupported-continuation";
export interface ClientProblem {
    kind: ProblemKind;
    diagnostic: Diagnostic;
}
export interface Collection {
    operation: OperationId;
    pages: SourcePage[];
    completeness: "complete" | "partial" | "none";
    problems: ClientProblem[];
}
export interface ReadClient {
    collect(operation: OperationId, args: OperationArgs): Promise<Collection>;
}
export interface Clock {
    now(): Date;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export interface BudgetSnapshot {
    attempts: number;
    elapsedMs: number;
    waitMs: number;
    retries: number;
    limits: BudgetLimits;
    notBefore?: string;
}
export type Reservation =
    { ok: true; attempt: number } | { ok: false; problem: ClientProblem };
export interface BudgetAuthority {
    reserve(): Promise<Reservation>;
    recordWait(ms: number): Promise<void>;
    recordRetry(): Promise<void>;
    deferUntil(iso: string): Promise<void>;
    snapshot(): BudgetSnapshot;
}
export type WorkOutcome =
    | "valid"
    | "failed"
    | "unassessed"
    | "policy-excluded"
    | "waiting"
    | "cancelled";
export interface WorkUnit {
    id: string;
    required: boolean;
    outcome: WorkOutcome;
    reasonCode?: string;
    evidenceIds: string[];
}
export interface Coverage {
    discovery: "api-visible" | "declared-targets" | "not-applicable";
    requested: number | null;
    observed: number;
    assessed: number;
    pagination: "complete" | "partial" | "not-applicable";
    unassessed: string[];
    excluded: string[];
    notes: string[];
}
export interface ScenarioRow {
    id: string;
    repository?: string;
    sku?: string;
    reason?: string;
    evidenceIds: string[];
    [key: string]: JsonValue | undefined;
}
export interface ScenarioResult {
    rows: ScenarioRow[];
    totals: JsonObject;
    work: WorkUnit[];
    coverage: Coverage;
    limitations: string[];
}
export interface ScenarioContext {
    client: ReadClient;
    config: Config;
    clock: Clock;
    signal: AbortSignal;
    startedAt: string;
    synthetic: boolean;
    runId: string;
    rootId: string;
    budget: BudgetAuthority;
    inputs: Readonly<Record<string, JsonValue>>;
    evidence: Evidence[];
    diagnostics: Diagnostic[];
    addEvidence(value: Omit<Evidence, "id" | "synthetic">): Evidence;
    addDiagnostic(value: Omit<Diagnostic, "id">): Diagnostic;
}
export interface Capability {
    operation: OperationId;
    resource: string;
    credentialClasses: string[];
    permissions: string[];
    reference: string;
}
export interface ScenarioManifest {
    id: string;
    version: string;
    status: "implemented" | "experimental" | "proposed";
    title: string;
    description: string;
    intentExamples: string[];
    risk: "read-only";
    modes: ["inspect"];
    platforms: ["github.com"];
    capabilities: Capability[];
    inputs: {
        name: string;
        defaultPath: string;
        required: boolean;
        sensitivity: "configuration" | "sensitive";
    }[];
    artifacts: string[];
    views: {
        defaultRows: number;
        maxRows: number;
        order: string;
        filters: string[];
    };
    limitations: string[];
    recovery: string[];
    skill: string;
    fixtures: string[];
}
export interface ScenarioDefinition {
    manifest: ScenarioManifest;
    inputSchema: z.ZodType<JsonObject>;
    resultSchema: z.ZodType<ScenarioResult>;
    handler(
        input: JsonObject,
        context: ScenarioContext,
    ): Promise<ScenarioResult>;
}
export const diagnosticSchema = z.strictObject({
    id: z.string(),
    code: z.string(),
    message: z.string(),
    operation: z.enum(operationIds).optional(),
    target: z.string().optional(),
    status: z.number().int().optional(),
    requestId: z.string().optional(),
    retryable: z.boolean(),
    remediation: z.string(),
    evidenceId: z.string().optional(),
    notBefore: z.string().optional(),
});
export const workUnitSchema = z.strictObject({
    id: z.string().min(1),
    required: z.boolean(),
    outcome: z.enum([
        "valid",
        "failed",
        "unassessed",
        "policy-excluded",
        "waiting",
        "cancelled",
    ]),
    reasonCode: z.string().optional(),
    evidenceIds: z.array(z.string()),
});
export const coverageSchema = z.strictObject({
    discovery: z.enum(["api-visible", "declared-targets", "not-applicable"]),
    requested: z.number().int().nonnegative().nullable(),
    observed: z.number().int().nonnegative(),
    assessed: z.number().int().nonnegative(),
    pagination: z.enum(["complete", "partial", "not-applicable"]),
    unassessed: z.array(z.string()),
    excluded: z.array(z.string()),
    notes: z.array(z.string()),
});
export const scenarioRowSchema: z.ZodType<ScenarioRow> = z
    .object({
        id: z.string().min(1),
        repository: z.string().optional(),
        sku: z.string().optional(),
        reason: z.string().optional(),
        evidenceIds: z.array(z.string()),
    })
    .catchall(jsonValueSchema);
export const scenarioResultSchema: z.ZodType<ScenarioResult> = z.strictObject({
    rows: z.array(scenarioRowSchema),
    totals: jsonObjectSchema,
    work: z.array(workUnitSchema),
    coverage: coverageSchema,
    limitations: z.array(z.string()),
});
export type ExecutionStatus =
    "completed" | "partial" | "failed" | "deferred" | "cancelled";
export interface Identity {
    profile: CredentialProfile["name"];
    credentialClass: CredentialProfile["credentialClass"];
    principal: string | null;
    verified: boolean;
    scope: string[];
    scopeVerified: boolean;
    writeReach: "read-only" | "broader" | "unknown";
    explanation: string;
}
export interface RunBinding {
    scenario: string;
    scenarioVersion: string;
    schemaVersion: string;
    codeVersion: string;
    host: string;
    org: string;
    configHash: string;
    inputHash: string;
    identityHash: string;
    synthetic: boolean;
}
export interface ResultEnvelope {
    schemaVersion: "1";
    runId: string;
    rootId: string;
    parentRunId?: string;
    generation: string;
    scenario: string;
    scenarioVersion: string;
    codeVersion: string;
    host: string;
    scope: JsonObject;
    identity: Identity;
    inputHash: string;
    configHash: string;
    synthetic: boolean;
    startedAt: string;
    completedAt: string;
    status: ExecutionStatus;
    exitCode: number;
    reasons: string[];
    nextActions: string[];
    resumeNotBefore?: string;
    assurance: {
        population: "unverified" | "not-applicable";
        freshness: "observed";
        finality: "unknown" | "not-applicable";
        attribution: "source-only" | "not-applicable";
    };
    budget: BudgetSnapshot;
    result: ScenarioResult;
    evidence: Evidence[];
    diagnostics: Diagnostic[];
}
export interface TransportRequest {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
}
export interface TransportResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}
export type Transport = (
    request: TransportRequest,
) => Promise<TransportResponse>;
export interface ClientOptions {
    host: string;
    org: string;
    capabilities: readonly OperationId[];
    token?: string;
    transport?: Transport;
    budget: BudgetAuthority;
    clock: Clock;
    signal: AbortSignal;
    synthetic: boolean;
    addEvidence: ScenarioContext["addEvidence"];
    addDiagnostic: ScenarioContext["addDiagnostic"];
    cache?: Record<string, Collection>;
    checkpoint?: (cache: Record<string, Collection>) => Promise<void>;
}
export interface ViewOptions {
    view?: "summary" | "rows";
    repository?: string;
    sku?: string;
    reason?: string;
    cursor?: string;
    limit?: number;
}
export interface ResultView {
    schemaVersion: "1";
    runId: string;
    generation: string;
    scenario: string;
    status: ExecutionStatus;
    synthetic: boolean;
    scope: JsonObject;
    time: { startedAt: string; completedAt: string };
    assurance: ResultEnvelope["assurance"];
    filters: JsonObject;
    shown: number;
    totalMatches: number;
    selection: string;
    rows: ScenarioRow[];
    allSourceTotals: JsonObject;
    reasons: string[];
    limitations: string[];
    nextActions: string[];
    artifacts: JsonObject;
    continuation?: string;
    abbreviations: string[];
}

export interface StoredRun {
    schemaVersion: "1";
    runId: string;
    rootId: string;
    parentRunId?: string;
    sequence: number;
    binding: RunBinding;
    config: Config;
    input: JsonObject;
    inputs: Record<string, JsonValue>;
    identity: Identity;
    startedAt: string;
    budget: BudgetSnapshot;
    cache: Record<string, Collection>;
    evidence: Evidence[];
    diagnostics: Diagnostic[];
    work: WorkUnit[];
    generations: string[];
    status?: ExecutionStatus;
}
export interface OpenRunOptions {
    root: string;
    reportsPath: string;
    mode: "new" | "resume" | "refresh";
    runId?: string;
    expectedSequence?: number;
    binding: RunBinding;
    config: Config;
    input: JsonObject;
    inputs: Record<string, JsonValue>;
    identity: Identity;
    clock: Clock;
    allowance?: {
        additionalAttempts?: number;
        additionalElapsedMs?: number;
        reason: string;
    };
}
export interface RunSession extends BudgetAuthority {
    state: StoredRun;
    checkpoint(data: {
        cache?: Record<string, Collection>;
        evidence?: Evidence[];
        diagnostics?: Diagnostic[];
        work?: WorkUnit[];
        identity?: Identity;
    }): Promise<void>;
    finish(status: ExecutionStatus, generation?: string): Promise<void>;
    close(): Promise<void>;
}
