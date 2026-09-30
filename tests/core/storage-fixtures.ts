import { promises as fs } from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
    CODE_VERSION,
    configSchema,
    SCHEMA_VERSION,
} from "../../src/core/contracts.ts";
import type {
    Identity,
    OpenRunOptions,
    ResultEnvelope,
    StoredRun,
} from "../../src/core/contracts.ts";
import { digest } from "../../src/core/redact.ts";
import { TestClock } from "../helpers.ts";

export async function temporaryProject(
    context: TestContext,
    name: string,
): Promise<string> {
    const parent = fileURLToPath(new URL("../../.test-tmp/", import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, `${name}-`));
    context.after(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });
    return directory;
}

export const identity: Identity = {
    profile: "restricted-reader",
    credentialClass: "none",
    principal: "synthetic-reader",
    verified: true,
    scope: ["example-org"],
    scopeVerified: false,
    writeReach: "read-only",
    explanation: "Synthetic fixture identity.",
};

export function runOptions(
    root: string,
    changes: Partial<OpenRunOptions> = {},
): OpenRunOptions {
    const config = changes.config ?? configSchema.parse({ org: "example-org" });
    const input = changes.input ?? {},
        inputs = changes.inputs ?? {},
        effectiveIdentity = changes.identity ?? identity;
    return {
        root,
        reportsPath: "reports",
        mode: "new",
        config,
        input,
        inputs,
        identity: structuredClone(effectiveIdentity),
        clock: new TestClock(),
        binding: {
            scenario: "repository-activity-inventory",
            scenarioVersion: "1",
            schemaVersion: SCHEMA_VERSION,
            codeVersion: CODE_VERSION,
            host: config.host,
            org: config.org,
            configHash: digest(config),
            inputHash: digest({ input, inputs }),
            identityHash: digest(effectiveIdentity),
            synthetic: true,
        },
        ...changes,
    };
}

export function reopenOptions(
    root: string,
    state: StoredRun,
    changes: Partial<OpenRunOptions> = {},
): OpenRunOptions {
    return runOptions(root, {
        mode: "resume",
        runId: state.runId,
        config: state.config,
        input: state.input,
        inputs: state.inputs,
        identity: state.identity,
        binding: state.binding,
        ...changes,
    });
}

export function resultEnvelope(rows = 30): ResultEnvelope {
    const options = runOptions(".");
    return {
        schemaVersion: "1",
        runId: "test-run",
        rootId: "test-run",
        generation: "g-1",
        scenario: "repository-activity-inventory",
        scenarioVersion: "1",
        codeVersion: CODE_VERSION,
        host: "github.com",
        scope: { org: "example-org", selection: "api-visible" },
        identity: structuredClone(identity),
        inputHash: options.binding.inputHash,
        configHash: options.binding.configHash,
        synthetic: true,
        startedAt: "2026-09-15T12:00:00.000Z",
        completedAt: "2026-09-15T12:01:00.000Z",
        status: "completed",
        exitCode: 0,
        reasons: [],
        nextActions: ["Read detailed evidence for qualifications."],
        assurance: {
            population: "unverified",
            freshness: "observed",
            finality: "unknown",
            attribution: "source-only",
        },
        budget: {
            attempts: 1,
            retries: 0,
            elapsedMs: 60000,
            waitMs: 0,
            limits: options.config.budgets,
        },
        result: {
            rows: Array.from({ length: rows }, (_, index) => ({
                id: `row-${String(rows - index - 1).padStart(4, "0")}`,
                repository: `example-org/repo-${String(rows - index - 1).padStart(4, "0")}`,
                sku: index % 2 ? "linux" : "windows",
                reason: "observed",
                evidenceIds: ["e1"],
                amount: "-0.125",
            })),
            totals: { amount: "-3.75", rows },
            work: [
                {
                    id: "discovery",
                    required: true,
                    outcome: "valid",
                    evidenceIds: ["e1"],
                },
            ],
            coverage: {
                discovery: "api-visible",
                requested: null,
                observed: rows,
                assessed: rows,
                pagination: "complete",
                unassessed: [],
                excluded: [],
                notes: ["Global population remains unverified."],
            },
            limitations: ["Provider finality is unknown."],
        },
        evidence: [
            {
                id: "e1",
                operation: "repositories.list",
                target: "example-org",
                observedAt: "2026-09-15T12:00:00.000Z",
                source: "fixture:repositories.list",
                synthetic: true,
                data: { rows },
            },
        ],
        diagnostics: [
            {
                id: "d1",
                code: "population_unverified",
                message: "API-visible scope only.",
                retryable: false,
                remediation: "Retain the population qualification.",
                evidenceId: "e1",
            },
        ],
    };
}
