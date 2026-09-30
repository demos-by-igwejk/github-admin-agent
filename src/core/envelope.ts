import {
    CODE_VERSION,
    jsonValueSchema,
    type Config,
    type Identity,
    type JsonObject,
    type ResultEnvelope,
    type ScenarioContext,
    type ScenarioDefinition,
    type ScenarioResult,
    type StoredRun,
} from "./contracts.ts";
import { deriveStatus, EXIT_CODES } from "./status.ts";
import { envelopeSchema } from "./storage-schemas.ts";

export { identitySchema } from "./storage-schemas.ts";
export const resultEnvelopeSchema = envelopeSchema;

export function assembleEnvelope(
    scenario: ScenarioDefinition,
    domain: ScenarioResult,
    context: ScenarioContext,
    state: StoredRun,
    generation: string,
    fatal = false,
): ResultEnvelope {
    const validated = scenario.resultSchema.parse(domain);
    const evidenceIds = new Set(
        context.evidence.map((evidence) => evidence.id),
    );
    const workIds = new Set<string>();
    for (const unit of validated.work) {
        if (workIds.has(unit.id))
            throw new Error(
                `invalid_work_ledger: Duplicate work unit ${unit.id}`,
            );
        workIds.add(unit.id);
        if (unit.outcome === "policy-excluded" && !unit.reasonCode)
            throw new Error(
                "invalid_work_ledger: A policy exclusion needs a reason",
            );
        if (unit.evidenceIds.some((id) => !evidenceIds.has(id)))
            throw new Error(
                "invalid_evidence_reference: Work references unavailable evidence",
            );
        if (unit.outcome === "valid" && unit.evidenceIds.length === 0)
            throw new Error(
                "invalid_work_ledger: Valid work needs a source observation, including empty results",
            );
    }
    for (const row of validated.rows) {
        if (row.evidenceIds.some((id) => !evidenceIds.has(id)))
            throw new Error(
                "invalid_evidence_reference: A row references unavailable evidence",
            );
    }
    const usable = validated.work.some(
        (unit) => unit.outcome === "valid" && unit.evidenceIds.length > 0,
    );
    const status = deriveStatus(validated.work, {
        usable,
        fatal,
        cancelled: context.signal.aborted,
    });
    const budget = context.budget.snapshot();
    const sourceOperations = new Set(
        scenario.manifest.capabilities.map(
            (capability) => capability.operation,
        ),
    );
    const financial = sourceOperations.has("billing.usage");
    const scope: JsonObject = {
        host: context.config.host,
        org: context.config.org,
        selection: jsonValueSchema.parse(context.config.selection),
        input: state.input,
        coverage: jsonValueSchema.parse(validated.coverage),
    };
    return resultEnvelopeSchema.parse({
        schemaVersion: "1",
        runId: state.runId,
        rootId: state.rootId,
        ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
        generation,
        scenario: scenario.manifest.id,
        scenarioVersion: scenario.manifest.version,
        codeVersion: CODE_VERSION,
        host: context.config.host,
        scope,
        identity: state.identity,
        inputHash: state.binding.inputHash,
        configHash: state.binding.configHash,
        synthetic: context.synthetic,
        startedAt: state.startedAt,
        completedAt: context.clock.now().toISOString(),
        status,
        exitCode: EXIT_CODES[status],
        reasons: [
            ...new Set([
                ...validated.work.flatMap((unit) =>
                    unit.reasonCode ? [unit.reasonCode] : [],
                ),
                ...context.diagnostics.map((item) => item.code),
            ]),
        ],
        nextActions:
            status === "completed"
                ? [
                      "result",
                      "refresh (requires an explicit fresh-collection decision)",
                  ]
                : status === "deferred"
                  ? [
                        "resume after the provider deadline or an explicit additional allowance",
                    ]
                  : status === "cancelled"
                    ? ["review retained evidence", "resume explicitly"]
                    : [
                          "review diagnostics and correct the reported cause",
                          "resume compatible recoverable work explicitly",
                      ],
        ...(budget.notBefore ? { resumeNotBefore: budget.notBefore } : {}),
        assurance: {
            population:
                validated.coverage.discovery === "not-applicable"
                    ? "not-applicable"
                    : "unverified",
            freshness: "observed",
            finality: financial ? "unknown" : "not-applicable",
            attribution: financial ? "source-only" : "not-applicable",
        },
        budget,
        result: validated,
        evidence: context.evidence,
        diagnostics: context.diagnostics,
    });
}

export function declaredIdentity(config: Config, synthetic: boolean): Identity {
    return {
        profile: config.credential.name,
        credentialClass: config.credential.credentialClass,
        principal: config.credential.declaredPrincipal ?? null,
        verified: false,
        scope: [config.org],
        scopeVerified: false,
        writeReach: synthetic ? "read-only" : "unknown",
        explanation: synthetic
            ? "Synthetic transport makes no network requests and establishes no live identity or grants."
            : "Operator-declared profile; effective GitHub token grants and write reach have not been verified.",
    };
}
