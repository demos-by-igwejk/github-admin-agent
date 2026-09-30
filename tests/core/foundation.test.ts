import { test } from "node:test";
import assert from "node:assert/strict";
import {
    configSchema,
    scenarioResultSchema,
} from "../../src/core/contracts.ts";
import { addDecimal, decimal, sumDecimals } from "../../src/core/decimal.ts";
import {
    activityCutoff,
    lastCompletedMonth,
    monthBounds,
    observedTimestamp,
} from "../../src/core/time.ts";
import { deriveStatus } from "../../src/core/status.ts";
import { csvText, redact } from "../../src/core/redact.ts";

test("strict configuration rejects extra claims, unsafe hosts and credentials in inputs", () => {
    assert.throws(() =>
        configSchema.parse({ org: "example-org", host: "example.ghe.com" }),
    );
    assert.throws(() =>
        configSchema.parse({ org: "example-org", populationVerified: true }),
    );
    assert.throws(() =>
        configSchema.parse({ org: "example-org", token: "a-secret" }),
    );
    assert.equal(
        configSchema.parse({ org: "example-org" }).budgets.maxAttempts,
        1000,
    );
});
test("exact decimal arithmetic retains adjustments and large fractional values", () => {
    assert.equal(sumDecimals(["0.1", "0.2", "-0.05"]), "0.25");
    assert.equal(
        addDecimal("999999999999999999.999", "0.001"),
        "1000000000000000000",
    );
    assert.equal(decimal("1.2300e-2"), "0.0123");
    assert.equal(decimal("-0.000"), "0");
    assert.throws(() => decimal("NaN"));
});
test("UTC calendar boundaries and observation-time validation", () => {
    const policy = configSchema.parse({
        org: "example-org",
        activity: { window: { kind: "calendar-months", value: 1 } },
    }).activity;
    assert.equal(
        activityCutoff(new Date("2024-03-31T12:00:00Z"), policy),
        "2024-02-29T12:00:00.000Z",
    );
    assert.equal(
        lastCompletedMonth(new Date("2026-01-15T00:00:00Z")),
        "2025-12",
    );
    assert.throws(() =>
        monthBounds("2026-09", new Date("2026-09-30T00:00:00Z")),
    );
    assert.equal(
        observedTimestamp("2026-09-15T12:30:00Z", "2026-09-15T13:00:00Z", 60),
        "2026-09-15T12:30:00Z",
    );
});
test("execution status is independent of assurance and mixed wait deadlines", () => {
    const valid = {
        id: "one",
        required: true,
        outcome: "valid" as const,
        evidenceIds: ["e1"],
    };
    const failed = { ...valid, id: "two", outcome: "failed" as const };
    const waiting = { ...valid, id: "three", outcome: "waiting" as const };
    assert.equal(deriveStatus([valid], { usable: true }), "completed");
    assert.equal(deriveStatus([waiting], { usable: false }), "deferred");
    assert.equal(
        deriveStatus([valid, failed, waiting], { usable: true }),
        "partial",
    );
    assert.equal(deriveStatus([failed], { usable: false }), "failed");
    assert.equal(
        deriveStatus([failed], { usable: false, cancelled: true }),
        "cancelled",
    );
});
test("non-repository result contract needs neither repository nor monetary fields", () => {
    const result = scenarioResultSchema.parse({
        rows: [{ id: "runner-1", label: "linux", evidenceIds: ["e1"] }],
        totals: { observed: 1 },
        work: [
            {
                id: "runner-discovery",
                required: true,
                outcome: "valid",
                evidenceIds: ["e1"],
            },
        ],
        coverage: {
            discovery: "not-applicable",
            requested: null,
            observed: 1,
            assessed: 1,
            pagination: "complete",
            excluded: [],
            unassessed: [],
            notes: [],
        },
        limitations: [],
    });
    assert.equal(result.rows[0]?.repository, undefined);
});
test("data hygiene redacts before export and protects text formulas", () => {
    assert.deepEqual(
        redact({
            authorization: "anything",
            message: "Bearer abcdefghijklmnop",
        }),
        { authorization: "[REDACTED]", message: "[REDACTED]" },
    );
    assert.equal(csvText(" =SUM(1,2)"), '"\' =SUM(1,2)"');
});
