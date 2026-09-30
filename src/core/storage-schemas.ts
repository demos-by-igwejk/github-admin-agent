import { z } from "zod";
import {
    budgetLimitsSchema,
    configSchema,
    credentialProfileSchema,
    diagnosticSchema,
    jsonObjectSchema,
    jsonValueSchema,
    operationIds,
    scenarioResultSchema,
    workUnitSchema,
} from "./contracts.ts";
import type {
    Evidence,
    JsonValue,
    ResultEnvelope,
    StoredRun,
    WorkUnit,
} from "./contracts.ts";
import { redact, redactText } from "./redact.ts";
import { EXIT_CODES } from "./status.ts";
import { validTimestamp } from "./time.ts";

export const safeIdSchema = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const timestampSchema = z
    .string()
    .max(64)
    .refine(validTimestamp, "Expected a UTC timestamp");
export const counterSchema = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER);
export const statusSchema = z.enum([
    "completed",
    "partial",
    "failed",
    "deferred",
    "cancelled",
]);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const effectiveLimitsSchema = budgetLimitsSchema.extend({
    maxAttempts: counterSchema.refine((value) => value > 0),
    maxElapsedMs: counterSchema.refine((value) => value > 0),
});
export const budgetSnapshotSchema = z
    .strictObject({
        attempts: counterSchema,
        elapsedMs: counterSchema,
        waitMs: counterSchema,
        retries: counterSchema,
        limits: effectiveLimitsSchema,
        notBefore: timestampSchema.optional(),
    })
    .refine(
        (value) => value.retries <= value.attempts,
        "Retries cannot exceed reserved attempts",
    );
export const identitySchema = z.strictObject({
    profile: credentialProfileSchema.shape.name,
    credentialClass: credentialProfileSchema.shape.credentialClass,
    principal: z.string().nullable(),
    verified: z.boolean(),
    scope: z.array(z.string()),
    scopeVerified: z.boolean(),
    writeReach: z.enum(["read-only", "broader", "unknown"]),
    explanation: z.string(),
});
export const bindingSchema = z.strictObject({
    scenario: z.string().min(1).max(200),
    scenarioVersion: z.string().min(1).max(100),
    schemaVersion: z.string().min(1).max(100),
    codeVersion: z.string().min(1).max(100),
    host: z.string().min(1).max(253),
    org: z.string().min(1).max(100),
    configHash: z.string().min(1).max(200),
    inputHash: z.string().min(1).max(200),
    identityHash: z.string().min(1).max(200),
    synthetic: z.boolean(),
});
export const evidenceSchema = z.strictObject({
    id: z.string().min(1),
    operation: z.enum(operationIds),
    target: z.string(),
    observedAt: timestampSchema,
    source: z.string(),
    synthetic: z.boolean(),
    data: jsonValueSchema,
});
const persistedDiagnosticSchema = diagnosticSchema.extend({
    notBefore: timestampSchema.optional(),
});
const collectionSchema = z.strictObject({
    operation: z.enum(operationIds),
    pages: z.array(
        z.strictObject({
            evidenceId: z.string().min(1),
            observedAt: timestampSchema,
            data: jsonValueSchema,
        }),
    ),
    completeness: z.enum(["complete", "partial", "none"]),
    problems: z.array(
        z.strictObject({
            kind: z.enum([
                "denied",
                "invalid",
                "exhausted",
                "provider-wait",
                "unavailable",
                "cancelled",
                "unsupported-continuation",
            ]),
            diagnostic: persistedDiagnosticSchema,
        }),
    ),
});
const accountedWorkSchema = workUnitSchema
    .refine(
        (unit) => unit.outcome !== "valid" || unit.evidenceIds.length > 0,
        "Valid work requires an observation, including empty responses",
    )
    .refine(
        (unit) =>
            unit.outcome !== "policy-excluded" || Boolean(unit.reasonCode),
        "Policy exclusions require a reason",
    );

function validLedger(
    work: readonly WorkUnit[],
    evidence: readonly Evidence[],
): boolean {
    const evidenceIds = new Set(evidence.map((item) => item.id));
    return (
        evidenceIds.size === evidence.length &&
        new Set(work.map((unit) => unit.id)).size === work.length &&
        work.every(
            (unit) =>
                accountedWorkSchema.safeParse(unit).success &&
                unit.evidenceIds.every((id) => evidenceIds.has(id)),
        )
    );
}

export const checkpointSchema = z.strictObject({
    cache: z.record(z.string(), collectionSchema).optional(),
    evidence: z.array(evidenceSchema).optional(),
    diagnostics: z.array(persistedDiagnosticSchema).optional(),
    work: z.array(accountedWorkSchema).optional(),
    identity: identitySchema.optional(),
});
export const storedRunSchema: z.ZodType<StoredRun> = z
    .strictObject({
        schemaVersion: z.literal("1"),
        runId: safeIdSchema,
        rootId: safeIdSchema,
        parentRunId: safeIdSchema.optional(),
        sequence: counterSchema.refine((value) => value > 0),
        binding: bindingSchema,
        config: configSchema,
        input: jsonObjectSchema,
        inputs: z.record(z.string(), jsonValueSchema),
        identity: identitySchema,
        startedAt: timestampSchema,
        budget: budgetSnapshotSchema,
        cache: z.record(z.string(), collectionSchema),
        evidence: z.array(evidenceSchema),
        diagnostics: z.array(persistedDiagnosticSchema),
        work: z.array(accountedWorkSchema),
        generations: z.array(safeIdSchema),
        status: statusSchema.optional(),
    })
    .refine(
        (state) => validLedger(state.work, state.evidence),
        "Work ledger or evidence references are inconsistent",
    );
export const envelopeSchema: z.ZodType<ResultEnvelope> = z
    .strictObject({
        schemaVersion: z.literal("1"),
        runId: safeIdSchema,
        rootId: safeIdSchema,
        parentRunId: safeIdSchema.optional(),
        generation: safeIdSchema,
        scenario: z.string().min(1).max(200),
        scenarioVersion: z.string().min(1).max(100),
        codeVersion: z.string().min(1).max(100),
        host: z.string().min(1).max(253),
        scope: jsonObjectSchema,
        identity: identitySchema,
        inputHash: z.string().min(1).max(200),
        configHash: z.string().min(1).max(200),
        synthetic: z.boolean(),
        startedAt: timestampSchema,
        completedAt: timestampSchema,
        status: statusSchema,
        exitCode: z.number().int(),
        reasons: z.array(z.string()),
        nextActions: z.array(z.string()),
        resumeNotBefore: timestampSchema.optional(),
        assurance: z.strictObject({
            population: z.enum(["unverified", "not-applicable"]),
            freshness: z.literal("observed"),
            finality: z.enum(["unknown", "not-applicable"]),
            attribution: z.enum(["source-only", "not-applicable"]),
        }),
        budget: budgetSnapshotSchema,
        result: scenarioResultSchema,
        evidence: z.array(evidenceSchema),
        diagnostics: z.array(persistedDiagnosticSchema),
    })
    .refine(
        (value) => value.exitCode === EXIT_CODES[value.status],
        "Exit code must agree with status",
    )
    .refine(
        (value) => Date.parse(value.completedAt) >= Date.parse(value.startedAt),
        "Completion precedes collection",
    )
    .refine(
        (value) => validLedger(value.result.work, value.evidence),
        "Work ledger or evidence references are inconsistent",
    )
    .refine((value) => {
        const evidenceIds = new Set(value.evidence.map((item) => item.id));
        return value.result.rows.every((row) =>
            row.evidenceIds.every((id) => evidenceIds.has(id)),
        );
    }, "Rows reference unavailable evidence");

export function validate<T>(
    schema: z.ZodType<T>,
    value: unknown,
    context: string,
): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        const codes = parsed.error.issues
            .slice(0, 3)
            .map((issue) => issue.code)
            .join(", ");
        throw new Error(
            `invalid_${context}: Schema validation failed (${codes})`,
        );
    }
    return parsed.data;
}

export function sanitize(value: unknown): JsonValue {
    const omitUndefined = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(omitUndefined);
        if (
            !item ||
            typeof item !== "object" ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(item))
        )
            return item;
        return Object.fromEntries(
            Object.entries(item)
                .filter(([, child]) => child !== undefined)
                .map(([key, child]) => [key, omitUndefined(child)]),
        );
    };
    const safe = redact(
        validate(jsonValueSchema, omitUndefined(value), "json"),
    );
    const keys = (item: JsonValue): JsonValue => {
        if (Array.isArray(item)) return item.map(keys);
        if (!item || typeof item !== "object") return item;
        const entries = Object.entries(item).map(
            ([key, child]) => [redactText(key), keys(child)] as const,
        );
        if (new Set(entries.map(([key]) => key)).size !== entries.length)
            throw new Error(
                "redaction_collision: Redacted object keys collide",
            );
        return Object.fromEntries(entries);
    };
    return keys(safe);
}
