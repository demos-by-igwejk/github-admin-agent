import { z } from "zod";
import { SUMMARY_BYTES } from "./contracts.ts";
import type {
    JsonObject,
    JsonValue,
    ResultEnvelope,
    ResultView,
    ScenarioRow,
    ViewOptions,
} from "./contracts.ts";
import { digest } from "./redact.ts";
import {
    counterSchema,
    envelopeSchema,
    hashSchema,
    safeIdSchema,
    sanitize,
    validate,
} from "./storage-schemas.ts";
import { parseJson } from "./paths.ts";

export const numericFields = new Set([
    "amount",
    "quantity",
    "grossamount",
    "netamount",
    "discountamount",
    "discount",
    "unitprice",
    "price",
    "priceperunit",
    "rate",
    "cost",
    "totalamount",
    "billedamount",
    "netcost",
    "grosscost",
    "usagequantity",
]);
export const numericLexeme = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const viewOptionsSchema = z.strictObject({
    view: z.enum(["summary", "rows"]).optional(),
    repository: z.string().optional(),
    sku: z.string().optional(),
    reason: z.string().optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
});
const cursorPayloadSchema = z.strictObject({
    version: z.literal("1"),
    runId: safeIdSchema,
    generation: safeIdSchema,
    view: z.enum(["summary", "rows"]),
    filterHash: hashSchema,
    contentHash: hashSchema,
    limit: z.number().int().min(1).max(1000),
    offset: counterSchema,
});
type CursorPayload = z.infer<typeof cursorPayloadSchema>;
const cursorSchema = cursorPayloadSchema.extend({ checksum: hashSchema });
const size = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
const compare = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;

function shortText(text: string, budget: number, reference: string): string {
    if (size(text) <= budget) return text;
    const suffix = `... [abbreviated; ${reference}]`;
    let low = 0,
        high = Math.min(text.length, Math.max(0, budget));
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const prefix = text.slice(0, middle).replace(/[\uD800-\uDBFF]$/, "");
        if (size(prefix + suffix) <= budget) low = middle;
        else high = middle - 1;
    }
    return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "") + suffix;
}

function ref(reference: string): JsonObject {
    return { abbreviated: true, artifact: reference };
}

function bounded(
    value: JsonValue,
    budget: number,
    reference: string,
    numeric = false,
): JsonValue {
    if (size(value) <= budget) return value;
    if (typeof value === "string")
        return numeric ? ref(reference) : shortText(value, budget, reference);
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        const count = Math.min(value.length, 6);
        const quota = Math.max(
            100,
            Math.floor((budget - 180) / Math.max(1, count)),
        );
        const items = value
            .slice(0, count)
            .map((item, index) =>
                bounded(item, quota, `${reference}/${index}`),
            );
        while (items.length) {
            const result = [
                ...items,
                {
                    abbreviated: true,
                    omitted: value.length - items.length,
                    artifact: reference,
                },
            ];
            if (size(result) <= budget) return result;
            items.pop();
        }
        return ref(reference);
    }
    const entries = Object.entries(value).sort(([left], [right]) =>
        compare(left, right),
    );
    const count = Math.min(entries.length, 12),
        selected: [string, JsonValue][] = [];
    const quota = Math.max(
        100,
        Math.floor((budget - 180) / Math.max(1, count)),
    );
    for (const [key, item] of entries.slice(0, count)) {
        if (Buffer.byteLength(key, "utf8") > 128) continue;
        const childRef = `${reference}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        selected.push([
            key,
            bounded(
                item,
                quota,
                childRef,
                numericFields.has(key.toLowerCase()) &&
                    typeof item === "string" &&
                    numericLexeme.test(item),
            ),
        ]);
    }
    while (selected.length) {
        const result: JsonObject = Object.fromEntries([
            ...selected,
            [
                "$abbreviated",
                {
                    omitted: entries.length - selected.length,
                    artifact: reference,
                },
            ],
        ]);
        if (size(result) <= budget) return result;
        selected.pop();
    }
    return ref(reference);
}

function boundedObject(
    value: JsonObject,
    budget: number,
    reference: string,
): JsonObject {
    const result = bounded(value, budget, reference);
    return result && typeof result === "object" && !Array.isArray(result)
        ? result
        : ref(reference);
}

function strings(
    values: string[],
    budget: number,
    reference: string,
): string[] {
    if (size(values) <= budget) return values;
    const count = Math.min(8, values.length);
    const quota = Math.max(
        100,
        Math.floor((budget - 160) / Math.max(1, count)),
    );
    const result = values
        .slice(0, count)
        .map((value, index) =>
            shortText(value, quota, `${reference}/${index}`),
        );
    while (result.length) {
        const candidate = [
            ...result,
            `[abbreviated; ${values.length - result.length} additional values in ${reference}]`,
        ];
        if (size(candidate) <= budget) return candidate;
        result.pop();
    }
    return [`[abbreviated; ${values.length} values in ${reference}]`];
}

function rowView(row: ScenarioRow, index: number, budget: number): ScenarioRow {
    if (size(row) <= budget) return row;
    const reference = `result.json#/result/rows/${index}`;
    const count = Object.keys(row).length;
    const fieldBudget = Math.max(
        100,
        Math.floor((budget - 180) / Math.max(1, Math.min(16, count))),
    );
    const entries: [string, JsonValue][] = [
        ["id", shortText(row.id, fieldBudget, `${reference}/id`)],
        [
            "evidenceIds",
            strings(
                row.evidenceIds,
                Math.max(120, fieldBudget),
                `${reference}/evidenceIds`,
            ),
        ],
    ];
    for (const key of ["repository", "sku", "reason"] as const) {
        if (row[key] !== undefined)
            entries.push([
                key,
                shortText(row[key], fieldBudget, `${reference}/${key}`),
            ]);
    }
    const extra = Object.entries(row)
        .filter(
            ([key]) =>
                !["id", "repository", "sku", "reason", "evidenceIds"].includes(
                    key,
                ),
        )
        .sort(([left], [right]) => compare(left, right));
    for (const [key, value] of extra.slice(0, 12)) {
        if (value !== undefined && Buffer.byteLength(key, "utf8") <= 128) {
            entries.push([
                key,
                bounded(
                    value,
                    fieldBudget,
                    reference,
                    numericFields.has(key.toLowerCase()) &&
                        typeof value === "string" &&
                        numericLexeme.test(value),
                ),
            ]);
        }
    }
    const result: ScenarioRow = {
        ...Object.fromEntries(entries),
        id: String(entries[0]![1]),
        evidenceIds: strings(
            row.evidenceIds,
            Math.max(120, fieldBudget),
            `${reference}/evidenceIds`,
        ),
        $viewDetail: reference,
        $abbreviated: true,
    };
    if (size(result) <= budget) return result;
    return {
        id: shortText(row.id, Math.max(80, budget - 160), reference),
        evidenceIds: [],
        $viewDetail: reference,
        $abbreviated: true,
    };
}

function encodeCursor(payload: CursorPayload): string {
    return Buffer.from(
        JSON.stringify({ ...payload, checksum: digest(payload) }),
        "utf8",
    ).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("encoding");
        const bytes = Buffer.from(cursor, "base64url");
        if (bytes.toString("base64url") !== cursor) throw new Error("encoding");
        const parsed = validate(
            cursorSchema,
            parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
            "cursor",
        );
        const { checksum, ...payload } = parsed;
        if (digest(payload) !== checksum) throw new Error("checksum");
        return payload;
    } catch {
        throw new Error(
            "invalid_cursor: Cursor is malformed or its consistency checksum is invalid",
        );
    }
}

function configuredSelection(scope: JsonObject): {
    repositories: Set<string>;
    properties: JsonObject;
} {
    const selection = scope.selection;
    if (!selection || typeof selection !== "object" || Array.isArray(selection))
        return { repositories: new Set(), properties: {} };
    const repositories = new Set(
        Array.isArray(selection.repositories)
            ? selection.repositories
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.toLowerCase())
            : [],
    );
    const properties =
        selection.properties &&
        typeof selection.properties === "object" &&
        !Array.isArray(selection.properties)
            ? selection.properties
            : {};
    return { repositories, properties };
}

export function createView(
    input: ResultEnvelope,
    rawOptions: ViewOptions = {},
    defaultRows = 25,
): ResultView {
    const options = validate(viewOptionsSchema, rawOptions, "view_options");
    validate(z.number().int().min(1).max(1000), defaultRows, "default_rows");
    const envelope = validate(
        envelopeSchema,
        sanitize(validate(envelopeSchema, input, "result")),
        "result",
    );
    const limit = options.limit ?? defaultRows,
        view = options.view ?? "summary";
    const filters: JsonObject = {};
    for (const key of ["repository", "sku", "reason"] as const)
        if (options[key] !== undefined) filters[key] = options[key];
    const configured = configuredSelection(envelope.scope);
    const propertySelection = Object.keys(configured.properties).length > 0;
    const scopePriority = configured.repositories.size > 0 || propertySelection;
    const matching = envelope.result.rows
        .map((row, index) => ({
            row,
            index,
            prioritized:
                Boolean(
                    row.repository &&
                    configured.repositories.has(row.repository.toLowerCase()),
                ) ||
                (propertySelection && row.bucket === "included"),
        }))
        .filter(({ row }) =>
            Object.entries(filters).every(([key, value]) => row[key] === value),
        )
        .sort(
            (left, right) =>
                Number(right.prioritized) - Number(left.prioritized) ||
                compare(left.row.id, right.row.id) ||
                compare(digest(left.row), digest(right.row)) ||
                left.index - right.index,
        );
    const prioritizedMatches = matching.filter(
        (item) => item.prioritized,
    ).length;
    const binding = {
        version: "1" as const,
        runId: envelope.runId,
        generation: envelope.generation,
        view,
        filterHash: digest(filters),
        contentHash: digest(
            scopePriority
                ? {
                      rows: envelope.result.rows,
                      configuredRepositories: [...configured.repositories].sort(
                          compare,
                      ),
                      configuredProperties: configured.properties,
                  }
                : envelope.result.rows,
        ),
        limit,
    };
    let offset = 0;
    if (options.cursor) {
        const decoded = decodeCursor(options.cursor);
        const { offset: suppliedOffset, ...cursorBinding } = decoded;
        if (
            digest(cursorBinding) !== digest(binding) ||
            suppliedOffset >= matching.length
        ) {
            throw new Error(
                "stale_cursor: Cursor does not match this run, generation, view, exact filters, row limit, row set, or configured selection",
            );
        }
        offset = suppliedOffset;
    }
    const directory = `${envelope.runId}/generations/${envelope.generation}`;
    const originalMetadata = {
        scope: envelope.scope,
        filters: sanitize(filters),
        totals: envelope.result.totals,
        reasons: envelope.reasons,
        limitations: envelope.result.limitations,
        nextActions: envelope.nextActions,
        coverage: envelope.result.coverage,
    };
    const viewResult: ResultView = {
        schemaVersion: "1",
        runId: envelope.runId,
        generation: envelope.generation,
        scenario: envelope.scenario,
        status: envelope.status,
        synthetic: envelope.synthetic,
        scope: envelope.scope,
        time: {
            startedAt: envelope.startedAt,
            completedAt: envelope.completedAt,
        },
        assurance: envelope.assurance,
        filters,
        shown: 0,
        totalMatches: matching.length,
        selection: "",
        rows: [],
        allSourceTotals: envelope.result.totals,
        reasons: envelope.reasons,
        limitations: envelope.result.limitations,
        nextActions: envelope.nextActions,
        artifacts: {
            directory,
            manifest: `${directory}/manifest.json`,
            result: `${directory}/result.json`,
            evidence: `${directory}/evidence/evidence.json`,
            evidenceCount: envelope.evidence.length,
            diagnostics: `${directory}/diagnostics.jsonl`,
            diagnosticsCount: envelope.diagnostics.length,
            rows: `${directory}/exports/rows.json`,
            coverage: sanitize(envelope.result.coverage),
            budget: sanitize(envelope.budget),
            ...(envelope.resumeNotBefore
                ? { resumeNotBefore: envelope.resumeNotBefore }
                : {}),
            ...(scopePriority
                ? {
                      selectionOrder: {
                          order: "configured-scope first; stable ID within each group",
                          configuredRepositories: configured.repositories.size,
                          propertySelection,
                          matchingRows: prioritizedMatches,
                      },
                  }
                : {}),
        },
        abbreviations: [],
    };
    let scale = 1;
    for (let attempt = 0; attempt < 6; attempt++) {
        viewResult.scope = boundedObject(
            envelope.scope,
            3500 * scale,
            "result.json#/scope",
        );
        viewResult.filters = boundedObject(
            validate(
                z.record(z.string(), z.string()),
                originalMetadata.filters,
                "filters",
            ),
            2000 * scale,
            "exact filter value; cursor filterHash",
        );
        viewResult.allSourceTotals = boundedObject(
            envelope.result.totals,
            7000 * scale,
            "result.json#/result/totals",
        );
        viewResult.reasons = strings(
            envelope.reasons,
            1800 * scale,
            "result.json#/reasons",
        );
        viewResult.limitations = strings(
            envelope.result.limitations,
            2800 * scale,
            "result.json#/result/limitations",
        );
        viewResult.nextActions = strings(
            envelope.nextActions,
            1800 * scale,
            "result.json#/nextActions",
        );
        viewResult.artifacts.coverage = bounded(
            sanitize(envelope.result.coverage),
            2500 * scale,
            "result.json#/result/coverage",
        );
        if (size(viewResult) <= 24000) break;
        scale /= 2;
    }
    if (
        digest(originalMetadata) !==
        digest({
            scope: viewResult.scope,
            filters: viewResult.filters,
            totals: viewResult.allSourceTotals,
            reasons: viewResult.reasons,
            limitations: viewResult.limitations,
            nextActions: viewResult.nextActions,
            coverage: viewResult.artifacts.coverage,
        })
    ) {
        viewResult.abbreviations.push(
            "Metadata is abbreviated with detailed-artifact references; allSourceTotals describes all source rows, not the filtered page.",
        );
    }
    const selected = matching.slice(offset, offset + limit);
    const available = SUMMARY_BYTES - 2048 - size(viewResult);
    const rowBudget = Math.max(
        160,
        Math.floor((available * 0.8) / Math.max(1, selected.length)),
    );
    viewResult.rows = selected.map(({ row, index }) =>
        rowView(row, index, rowBudget),
    );
    if (
        viewResult.rows.some(
            (row, index) => digest(row) !== digest(selected[index]!.row),
        )
    ) {
        viewResult.abbreviations.push(
            "Rows or fields are abbreviated, not skipped; original values and evidence IDs remain in each referenced result.json row.",
        );
    }
    const updatePage = () => {
        viewResult.shown = viewResult.rows.length;
        viewResult.selection = `shown ${viewResult.shown} of ${matching.length} ${Object.keys(filters).length ? "requested" : "rows"}`;
        if (scopePriority) {
            const prioritizedShown = selected
                .slice(0, viewResult.shown)
                .filter((item) => item.prioritized).length;
            viewResult.selection += `; ${prioritizedShown} of ${prioritizedMatches} configured-scope matches on this page`;
        }
        if (offset + viewResult.shown < matching.length)
            viewResult.continuation = encodeCursor({
                ...binding,
                offset: offset + viewResult.shown,
            });
        else delete viewResult.continuation;
    };
    updatePage();
    if (size(viewResult) > SUMMARY_BYTES - 512) {
        viewResult.abbreviations.push(
            "The UTF-8 byte budget shortened this page; continuation includes every remaining filtered match.",
        );
        while (
            size(viewResult) > SUMMARY_BYTES - 512 &&
            viewResult.rows.length > 1
        ) {
            viewResult.rows.pop();
            updatePage();
        }
    }
    if (
        size(viewResult) > SUMMARY_BYTES - 512 ||
        (matching.length > offset && viewResult.shown === 0)
    ) {
        throw new Error(
            "view_budget_exceeded: Could not produce a bounded view with at least one requested row",
        );
    }
    return viewResult;
}
