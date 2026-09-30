import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
    configSchema,
    scenarioResultSchema,
    type ScenarioDefinition,
    type Transport,
} from "../../src/core/contracts.ts";
import { executeScenario } from "../../src/core/runner.ts";
import { collectionWork, items } from "../../src/scenarios/shared.ts";
import { TestClock } from "../helpers.ts";
import { readRun } from "../../src/core/lineage.ts";
import { readResult } from "../../src/core/artifacts.ts";

const conformanceScenario: ScenarioDefinition = {
    manifest: {
        id: "test-runner-conformance",
        version: "1.0.0",
        status: "implemented",
        title: "Test-only runner conformance",
        description:
            "Tests the extension contract without repository or billing entities.",
        intentExamples: ["List fixture runners"],
        risk: "read-only",
        modes: ["inspect"],
        platforms: ["github.com"],
        capabilities: [
            {
                operation: "conformance.runners",
                resource: "/orgs/{org}/actions/runners",
                credentialClasses: ["synthetic"],
                permissions: [],
                reference:
                    "https://docs.github.com/en/rest/actions/self-hosted-runners",
            },
        ],
        inputs: [],
        artifacts: ["result.json"],
        views: {
            defaultRows: 25,
            maxRows: 1000,
            order: "id",
            filters: ["reason"],
        },
        limitations: ["Test only; absent from shipped catalog."],
        recovery: ["resume"],
        skill: "",
        fixtures: ["test-only"],
    },
    inputSchema: z.strictObject({}),
    resultSchema: scenarioResultSchema,
    async handler(_input, context) {
        const collection = await context.client.collect("conformance.runners", {
            org: context.config.org,
        });
        const rows = items(collection).map((item, index) => ({
            id: `runner-${index}`,
            value: item.value,
            evidenceIds: [item.evidenceId],
        }));
        return {
            rows,
            totals: { runners: rows.length },
            work: collectionWork("runners", collection),
            coverage: {
                discovery: "not-applicable",
                requested: null,
                observed: rows.length,
                assessed: rows.length,
                pagination:
                    collection.completeness === "complete"
                        ? "complete"
                        : "partial",
                unassessed: [],
                excluded: [],
                notes: [],
            },
            limitations: ["Test data cannot promote live assurance."],
        };
    },
};

async function workspace(): Promise<string> {
    const directory = fileURLToPath(
        new URL("../../.test-tmp/", import.meta.url),
    );
    await mkdir(directory, { recursive: true });
    return mkdtemp(join(directory, "runner-"));
}
const transport: Transport = async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
        total_count: 1,
        runners: [{ id: 1, name: "linux" }],
    }),
});

test("AC01/23: generic runner hosts non-repository handler and keeps assurance qualified", async () => {
    const root = await workspace();
    try {
        const result = await executeScenario({
            root,
            config: configSchema.parse({ org: "example-org" }),
            input: {},
            scenario: conformanceScenario,
            synthetic: true,
            transport,
            clock: new TestClock(),
        });
        assert.equal(result.status, "completed");
        assert.equal(result.exitCode, 0);
        assert.equal(result.result.rows.length, 1);
        assert.equal(result.result.rows[0]?.repository, undefined);
        assert.equal(result.assurance.population, "not-applicable");
        assert.equal(result.synthetic, true);
        assert.equal(result.identity.verified, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("runner cannot accept handler assurance promotion or forged success", async () => {
    const root = await workspace();
    try {
        const malicious: ScenarioDefinition = {
            ...conformanceScenario,
            async handler(input, context) {
                const result = await conformanceScenario.handler(
                    input,
                    context,
                );
                return { ...result, assurance: { population: "verified" } };
            },
        };
        await assert.rejects(
            executeScenario({
                root,
                config: configSchema.parse({ org: "example-org" }),
                input: {},
                scenario: malicious,
                synthetic: true,
                transport,
                clock: new TestClock(),
            }),
            /Unrecognized key|assurance|invalid_input/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("live authorization and broad credentials are never inferred from configuration", async () => {
    const root = await workspace();
    let credentialCalls = 0;
    const credentialResolver = async () => {
        credentialCalls++;
        throw new Error("unexpected_test_credential_retrieval");
    };
    try {
        await assert.rejects(
            executeScenario({
                root,
                config: configSchema.parse({ org: "example-org" }),
                input: {},
                scenario: conformanceScenario,
                synthetic: false,
                transport,
                credentialResolver,
            }),
            /live_authorization_required/,
        );
        await assert.rejects(
            executeScenario({
                root,
                config: configSchema.parse({ org: "example-org" }),
                input: {},
                scenario: conformanceScenario,
                synthetic: false,
                live: true,
                transport,
                credentialResolver,
            }),
            /unverified_credential_reach/,
        );
        await assert.rejects(
            executeScenario({
                root,
                config: configSchema.parse({
                    org: "example-org",
                    credential: {
                        name: "operator-assisted-local",
                        credentialClass: "classic-pat",
                    },
                }),
                input: {},
                scenario: conformanceScenario,
                synthetic: false,
                live: true,
                transport,
                credentialResolver,
            }),
            /explicit_profile_required/,
        );
        await assert.rejects(
            executeScenario({
                root,
                config: configSchema.parse({
                    org: "example-org",
                    credential: { name: "operator-assisted-local" },
                }),
                input: {},
                scenario: conformanceScenario,
                synthetic: false,
                live: true,
                explicitProfile: "operator-assisted-local",
                transport,
                credentialResolver,
            }),
            /credential_class_required/,
        );
        assert.equal(credentialCalls, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("verified identity is durable; compatible recovery succeeds and mismatched identity preserves the last good generation", async () => {
    const root = await workspace();
    const token =
        "synthetic-token-for-identity-regression-not-a-credential";
    let credentialCalls = 0;
    const config = configSchema.parse({
        org: "example-org",
        credential: {
            name: "operator-assisted-local",
            credentialClass: "oauth",
            source: "gh-cli",
        },
    });
    let principal = "fixture-user";
    const identityTransport: Transport = async (request) =>
        new URL(request.url).pathname === "/user"
            ? {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ login: principal, id: 1 }),
              }
            : transport(request);
    const options = {
        root,
        config,
        input: {},
        scenario: conformanceScenario,
        synthetic: false,
        live: true,
        explicitProfile: "operator-assisted-local",
        transport: identityTransport,
        credentialResolver: async () => {
            credentialCalls++;
            return token;
        },
        clock: new TestClock(),
    };
    try {
        const first = await executeScenario(options);
        assert.equal(first.status, "completed");
        assert.equal(first.identity.principal, "fixture-user");
        assert.equal(first.identity.verified, true);
        assert.equal(
            first.synthetic,
            true,
            "Injected transport must never be recorded as real live evidence",
        );
        const stored = await readRun(root, "reports", first.runId);
        assert.equal(stored.identity.verified, true);
        assert.equal(stored.identity.principal, "fixture-user");
        assert.equal(stored.config.credential.source, "gh-cli");
        assert.ok(!JSON.stringify([first, stored]).includes(token));
        assert.equal(credentialCalls, 1);
        const resumed = await executeScenario({
            ...options,
            mode: "resume",
            runId: first.runId,
            expectedIdentity: stored.identity,
        });
        assert.equal(resumed.status, "completed");
        assert.equal(resumed.identity.principal, "fixture-user");
        assert.equal(credentialCalls, 2);
        principal = "different-user";
        await assert.rejects(
            executeScenario({
                ...options,
                mode: "resume",
                runId: first.runId,
                expectedIdentity: stored.identity,
            }),
            /identity_mismatch/,
        );
        assert.equal(credentialCalls, 3);
        const current = await readResult(root, "reports", first.runId);
        assert.equal(current.status, "completed");
        assert.equal(current.generation, resumed.generation);
        const checkpoint = await readRun(root, "reports", first.runId);
        assert.ok(
            checkpoint.generations.length >= 3,
            "Failure receipt should be retained without hiding the good generation",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("synthetic work never resolves credentials; preflight cancellation stops before resolution", async () => {
    const root = await workspace();
    let calls = 0;
    const credentialResolver = async () => {
        calls++;
        throw new Error("unexpected_test_credential_retrieval");
    };
    try {
        const synthetic = await executeScenario({
            root,
            config: configSchema.parse({ org: "example-org" }),
            input: {},
            scenario: conformanceScenario,
            synthetic: true,
            transport,
            credentialResolver,
            clock: new TestClock(),
        });

        test("authentication has its own deadline capped by the configured elapsed allowance", async () => {
            const root = await workspace();
            const signal = new AbortController().signal;
            try {
                for (const [maximum, expected] of [[37, 37], [50000, 10000]]) {
                    await assert.rejects(
                        executeScenario({
                            root,
                            config: configSchema.parse({
                                org: "example-org",
                                credential: {
                                    name: "operator-assisted-local",
                                    credentialClass: "oauth",
                                },
                                budgets: { maxElapsedMs: maximum },
                            }),
                            input: {},
                            scenario: conformanceScenario,
                            synthetic: false,
                            live: true,
                            explicitProfile: "operator-assisted-local",
                            signal,
                            credentialResolver: async (request) => {
                                assert.equal(request.host, "github.com");
                                assert.equal(request.signal, signal);
                                assert.equal(request.timeoutMs, expected);
                                throw new Error("gh_auth_failed: Offline test stop");
                            },
                            transport,
                        }),
                        /gh_auth_failed: Offline test stop/,
                    );
                }
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
        assert.equal(synthetic.status, "completed");
        const abort = new AbortController();
        abort.abort();
        await assert.rejects(
            executeScenario({
                root,
                config: configSchema.parse({
                    org: "example-org",
                    credential: {
                        name: "operator-assisted-local",
                        credentialClass: "oauth",
                    },
                }),
                input: {},
                scenario: conformanceScenario,
                synthetic: false,
                live: true,
                explicitProfile: "operator-assisted-local",
                signal: abort.signal,
                credentialResolver,
                transport,
            }),
            /operator_cancelled/,
        );
        assert.equal(calls, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("domain-unknown evidence from a transport-complete response is retried on resume", async () => {
    const root = await workspace();
    let available = false,
        calls = 0;
    const changingTransport: Transport = async () => {
        calls++;
        return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                total_count: 1,
                runners: [{ id: 1, ...(available ? { name: "linux" } : {}) }],
            }),
        };
    };
    const handler: ScenarioDefinition = {
        ...conformanceScenario,
        async handler(input, context) {
            const domain = await conformanceScenario.handler(input, context);
            if (!available)
                domain.work.push({
                    id: "required-runner-name",
                    required: true,
                    outcome: "failed",
                    reasonCode: "source_field_unavailable",
                    evidenceIds: domain.rows.flatMap((row) => row.evidenceIds),
                });
            return domain;
        },
    };
    try {
        const first = await executeScenario({
            root,
            config: configSchema.parse({ org: "example-org" }),
            input: {},
            scenario: handler,
            synthetic: true,
            transport: changingTransport,
            clock: new TestClock(),
        });
        assert.equal(first.status, "partial");
        available = true;
        const next = await executeScenario({
            root,
            config: configSchema.parse({ org: "example-org" }),
            input: {},
            scenario: handler,
            synthetic: true,
            transport: changingTransport,
            clock: new TestClock(),
            mode: "resume",
            runId: first.runId,
        });
        assert.equal(next.status, "completed");
        assert.equal(
            calls,
            2,
            "A complete HTTP container must not freeze a required domain unknown forever",
        );
        assert.ok(
            next.evidence.some((item) => item.id === first.evidence[0]?.id),
            "Original observations remain preserved",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
