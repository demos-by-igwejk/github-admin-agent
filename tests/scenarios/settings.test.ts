import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsScenario } from "../../src/scenarios/repository-settings-audit/index.ts";
import { fakeContext, recordingClient } from "../helpers.ts";
import { deriveStatus } from "../../src/core/status.ts";
import { configSchema, type JsonValue } from "../../src/core/contracts.ts";

function context(repo: Record<string, JsonValue>) {
    const value = fakeContext({
        "repositories.list": [repo],
        "repositories.get": repo,
    });
    return {
        ...value,
        inputs: {
            policy: {
                schemaVersion: "1",
                name: "example-policy",
                rules: [
                    {
                        id: "visibility",
                        setting: "visibility",
                        expected: "private",
                    },
                    {
                        id: "branch",
                        setting: "default_branch",
                        expected: "main",
                    },
                    {
                        id: "delete-branches",
                        setting: "delete_branch_on_merge",
                        expected: true,
                    },
                ],
            },
        },
    };
}
test("settings baseline compares matches and drift without mutations or copied request loops", async () => {
    const ctx = context({
        full_name: "example-org/api",
        visibility: "private",
        default_branch: "master",
        delete_branch_on_merge: true,
    });
    const recording = recordingClient(ctx.client);
    ctx.client = recording.client;
    const result = await settingsScenario.handler({}, ctx);
    assert.deepEqual(
        result.rows.map((row) => row.outcome),
        ["drift", "compliant", "compliant"],
    );
    assert.equal(deriveStatus(result.work, { usable: true }), "completed");
    assert.deepEqual(recording.operations, ["repositories.list"]);
    settingsScenario.resultSchema.parse(result);
});
test("missing fields are unknown with actionable diagnostics, not drift", async () => {
    const ctx = context({
        full_name: "example-org/api",
        visibility: "private",
        default_branch: "main",
    });
    const result = await settingsScenario.handler({}, ctx);
    assert.equal(result.totals.unknown, 1);
    assert.equal(result.totals.drift, 0);
    assert.equal(deriveStatus(result.work, { usable: true }), "partial");
    assert.ok(
        ctx.diagnostics.some(
            (item) => item.code === "settings_field_unavailable",
        ),
    );
});
test("unsupported baseline vocabulary is rejected instead of inventing a setting", async () => {
    const ctx = context({ full_name: "example-org/api" });
    ctx.inputs.policy.rules[0]!.setting = "automatic_archival";
    await assert.rejects(settingsScenario.handler({}, ctx));
});
test("scope-limited rules yield explicit not-applicable findings", async () => {
    const ctx = fakeContext({
        "repositories.list": [
            { full_name: "example-org/api", archived: false },
        ],
    });
    const result = await settingsScenario.handler(
        {},
        {
            ...ctx,
            inputs: {
                policy: {
                    schemaVersion: "1",
                    name: "scoped",
                    rules: [
                        {
                            id: "archived",
                            setting: "archived",
                            expected: true,
                            repositories: ["example-org/legacy"],
                        },
                    ],
                },
            },
        },
    );
    assert.equal(result.rows[0]?.outcome, "not_applicable");
    assert.equal(deriveStatus(result.work, { usable: true }), "completed");
});
test("denied declared target produces unknown per rule, not empty compliance", async () => {
    const config = configSchema.parse({
        org: "example-org",
        selection: { repositories: ["example-org/api"] },
    });
    const ctx = context({ full_name: "example-org/api" });
    ctx.config = config;
    ctx.client = {
        async collect(operation) {
            return {
                operation,
                pages: [],
                completeness: "none",
                problems: [
                    {
                        kind: "denied",
                        diagnostic: {
                            id: "denied",
                            code: "permission_denied",
                            message: "Denied",
                            retryable: false,
                            remediation: "Correct authorization.",
                        },
                    },
                ],
            };
        },
    };
    const result = await settingsScenario.handler({}, ctx);
    assert.equal(result.rows.length, 3);
    assert.ok(result.rows.every((row) => row.outcome === "unknown"));
    assert.equal(deriveStatus(result.work, { usable: false }), "failed");
});
test("available settings metadata is evaluated after the request allowance is exhausted", async () => {
    const ctx = context({
        full_name: "example-org/api",
        visibility: "private",
        default_branch: "main",
        delete_branch_on_merge: true,
    });
    let calls = 0;
    const original = ctx.client;
    ctx.client = {
        async collect(operation, args) {
            if (++calls > 1) throw new Error("Unexpected deep read");
            return original.collect(operation, args);
        },
    };
    const result = await settingsScenario.handler({}, ctx);
    assert.equal(result.totals.compliant, 3);
    assert.equal(calls, 1);
});
