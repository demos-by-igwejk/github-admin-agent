import { test } from "node:test";
import assert from "node:assert/strict";
import type {
    ClientOptions,
    Collection,
    Config,
    JsonObject,
    JsonValue,
    OperationArgs,
    OperationId,
    ScenarioContext,
    ScenarioResult,
} from "../../src/core/contracts.ts";
import { deriveStatus } from "../../src/core/status.ts";
import { billingScenario } from "../../src/scenarios/repository-billing-report/index.ts";
import { billingResultSchema } from "../../src/scenarios/repository-billing-report/model.ts";
import { fakeContext, recordingClient, TestClock } from "../helpers.ts";

function usage(overrides: JsonObject = {}): JsonObject {
    return {
        date: "2026-08-15",
        product: "Actions",
        sku: "actions_linux",
        quantity: "1",
        unitType: "minutes",
        pricePerUnit: "0.008",
        grossAmount: "0.008",
        discountAmount: "0",
        netAmount: "0.008",
        organizationName: "example-org",
        repositoryName: "alpha",
        ...overrides,
    };
}
function repo(name = "alpha", overrides: JsonObject = {}): JsonObject {
    return {
        full_name: `example-org/${name}`,
        pushed_at: "2020-01-01T00:00:00Z",
        default_branch: "main",
        has_issues: true,
        ...overrides,
    };
}
function page(
    context: ScenarioContext,
    data: JsonValue,
    operation: OperationId = "billing.usage",
    observedAt = context.clock.now().toISOString(),
) {
    const evidence = context.addEvidence({
        operation,
        target: context.config.org,
        observedAt,
        source: `fixture:${operation}`,
        data,
    });
    return { evidenceId: evidence.id, observedAt, data };
}
function collection(
    context: ScenarioContext,
    data: JsonValue[],
    completeness: Collection["completeness"] = "complete",
): Collection {
    return {
        operation: "billing.usage",
        pages: data.map((value) => page(context, value)),
        completeness,
        problems: [],
    };
}
async function run(
    context: ScenarioContext,
    input: JsonObject = { inventory: false },
) {
    return billingResultSchema.parse(
        await billingScenario.handler(input, context),
    );
}
function status(result: ScenarioResult) {
    return deriveStatus(result.work, {
        usable: result.work.some(
            (unit) => unit.outcome === "valid" && unit.evidenceIds.length > 0,
        ),
    });
}
function setClock(context: ScenarioContext, iso: string): void {
    assert.ok(context.clock instanceof TestClock);
    context.clock.value = Date.parse(iso);
}
function withMonths(
    partitions: Record<string, JsonValue>,
    config: Partial<Config> = {},
) {
    const context = fakeContext({}, config),
        requested: OperationArgs[] = [],
        original = context.client;
    context.client = {
        async collect(operation, args) {
            if (operation !== "billing.usage")
                return original.collect(operation, args);
            requested.push(args);
            assert.ok(args.month);
            const data = partitions[args.month];
            assert.notEqual(data, undefined);
            return collection(context, [data!]);
        },
    };
    return { context, requested };
}

test("billing manifest declares reviewed detailed usage and optional inventory capabilities", () => {
    const manifest = billingScenario.manifest;
    assert.equal(manifest.id, "repository-billing-report");
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.status, "implemented");
    assert.equal(manifest.risk, "read-only");
    assert.deepEqual(manifest.platforms, ["github.com"]);
    assert.deepEqual(manifest.modes, ["inspect"]);
    assert.equal(manifest.views.defaultRows, 10);
    for (const operation of [
        "billing.usage",
        "repositories.list",
        "repositories.get",
        "repositories.properties",
        "activity.issues",
    ]) {
        assert.ok(
            manifest.capabilities.some(
                (capability) => capability.operation === operation,
            ),
        );
    }
    assert.ok(
        manifest.capabilities.every((capability) =>
            capability.reference.startsWith("https://docs.github.com/"),
        ),
    );
    assert.deepEqual(
        manifest.inputs.map((input) => [input.name, input.required]),
        [["owners", false]],
    );
    assert.match(
        manifest.limitations.join(" "),
        /product policy, not an API retention guarantee/,
    );
});

test("billing credential declarations do not assert unverified fine-grained or organization App grants", () => {
    const capability = billingScenario.manifest.capabilities.find(
        (item) => item.operation === "billing.usage",
    );
    assert.ok(capability);
    assert.deepEqual(capability.credentialClasses, [
        "oauth",
        "classic-pat",
        "fine-grained-pat",
        "app-installation",
        "app-user",
    ]);
    const permissions = capability.permissions.join(" ");
    assert.match(
        permissions,
        /classic PAT flow for an organization owner or billing manager/,
    );
    assert.match(permissions, /live grant acceptance is pending/);
    assert.match(
        permissions,
        /Fine-grained PAT and GitHub App grants.*unverified/,
    );
    assert.match(permissions, /OAuth billing authorization.*unverified/);
    assert.match(permissions, /No OAuth scope recipe/);
    assert.doesNotMatch(permissions, /Administration:\s*read/);
    assert.match(
        billingScenario.manifest.limitations.join(" "),
        /enterprise endpoint support does not establish organization endpoint support/,
    );
});

test("billing input is strict, unique, nonoverlapping, bounded product policy; no cross-run inventory reuse", () => {
    const invalid: JsonObject[] = [
        { month: "2026-08" },
        { months: [] },
        { months: "2026-08" },
        { months: ["2026-08", "2026-08"] },
        { months: ["2026-8"] },
        { months: ["2026-08-01"] },
        { months: ["0000-08"] },
        {
            months: [
                "2026-01",
                "2026-02",
                "2026-03",
                "2026-04",
                "2026-05",
                "2026-06",
                "2026-07",
            ],
        },
        { inventory: "false" },
        { inventoryRunId: "old-run" },
        { inventory: true, inventoryPath: "old.json" },
        { enterprise: "example" },
        { days: ["2026-08-01"] },
        { finality: "final" },
        { populationVerified: true },
    ];
    for (const input of invalid)
        assert.equal(
            billingScenario.inputSchema.safeParse(input).success,
            false,
            JSON.stringify(input),
        );
    assert.deepEqual(billingScenario.inputSchema.parse({}), {
        inventory: true,
    });
});

test("default latest complete UTC month composes inventory in the same context after billing", async () => {
    const context = fakeContext({
        "billing.usage": { usageItems: [] },
        "repositories.list": [],
    });
    const originalBudget = context.budget,
        recorded = recordingClient(context.client);
    context.client = recorded.client;
    const result = await run(context, {});
    assert.deepEqual(result.totals.months, ["2026-08"]);
    assert.deepEqual(recorded.operations, [
        "billing.usage",
        "repositories.list",
    ]);
    assert.equal(context.budget, originalBudget);
    assert.equal(result.totals.inventory.requested, true);
    assert.equal(status(result), "completed");
    assert.equal(result.totals.providerFinality, "unknown");
});

test("resume keeps the default billing month at the original run start and refresh gets a new default", async () => {
    const fixture = withMonths({
        "2026-08": { usageItems: [usage()] },
        "2026-10": { usageItems: [usage({ date: "2026-10-15" })] },
    });
    setClock(fixture.context, "2026-11-15T12:00:00.000Z");
    const resumed = await run(fixture.context);
    assert.deepEqual(resumed.totals.months, ["2026-08"]);
    assert.equal(fixture.requested[0]?.month, "2026-08");
    assert.equal(
        resumed.rows[0]?.sourceRows[0]?.observedAt,
        "2026-11-15T12:00:00.000Z",
    );
    fixture.context.startedAt = fixture.context.clock.now().toISOString();
    const refreshed = await run(fixture.context);
    assert.deepEqual(refreshed.totals.months, ["2026-10"]);
    assert.equal(fixture.requested[1]?.month, "2026-10");
});

test("resumed billing and inventory keep their original period policy but validate activity at observation time", async () => {
    const context = fakeContext({
        "billing.usage": { usageItems: [usage()] },
        "repositories.list": [
            repo("alpha", { pushed_at: "2026-10-20T00:00:00Z" }),
        ],
    });
    setClock(context, "2026-11-15T12:00:00.000Z");
    const result = await run(context, { inventory: true });
    assert.deepEqual(result.totals.months, ["2026-08"]);
    assert.equal(
        result.rows[0]?.activityObservation?.cutoff,
        "2026-03-15T12:00:00.000Z",
    );
    assert.equal(result.rows[0]?.activityStatus, "active");
    assert.equal(
        result.rows[0]?.sourceRows[0]?.observedAt,
        "2026-11-15T12:00:00.000Z",
    );
    assert.equal(status(result), "completed");
});

test("incomplete and future months are rejected before collecting any evidence", async () => {
    for (const month of ["2026-09", "2026-10", "2027-01"]) {
        const context = fakeContext();
        const recorded = recordingClient(context.client);
        context.client = recorded.client;
        await assert.rejects(
            () => run(context, { months: [month], inventory: false }),
            /incomplete_month/,
        );
        assert.deepEqual(recorded.operations, []);
    }
    const context = fakeContext({ "billing.usage": { usageItems: [] } });
    setClock(context, "2026-09-30T23:59:59.999Z");
    context.startedAt = context.clock.now().toISOString();
    await assert.rejects(
        () => run(context, { months: ["2026-09"], inventory: false }),
        /incomplete_month/,
    );
    setClock(context, "2026-10-01T00:00:00.000Z");
    await assert.rejects(
        () => run(context, { months: ["2026-09"], inventory: false }),
        /incomplete_month/,
    );
    assert.equal(context.evidence.length, 0);
    context.startedAt = context.clock.now().toISOString();
    assert.equal(
        status(await run(context, { months: ["2026-09"], inventory: false })),
        "completed",
    );
});

test("an invalid original run timestamp cannot silently use the mutable current clock", async () => {
    for (const startedAt of ["invalid", "2026-02-30T12:00:00Z"]) {
        const context = fakeContext();
        context.startedAt = startedAt;
        await assert.rejects(() => run(context), /invalid_run_start/);
        assert.equal(context.evidence.length, 0);
    }
});

test("UTC year rollover and older completed months do not invent API retention", async () => {
    const context = fakeContext({ "billing.usage": { usageItems: [] } });
    setClock(context, "2026-01-01T00:00:00.000Z");
    context.startedAt = context.clock.now().toISOString();
    assert.deepEqual((await run(context)).totals.months, ["2025-12"]);
    const result = await run(context, {
        months: ["2001-01"],
        inventory: false,
    });
    assert.deepEqual(result.totals.months, ["2001-01"]);
    assert.equal(status(result), "completed");
});

test("fractional exponents, huge amounts, signed adjustments and duplicate business rows remain exact", async () => {
    const duplicate = usage({
        quantity: "2e-1",
        pricePerUnit: "0.25",
        grossAmount: "0.2",
        discountAmount: "-0.0075",
        netAmount: "0.2",
    });
    const context = fakeContext({
        "billing.usage": {
            usageItems: [
                usage({
                    quantity: "1e-1",
                    grossAmount: "90071992547409931234567890.100",
                    netAmount: "90071992547409931234567890.100",
                }),
                duplicate,
                duplicate,
                usage({
                    quantity: "-1e-2",
                    grossAmount: "-5e-2",
                    discountAmount: "1e-3",
                    netAmount: "-5e-2",
                }),
            ],
        },
    });
    const result = await run(context),
        row = result.rows[0]!;
    assert.equal(result.rows.length, 1);
    assert.equal(row.netAmount, "90071992547409931234567890.45");
    assert.equal(row.grossAmount, "90071992547409931234567890.45");
    assert.equal(row.discountAmount, "-0.014");
    assert.equal(row.quantity, "0.49");
    assert.equal(row.pricePerUnit, null);
    assert.deepEqual(row.pricePerUnits, ["0.008", "0.25"]);
    assert.equal(row.sourceRows.length, 4);
    assert.equal(row.sourceRows[0]?.quantity, "1e-1");
    assert.equal(
        row.sourceRows[0]?.netAmount,
        "90071992547409931234567890.100",
    );
    assert.deepEqual(
        row.sourceRows.map((source) => source.sourceIndex),
        [0, 1, 2, 3],
    );
    assert.equal(result.totals.allSource[0]?.netAmount, row.netAmount);
    assert.equal(result.totals.reconciliation[0]?.netAmountDelta, "0");
    assert.equal(result.totals.reconciliation[0]?.discountAmountDelta, "0");
    assert.equal(status(result), "completed");
});

test("group identities and ordering do not depend on source row order", async () => {
    const rows = [
        usage({ repositoryName: "bravo" }),
        usage(),
        usage({ sku: "other" }),
        usage({ currency: "EUR" }),
    ];
    const first = await run(
        fakeContext({ "billing.usage": { usageItems: rows } }),
    );
    const second = await run(
        fakeContext({ "billing.usage": { usageItems: [...rows].reverse() } }),
    );
    assert.deepEqual(
        first.rows.map((row) => row.id),
        second.rows.map((row) => row.id),
    );
    assert.equal(new Set(first.rows.map((row) => row.id)).size, 4);
});

test("bounded arithmetic overflow qualifies only unsupported rows without discarding accepted partitions", async () => {
    const fixture = withMonths({
        "2026-07": {
            usageItems: [usage({ date: "2026-07-15", netAmount: "10.01" })],
        },
        "2026-08": {
            usageItems: [
                usage({ netAmount: "1e500" }),
                usage({ netAmount: "1e-500" }),
            ],
        },
    });
    const result = await run(fixture.context, {
        months: ["2026-07", "2026-08"],
        inventory: false,
    });
    assert.equal(result.totals.acceptedSourceRows, 2);
    assert.equal(result.totals.unresolved.rowCount, 1);
    assert.equal(
        result.totals.unresolved.rows[0]?.reasonCode,
        "billing_decimal_range",
    );
    assert.equal(
        result.rows.find((row) => row.month === "2026-07")?.netAmount,
        "10.01",
    );
    assert.equal(
        result.rows.find((row) => row.month === "2026-08")?.netAmount,
        `1${"0".repeat(500)}`,
    );
    assert.equal(
        result.rows.find((row) => row.month === "2026-08")?.amountBasis,
        "observed-partial",
    );
    assert.equal(status(result), "partial");
});

test("precision carried out of an all-source sum cannot overflow an individual repository bucket", async () => {
    const result = await run(
        fakeContext({
            "billing.usage": {
                usageItems: [
                    usage({ netAmount: "1e-500" }),
                    usage({
                        repositoryName: "bravo",
                        netAmount: `0.${"9".repeat(500)}`,
                    }),
                    usage({ netAmount: "1e500" }),
                ],
            },
        }),
    );
    assert.equal(result.totals.acceptedSourceRows, 2);
    assert.equal(result.totals.allSource[0]?.netAmount, "1");
    assert.equal(
        result.totals.unresolved.rows[0]?.reasonCode,
        "billing_decimal_range",
    );
    assert.equal(status(result), "partial");
});

test("currencies and units stay separate and missing currency is never assumed USD", async () => {
    const result = await run(
        fakeContext({
            "billing.usage": {
                usageItems: [
                    usage(),
                    usage({ currency: "USD" }),
                    usage({ currency: "EUR" }),
                    usage({ currency: "USD", unitType: "GB-months" }),
                ],
            },
        }),
    );
    assert.equal(result.rows.length, 4);
    assert.equal(result.totals.allSource.length, 4);
    const missing = result.rows.find((row) => row.currency === null)!;
    assert.equal(missing.currencyProvenance, "not-supplied");
    assert.ok(
        result.rows
            .filter((row) => row.currency !== null)
            .every((row) => row.currencyProvenance === "response"),
    );
    assert.match(result.limitations.join(" "), /cannot be called dollars/);
    assert.equal(result.totals.reconciliation.length, 4);
});

test("source-unattributed Copilot stays unattributed, and owners only enrich explicit repository rows", async () => {
    const noRepository = usage({
        product: "Copilot",
        sku: "copilot-premium",
        repositoryName: null,
        unitType: "requests",
        netAmount: "20",
    });
    const missingRepository = { ...noRepository };
    delete missingRepository.repositoryName;
    const context = fakeContext({
        "billing.usage": {
            usageItems: [usage(), noRepository, missingRepository],
        },
    });
    context.inputs = { owners: { "example-org/alpha": "platform-team" } };
    const result = await run(context);
    const attributed = result.rows.find((row) => row.repository)!;
    const unattributed = result.rows.find(
        (row) => row.bucket === "unattributed",
    )!;
    assert.equal(attributed.ownership, "platform-team");
    assert.equal(unattributed.repository, undefined);
    assert.equal(unattributed.ownership, null);
    assert.equal(unattributed.netAmount, "40");
    assert.equal(unattributed.sourceRows.length, 2);
    assert.equal(result.totals.unattributed[0]?.netAmount, "40");
});

test("null is unresolved rather than zero, while real zero remains accepted and known fields survive", async () => {
    const result = await run(
        fakeContext({
            "billing.usage": {
                usageItems: [
                    usage({
                        netAmount: "0",
                        quantity: "0",
                        grossAmount: "0",
                        discountAmount: "0",
                    }),
                    usage({ netAmount: null, grossAmount: "7" }),
                ],
            },
        }),
    );
    assert.equal(result.rows[0]?.netAmount, "0");
    assert.equal(result.rows[0]?.amountBasis, "observed-partial");
    assert.equal(result.totals.allSource[0]?.netAmount, "0");
    assert.equal(result.totals.unresolved.rows[0]?.netAmount, null);
    assert.equal(result.totals.unresolved.rows[0]?.grossAmount, "7");
    assert.equal(result.totals.unresolved.rows[0]?.bucket, "unresolved");
    assert.equal(result.totals.unresolved.rowCount, 1);
    assert.equal(status(result), "partial");
});

test("malformed required source fields never create valid billing work or fabricated totals", async (t) => {
    const cases: [string, JsonValue][] = [
        ["empty row", {}],
        ["null row", null],
        ["HTML row", "<html>sign in</html>"],
        ["blank product", usage({ product: " " })],
        ["blank SKU", usage({ sku: "" })],
        ["missing unit", usage({ unitType: null })],
        ["missing organization", usage({ organizationName: null })],
        ["wrong organization", usage({ organizationName: "other-org" })],
        [
            "wrong repository organization",
            usage({ repositoryName: "other-org/alpha" }),
        ],
        ["invalid repository", usage({ repositoryName: "../alpha" })],
        ["empty repository", usage({ repositoryName: "" })],
        ["malformed quantity", usage({ quantity: "NaN" })],
        ["non-finite amount", usage({ netAmount: "Infinity" })],
        ["unsafe numeric amount", usage({ netAmount: 9007199254740992 })],
        ["numeric fraction", usage({ netAmount: 0.1 })],
        ["numeric integer", usage({ netAmount: 1 })],
        ["unbounded exponent", usage({ netAmount: "1e1001" })],
        ["unknown quantity", usage({ quantity: null })],
        ["unknown price", usage({ pricePerUnit: null })],
        ["unknown gross", usage({ grossAmount: null })],
        ["unknown discount", usage({ discountAmount: null })],
        ["unknown net", usage({ netAmount: null })],
        ["invalid currency", usage({ currency: "usd" })],
        ["null currency", usage({ currency: null })],
        ["invalid calendar day", usage({ date: "2026-08-32" })],
        ["wrong period", usage({ date: "2026-07-31" })],
        ["non-UTC format", usage({ date: "2026-08-15T00:00:00+01:00" })],
        ["invalid time", usage({ date: "2026-08-15T24:00:00Z" })],
    ];
    const missing = usage();
    delete missing.pricePerUnit;
    cases.push(["missing required price", missing]);
    for (const [name, row] of cases)
        await t.test(name, async () => {
            const result = await run(
                fakeContext({ "billing.usage": { usageItems: [row] } }),
            );
            assert.equal(result.rows.length, 0);
            assert.deepEqual(result.totals.allSource, []);
            assert.equal(result.totals.unresolved.rowCount, 1);
            assert.equal(
                result.work.some((unit) => unit.outcome === "valid"),
                false,
            );
            assert.equal(status(result), "failed");
        });
});

test("wrong envelope shapes are not evidence of an empty partition", async () => {
    const invalid: JsonValue[] = [
        {},
        [],
        null,
        "<html>login</html>",
        { usageItems: {} },
        { totalNetAmount: "10" },
    ];
    for (const data of invalid) {
        const result = await run(fakeContext({ "billing.usage": data }));
        assert.equal(result.rows.length, 0);
        assert.equal(result.totals.unresolved.pageCount, 1);
        assert.equal(result.totals.partitions[0]?.empty, null);
        assert.equal(status(result), "failed");
        assert.ok(
            result.work.some(
                (unit) => unit.reasonCode === "billing_invalid_page",
            ),
        );
    }
});

test("empty observed usage is usable evidence, but a missing response cannot manufacture success", async () => {
    const valid = await run(
        fakeContext({ "billing.usage": { usageItems: [] } }),
    );
    assert.equal(valid.rows.length, 0);
    assert.deepEqual(valid.totals.allSource, []);
    assert.equal(valid.totals.partitions[0]?.empty, true);
    assert.equal(status(valid), "completed");
    assert.ok(
        valid.work.every(
            (unit) =>
                unit.required &&
                unit.outcome === "valid" &&
                unit.evidenceIds.length > 0,
        ),
    );
    const absent: Collection = {
        operation: "billing.usage",
        pages: [],
        completeness: "complete",
        problems: [],
    };
    const invalid = await run(fakeContext({ "billing.usage": absent }));
    assert.equal(status(invalid), "failed");
    assert.ok(
        invalid.work.some(
            (unit) => unit.reasonCode === "billing_missing_evidence",
        ),
    );
});

test("case-insensitive organization and repository scope, UTC dates and ISO timestamps are explicit", async () => {
    const result = await run(
        fakeContext({
            "billing.usage": {
                usageItems: [
                    usage({
                        organizationName: "EXAMPLE-ORG",
                        repositoryName: "Example-Org/Alpha",
                        date: "2026-08-01T00:00:00Z",
                    }),
                    usage({ date: "2026-08-31T23:59:59.999999Z" }),
                    usage({ date: "2026-08-31" }),
                ],
            },
        }),
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.repository, "example-org/alpha");
    assert.equal(result.rows[0]?.sourceRows.length, 3);
    assert.equal(status(result), "completed");
    const february = withMonths({
        "2024-02": { usageItems: [usage({ date: "2024-02-30" })] },
    });
    assert.equal(
        status(
            await run(february.context, {
                months: ["2024-02"],
                inventory: false,
            }),
        ),
        "failed",
    );
});

test("outer year, month, day and scope metadata cannot contradict the requested monthly partition", async () => {
    const matching = await run(
        fakeContext({
            "billing.usage": {
                year: "2026",
                month: 8,
                day: "0",
                organizationName: "EXAMPLE-ORG",
                usageItems: [usage()],
            },
        }),
    );
    assert.equal(status(matching), "completed");
    const bad: JsonObject[] = [
        { year: 2025 },
        { month: "7" },
        { year: null },
        { day: 1 },
        { day: null },
        { organizationName: "elsewhere" },
        { costCenterId: "center-1" },
        { enterpriseName: "enterprise" },
    ];
    for (const metadata of bad) {
        const result = await run(
            fakeContext({
                "billing.usage": { ...metadata, usageItems: [usage()] },
            }),
        );
        assert.equal(status(result), "failed");
        assert.equal(result.totals.acceptedSourceRows, 0);
        assert.ok(
            result.work.some(
                (unit) => unit.reasonCode === "billing_partition_mismatch",
            ),
        );
    }
});

test("valid monthly partitions survive malformed siblings and partitions remain disjoint", async () => {
    const fixture = withMonths({
        "2026-08": {},
        "2026-07": {
            usageItems: [usage({ date: "2026-07-31", netAmount: "13.05" })],
        },
    });
    const result = await run(fixture.context, {
        months: ["2026-08", "2026-07"],
        inventory: false,
    });
    assert.deepEqual(
        fixture.requested.map((args) => args.month),
        ["2026-07", "2026-08"],
    );
    assert.equal(result.rows[0]?.month, "2026-07");
    assert.equal(result.rows[0]?.netAmount, "13.05");
    assert.equal(result.rows[0]?.amountBasis, "observed-accepted");
    assert.equal(result.totals.unresolved.partitionCount, 1);
    assert.equal(
        result.work.filter(
            (unit) => unit.id.endsWith(":partition") && unit.required,
        ).length,
        2,
    );
    assert.equal(result.coverage.pagination, "partial");
    assert.ok(result.coverage.unassessed.includes("billing:2026-08"));
    assert.equal(status(result), "partial");
});

test("repeated evidence pages are ingested once but equal business rows on distinct pages remain", async () => {
    const context = fakeContext();
    const first = page(context, { usageItems: [usage()] }),
        second = page(context, { usageItems: [usage()] });
    context.client = {
        async collect() {
            return {
                operation: "billing.usage",
                pages: [first, first, second],
                completeness: "complete",
                problems: [],
            };
        },
    };
    const result = await run(context);
    assert.equal(result.rows[0]?.sourceRows.length, 2);
    assert.equal(result.rows[0]?.netAmount, "0.016");
    assert.equal(result.totals.partitions[0]?.acceptedPages, 2);
    assert.equal(status(result), "completed");
});

test("reused evidence identity across monthly partitions is rejected rather than counted twice", async () => {
    const context = fakeContext(),
        same = page(context, { usageItems: [] });
    context.client = {
        async collect() {
            return {
                operation: "billing.usage",
                pages: [same],
                completeness: "complete",
                problems: [],
            };
        },
    };
    const result = await run(context, {
        months: ["2026-07", "2026-08"],
        inventory: false,
    });
    assert.equal(result.totals.partitions[0]?.empty, true);
    assert.equal(result.totals.partitions[1]?.completeness, "none");
    assert.ok(
        result.work.some(
            (unit) => unit.reasonCode === "billing_overlapping_evidence",
        ),
    );
    assert.equal(status(result), "partial");
});

test("unsupported continuation retains valid observed partial amounts and actionable source diagnostics", async () => {
    const context = fakeContext(),
        response = collection(
            context,
            [{ usageItems: [usage({ netAmount: "-3.005" })] }],
            "partial",
        );
    const diagnostic = context.addDiagnostic({
        code: "unsupported_continuation",
        message: "Detailed billing signalled an unmodelled next page.",
        operation: "billing.usage",
        target: "example-org:2026-08",
        retryable: false,
        remediation:
            "Review the billing continuation contract before refreshing.",
        evidenceId: response.pages[0]!.evidenceId,
    });
    response.problems.push({ kind: "unsupported-continuation", diagnostic });
    context.client = {
        async collect() {
            return response;
        },
    };
    const result = await run(context);
    assert.equal(result.rows[0]?.netAmount, "-3.005");
    assert.equal(result.rows[0]?.amountBasis, "observed-partial");
    assert.equal(result.totals.allSource[0]?.amountBasis, "observed-partial");
    assert.ok(result.rows[0]?.diagnosticIds.includes(diagnostic.id));
    assert.equal(result.coverage.pagination, "partial");
    assert.equal(status(result), "partial");
    assert.match(
        result.limitations.join(" "),
        /neither complete partition totals nor bounds/,
    );
});

test("unmodelled response-body continuation is not silently accepted as complete", async () => {
    const result = await run(
        fakeContext({
            "billing.usage": {
                usageItems: [usage()],
                nextPageToken: "opaque-next",
            },
        }),
    );
    assert.equal(result.rows[0]?.sourceRowCount, 1);
    assert.equal(result.rows[0]?.amountBasis, "observed-partial");
    assert.ok(
        result.work.some(
            (unit) => unit.reasonCode === "unsupported_billing_continuation",
        ),
    );
    assert.equal(status(result), "partial");
});

test("source-operation and observation-time contradictions do not become valid billing evidence", async () => {
    const context = fakeContext();
    const response = collection(context, [{ usageItems: [usage()] }]);
    response.operation = "repositories.list";
    context.client = {
        async collect() {
            return response;
        },
    };
    assert.equal(status(await run(context)), "failed");
    response.operation = "billing.usage";
    response.pages[0]!.observedAt = "2026-02-30T00:00:00Z";
    const result = await run(context);
    assert.equal(status(result), "failed");
    assert.ok(
        result.work.some(
            (unit) => unit.reasonCode === "billing_invalid_provenance",
        ),
    );
});

test("repository selection beyond the default view budget retains every row and all-source accounting", async () => {
    const context = fakeContext(
        {},
        {
            selection: {
                repositories: ["example-org/repo-14"],
                properties: {},
            },
        },
    );
    const items = Array.from({ length: 15 }, (_, index) =>
        usage({
            repositoryName: `repo-${String(index).padStart(2, "0")}`,
            netAmount: "1",
        }),
    );
    const response = collection(context, [
        { usageItems: items.slice(0, 10) },
        { usageItems: items.slice(10) },
    ]);
    context.client = {
        async collect() {
            return response;
        },
    };
    const result = await run(context);
    assert.equal(result.rows.length, 15);
    assert.equal(
        result.rows.filter((row) => row.bucket === "included").length,
        1,
    );
    assert.equal(
        result.rows.find((row) => row.bucket === "included")?.repository,
        "example-org/repo-14",
    );
    assert.equal(result.totals.allSource[0]?.netAmount, "15");
    assert.equal(result.totals.included[0]?.netAmount, "1");
    assert.equal(result.totals.excluded_by_selection[0]?.netAmount, "14");
    assert.equal(result.totals.reconciliation[0]?.netAmountDelta, "0");
});

test("explicitly empty declared scope excludes all attributed charges without repository reads", async () => {
    const propertySets: Record<string, string>[] = [{}, { team: "platform" }];
    for (const inventory of [true, false])
        for (const properties of propertySets) {
            const context = fakeContext(
                {
                    "billing.usage": {
                        usageItems: [
                            usage({ netAmount: "3" }),
                            usage({ repositoryName: "bravo", netAmount: "5" }),
                            usage({
                                product: "Copilot",
                                repositoryName: null,
                                unitType: "seats",
                                netAmount: "7",
                            }),
                        ],
                    },
                },
                {
                    selection: {
                        mode: "declared-targets",
                        repositories: [],
                        properties,
                    },
                },
            );
            const recorded = recordingClient(context.client);
            context.client = recorded.client;
            const result = await run(context, { inventory });
            assert.deepEqual(recorded.operations, ["billing.usage"]);
            assert.equal(result.rows.length, 3);
            assert.ok(
                result.rows
                    .filter((row) => row.repository !== undefined)
                    .every(
                        (row) =>
                            row.bucket === "excluded_by_selection" &&
                            row.selectionStatus === "excluded",
                    ),
            );
            assert.deepEqual(result.totals.included, []);
            assert.equal(
                result.totals.excluded_by_selection[0]?.netAmount,
                "8",
            );
            assert.equal(result.totals.unattributed[0]?.netAmount, "7");
            assert.equal(
                result.totals.allSource.find(
                    (total) => total.unit === "minutes",
                )?.netAmount,
                "8",
            );
            assert.equal(
                result.totals.allSource.find((total) => total.unit === "seats")
                    ?.netAmount,
                "7",
            );
            assert.deepEqual(result.totals.selectionUnresolved, []);
            assert.ok(
                result.work
                    .filter((unit) => unit.outcome === "valid")
                    .every((unit) => unit.evidenceIds.length > 0),
            );
            if (inventory) {
                assert.equal(result.coverage.discovery, "declared-targets");
                assert.equal(result.coverage.requested, 0);
                assert.equal(result.coverage.observed, 0);
                assert.ok(
                    context.evidence.some(
                        (evidence) => evidence.source === "input:selection",
                    ),
                );
            }
            assert.equal(status(result), "completed");
        }
});

test("empty API-visible and legacy unspecified selections remain unfiltered", async () => {
    for (const mode of [undefined, "api-visible"] as const) {
        const context = fakeContext(
            { "billing.usage": { usageItems: [usage()] } },
            {
                selection: {
                    ...(mode ? { mode } : {}),
                    repositories: [],
                    properties: {},
                },
            },
        );
        const result = await run(context);
        assert.equal(result.rows[0]?.bucket, "included");
        assert.equal(result.rows[0]?.selectionStatus, "unfiltered");
        assert.deepEqual(result.totals.excluded_by_selection, []);
        assert.equal(status(result), "completed");
    }
});

test("inventory:false performs no repository reads even with enabled activity signals", async () => {
    const context = fakeContext(
        { "billing.usage": { usageItems: [usage()] } },
        {
            activity: {
                name: "full",
                window: { kind: "days", value: 30 },
                signals: ["issues", "commits"],
                positiveShortCircuit: false,
                clockSkewSeconds: 60,
            },
        },
    );
    const recorded = recordingClient(context.client);
    context.client = recorded.client;
    const result = await run(context);
    assert.deepEqual(recorded.operations, ["billing.usage"]);
    assert.equal(result.rows[0]?.activityStatus, "unknown");
    assert.equal(result.rows[0]?.activityReason, "inventory_not_requested");
    assert.equal(status(result), "completed");
});

test("inactive charges and repositories absent from current inventory remain source-attributed", async () => {
    const context = fakeContext({
        "billing.usage": {
            usageItems: [
                usage(),
                usage({ repositoryName: "deleted-or-hidden" }),
            ],
        },
        "repositories.list": [repo()],
    });
    const result = await run(context, { inventory: true });
    assert.equal(
        result.rows.find((row) => row.repository === "example-org/alpha")
            ?.activityStatus,
        "inactive",
    );
    const missing = result.rows.find(
        (row) => row.repository === "example-org/deleted-or-hidden",
    )!;
    assert.equal(missing.activityStatus, "unknown");
    assert.equal(missing.bucket, "included");
    assert.equal(
        missing.activityReason,
        "repository_not_observed_in_current_inventory",
    );
    assert.equal(result.totals.acceptedSourceRows, 2);
    assert.equal(status(result), "completed");
});

test("required Issues denial keeps billing and the specific diagnostic, evidence and remediation", async () => {
    const context = fakeContext(
        {
            "billing.usage": { usageItems: [usage({ netAmount: "4.50" })] },
            "repositories.list": [repo()],
        },
        {
            activity: {
                name: "push-and-issues",
                window: { kind: "calendar-months", value: 6 },
                signals: ["push", "issues"],
                positiveShortCircuit: false,
                clockSkewSeconds: 60,
            },
        },
    );
    const denied = page(
        context,
        { message: "Resource not accessible by integration" },
        "activity.issues",
    );
    const diagnostic = context.addDiagnostic({
        code: "issues_permission_denied",
        message:
            "The enabled Issues signal needs repository Issues read permission.",
        operation: "activity.issues",
        target: "example-org/alpha",
        status: 403,
        requestId: "fixture-request",
        retryable: false,
        remediation: "Grant Issues read access for this repository and resume.",
        evidenceId: denied.evidenceId,
    });
    const original = context.client;
    context.client = {
        async collect(operation, args) {
            if (operation === "activity.issues")
                return {
                    operation,
                    pages: [],
                    completeness: "none",
                    problems: [{ kind: "denied", diagnostic }],
                };
            return original.collect(operation, args);
        },
    };
    const result = await run(context, { inventory: true });
    assert.equal(result.rows[0]?.netAmount, "4.5");
    assert.equal(result.rows[0]?.activityStatus, "unknown");
    assert.equal(result.rows[0]?.activityReason, "issues_permission_denied");
    assert.ok(result.rows[0]?.diagnosticIds.includes(diagnostic.id));
    assert.ok(
        result.totals.inventory.reasonCodes.includes(
            "issues_permission_denied",
        ),
    );
    assert.ok(
        result.totals.inventory.diagnostics.some(
            (item) =>
                item.id === diagnostic.id &&
                item.status === 403 &&
                item.remediation.includes("Issues read"),
        ),
    );
    assert.ok(
        result.work.some(
            (unit) =>
                unit.required &&
                unit.reasonCode === "issues_permission_denied" &&
                unit.evidenceIds.includes(denied.evidenceId),
        ),
    );
    assert.equal(result.totals.partitions[0]?.completeness, "complete");
    assert.equal(status(result), "partial");
});

test("inventory collection exceptions cannot discard already validated billing", async () => {
    const context = fakeContext({ "billing.usage": { usageItems: [usage()] } });
    const original = context.client;
    context.client = {
        async collect(operation, args) {
            if (operation === "repositories.list")
                throw new Error("test inventory collector failure");
            return original.collect(operation, args);
        },
    };
    const result = await run(context, { inventory: true });
    assert.equal(result.rows[0]?.netAmount, "0.008");
    assert.ok(
        result.totals.inventory.reasonCodes.includes(
            "inventory_collection_failure",
        ),
    );
    assert.equal(result.coverage.pagination, "partial");
    assert.equal(status(result), "partial");
});

test("organization inventory denial retains its diagnostic on each source-attributed charge", async () => {
    const context = fakeContext({ "billing.usage": { usageItems: [usage()] } });
    const denied = page(context, { message: "Forbidden" }, "repositories.list");
    const diagnostic = context.addDiagnostic({
        code: "repository_visibility_denied",
        message:
            "Organization repositories are not visible to this credential.",
        operation: "repositories.list",
        target: "example-org",
        status: 403,
        retryable: false,
        remediation: "Grant repository metadata visibility and resume.",
        evidenceId: denied.evidenceId,
    });
    const original = context.client;
    context.client = {
        async collect(operation, args) {
            return operation === "repositories.list"
                ? {
                      operation,
                      pages: [],
                      completeness: "none",
                      problems: [{ kind: "denied", diagnostic }],
                  }
                : original.collect(operation, args);
        },
    };
    const result = await run(context, { inventory: true });
    assert.equal(result.rows[0]?.netAmount, "0.008");
    assert.equal(result.rows[0]?.bucket, "included");
    assert.equal(result.rows[0]?.activityStatus, "unknown");
    assert.equal(result.rows[0]?.activityReason, diagnostic.code);
    assert.ok(result.rows[0]?.diagnosticIds.includes(diagnostic.id));
    assert.equal(status(result), "partial");
});

test("billing source observation, financial period, current cutoff and activity observations stay distinct", async () => {
    const context = fakeContext({ "repositories.list": [repo()] });
    const earlier = page(
        context,
        { usageItems: [usage({ date: "2026-08-04" })] },
        "billing.usage",
        "2026-09-01T00:10:00.000Z",
    );
    const original = context.client;
    context.client = {
        async collect(operation, args) {
            return operation === "billing.usage"
                ? {
                      operation,
                      pages: [earlier],
                      completeness: "complete",
                      problems: [],
                  }
                : original.collect(operation, args);
        },
    };
    const result = await run(context, { inventory: true }),
        row = result.rows[0]!;
    assert.equal(row.periodStart, "2026-08-01T00:00:00.000Z");
    assert.equal(row.periodEnd, "2026-09-01T00:00:00.000Z");
    assert.equal(row.sourceRows[0]?.date, "2026-08-04");
    assert.equal(row.sourceRows[0]?.observedAt, "2026-09-01T00:10:00.000Z");
    assert.equal(row.activityObservation?.cutoff, "2026-03-15T12:00:00.000Z");
    const signals = row.activityObservation?.signals;
    assert.ok(Array.isArray(signals));
    const push = signals.find(
        (signal) =>
            signal !== null &&
            typeof signal === "object" &&
            !Array.isArray(signal) &&
            signal.name === "push",
    );
    assert.ok(
        push !== null && typeof push === "object" && !Array.isArray(push),
    );
    assert.equal(push.observedAt, "2026-09-15T12:00:00.000Z");
    assert.equal(push.latestAt, "2020-01-01T00:00:00Z");
    assert.match(result.limitations.join(" "), /not historical activity/);
});

test("prepared owner maps and property/inventory contradictions fail before source requests", async () => {
    const context = fakeContext(),
        recorded = recordingClient(context.client);
    context.client = recorded.client;
    const invalid: JsonValue[] = [
        "config/owners.csv",
        { "other-org/alpha": "team" },
        { "example-org/alpha": "team", "EXAMPLE-ORG/ALPHA": "other" },
    ];
    for (const owners of invalid) {
        context.inputs = { owners };
        await assert.rejects(() => run(context));
    }
    assert.deepEqual(recorded.operations, []);
    const selected = fakeContext(
        {},
        { selection: { repositories: [], properties: { team: "platform" } } },
    );
    await assert.rejects(() => run(selected), /conflicting_selection/);
    assert.equal(selected.evidence.length, 0);
});

test("only proven property mismatches exclude spend; unresolved selection remains explicit", async () => {
    const context = fakeContext(
        {
            "billing.usage": {
                usageItems: [
                    usage(),
                    usage({ repositoryName: "not-currently-visible" }),
                ],
            },
            "repositories.list": [
                repo("alpha", { custom_properties: { team: "other" } }),
            ],
        },
        { selection: { repositories: [], properties: { team: "platform" } } },
    );
    const result = await run(context, { inventory: true });
    assert.equal(
        result.rows.find((row) => row.repository === "example-org/alpha")
            ?.bucket,
        "excluded_by_selection",
    );
    const unresolved = result.rows.find(
        (row) => row.repository === "example-org/not-currently-visible",
    )!;
    assert.equal(unresolved.bucket, "included");
    assert.equal(unresolved.selectionStatus, "unknown");
    assert.deepEqual(result.totals.selectionUnresolved, [
        "example-org/not-currently-visible",
    ]);
    assert.equal(result.totals.allSource[0]?.netAmount, "0.016");
    assert.equal(status(result), "partial");
});

test("an explicit inventory assessment cap is not a financial selection exclusion", async () => {
    const context = fakeContext(
        {
            "billing.usage": {
                usageItems: [usage({ repositoryName: "bravo" })],
            },
            "repositories.list": [repo(), repo("bravo")],
        },
        { selection: { repositories: [], properties: {}, maxAssessments: 1 } },
    );
    const result = await run(context, { inventory: true });
    assert.equal(result.rows[0]?.bucket, "included");
    assert.equal(result.rows[0]?.activityStatus, "unknown");
    assert.equal(result.totals.excluded_by_selection.length, 0);
    assert.equal(status(result), "completed");
});

test("result schema validates substantive exact rows, totals, evidence and partitions", async () => {
    const result = await run(
        fakeContext({ "billing.usage": { usageItems: [usage()] } }),
    );
    const badRow = structuredClone(result);
    badRow.rows[0]!.netAmount = "0.1";
    const badTotal = structuredClone(result);
    badTotal.totals.allSource[0]!.netAmount = "0.1";
    const badEvidence = structuredClone(result);
    badEvidence.rows[0]!.evidenceIds = [];
    const badPartition = structuredClone(result);
    badPartition.totals.partitions[0]!.acceptedRows = 9;
    const duplicated = structuredClone(result);
    duplicated.rows.push(structuredClone(duplicated.rows[0]!));
    const badDecimal = structuredClone(result);
    badDecimal.rows[0]!.sourceRows[0]!.netAmount = "not-a-number";
    const badAttribution = structuredClone(result);
    badAttribution.rows[0]!.sourceRows[0]!.repositoryName = "other-repository";
    const unsupportedMonth = structuredClone(result);
    unsupportedMonth.totals.months = ["2026-07"];
    for (const invalid of [
        badRow,
        badTotal,
        badEvidence,
        badPartition,
        duplicated,
        badDecimal,
        badAttribution,
        unsupportedMonth,
        { ...result, success: true },
    ]) {
        assert.equal(
            billingScenario.resultSchema.safeParse(invalid).success,
            false,
        );
    }
});

test("injected production transport preserves numeric lexemes without promoting assurance", async () => {
    const { createClient } = await import("../../src/core/client.ts");
    const context = fakeContext(),
        urls: string[] = [];
    const body =
        '{"usageItems":[{"date":"2026-08-15","product":"Actions","sku":"actions_linux","quantity":1e-2,"unitType":"minutes","pricePerUnit":0.008,"grossAmount":9007199254740993.12345,"discountAmount":-0.00005,"netAmount":9007199254740993.12350,"organizationName":"example-org","repositoryName":"alpha"}]}';
    const options: ClientOptions = {
        host: "github.com",
        org: "example-org",
        capabilities: ["billing.usage"],
        budget: context.budget,
        clock: context.clock,
        signal: context.signal,
        synthetic: true,
        addEvidence: (value) => context.addEvidence(value),
        addDiagnostic: (value) => context.addDiagnostic(value),
        transport: async (request) => {
            urls.push(request.url);
            return {
                status: 200,
                headers: { "content-type": "application/json" },
                body,
            };
        },
    };
    context.client = createClient(options);
    const result = await run(context);
    assert.equal(urls.length, 1);
    const url = new URL(urls[0]!);
    assert.equal(
        url.pathname,
        "/organizations/example-org/settings/billing/usage",
    );
    assert.equal(url.searchParams.get("year"), "2026");
    assert.equal(url.searchParams.get("month"), "8");
    assert.equal(result.rows[0]?.netAmount, "9007199254740993.1235");
    assert.equal(result.rows[0]?.discountAmount, "-0.00005");
    assert.equal(result.rows[0]?.quantity, "0.01");
    assert.equal(result.rows[0]?.sourceRows[0]?.quantity, "1e-2");
    assert.equal(
        result.rows[0]?.sourceRows[0]?.netAmount,
        "9007199254740993.12350",
    );
    assert.equal(result.rows[0]?.currency, null);
    assert.equal(result.totals.providerFinality, "unknown");
    assert.equal(status(result), "completed");
    assert.ok(context.evidence.every((evidence) => evidence.synthetic));
});

test("production-client unsupported or escaped continuation retains source evidence without following links", async () => {
    const { createClient } = await import("../../src/core/client.ts");
    for (const next of [
        "https://api.github.com/organizations/example-org/settings/billing/usage?year=2026&month=8&page=2",
        "https://unapproved.invalid/organizations/other-org/settings/billing/usage?year=2026&month=8",
    ]) {
        const context = fakeContext(),
            calls: string[] = [];
        context.client = createClient({
            host: "github.com",
            org: "example-org",
            capabilities: ["billing.usage"],
            budget: context.budget,
            clock: context.clock,
            signal: context.signal,
            synthetic: true,
            addEvidence: (value) => context.addEvidence(value),
            addDiagnostic: (value) => context.addDiagnostic(value),
            transport: async (request) => {
                calls.push(request.url);
                return {
                    status: 200,
                    headers: {
                        "content-type": "application/json",
                        link: `<${next}>; rel="next"`,
                    },
                    body: JSON.stringify({ usageItems: [usage()] }),
                };
            },
        });
        const result = await run(context);
        assert.equal(calls.length, 1);
        assert.equal(result.rows[0]?.sourceRowCount, 1);
        assert.equal(result.rows[0]?.amountBasis, "observed-partial");
        assert.equal(result.coverage.pagination, "partial");
        assert.ok(
            result.work.some(
                (unit) =>
                    unit.outcome === "failed" &&
                    /continuation|pagination|scope/.test(unit.reasonCode ?? ""),
            ),
        );
        assert.ok(
            context.diagnostics.some(
                (diagnostic) => diagnostic.evidenceId !== undefined,
            ),
        );
        assert.equal(status(result), "partial");
    }
});
