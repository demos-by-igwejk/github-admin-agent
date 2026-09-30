import { createHash } from "node:crypto";
import { z } from "zod";
import {
    coverageSchema,
    diagnosticSchema,
    jsonObjectSchema,
    jsonValueSchema,
    monthSchema,
    repositoryNameSchema,
    workUnitSchema,
} from "../../core/contracts.ts";
import { addDecimal, decimal, sumDecimals } from "../../core/decimal.ts";
import { monthBounds } from "../../core/time.ts";

export const amountFields = [
    "quantity",
    "grossAmount",
    "discountAmount",
    "netAmount",
] as const;
export const numericFields = [
    "quantity",
    "pricePerUnit",
    "grossAmount",
    "discountAmount",
    "netAmount",
] as const;
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const evidenceIdsSchema = z
    .array(z.string().min(1))
    .refine(
        (values) => new Set(values).size === values.length,
        "Evidence IDs must be unique",
    );

export function exactAmount(value: unknown): string | null {
    if (typeof value !== "string") return null;
    try {
        const normalized = decimal(value);
        return decimal(normalized);
    } catch {
        return null;
    }
}

export function utcDate(value: unknown, dateOnly = true): value is string {
    if (typeof value !== "string") return false;
    if (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const timestamp = Date.parse(`${value}T00:00:00Z`);
        return (
            Number.isFinite(timestamp) &&
            new Date(timestamp).toISOString().slice(0, 10) === value
        );
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value))
        return false;
    const timestamp = Date.parse(value);
    return (
        Number.isFinite(timestamp) &&
        new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19)
    );
}

export const decimalSchema = z
    .string()
    .refine(
        (value) => exactAmount(value) !== null,
        "Expected a lossless decimal string",
    );
const canonicalDecimalSchema = decimalSchema.refine(
    (value) => exactAmount(value) === value,
    "Expected a canonical exact decimal",
);
const timestampSchema = z
    .string()
    .refine((value) => utcDate(value, false), "Expected a valid UTC timestamp");
const textSchema = z
    .string()
    .min(1)
    .max(1000)
    .refine((value) => value.trim().length > 0, "Expected non-blank text");
const currencyProvenanceSchema = z.enum(["response", "not-supplied"]);
const amountBasisSchema = z.enum(["observed-accepted", "observed-partial"]);
export const bucketSchema = z.enum([
    "included",
    "excluded_by_selection",
    "unattributed",
]);
export type Bucket = z.infer<typeof bucketSchema>;

export const sourceUsageSchema = z.object({
    date: z
        .string()
        .refine(
            (value) => utcDate(value),
            "Expected YYYY-MM-DD or a valid UTC ISO timestamp ending in Z",
        ),
    product: textSchema,
    sku: textSchema,
    quantity: decimalSchema,
    unitType: textSchema,
    pricePerUnit: decimalSchema,
    grossAmount: decimalSchema,
    discountAmount: decimalSchema,
    netAmount: decimalSchema,
    organizationName: textSchema,
    repositoryName: z.string().min(1).max(201).nullable().optional(),
    currency: currencySchema.optional(),
});
export type SourceUsage = z.infer<typeof sourceUsageSchema>;

export const sourceDetailSchema = z.strictObject({
    date: sourceUsageSchema.shape.date,
    organizationName: textSchema,
    repositoryName: z.string().nullable(),
    quantity: decimalSchema,
    pricePerUnit: decimalSchema,
    grossAmount: decimalSchema,
    discountAmount: decimalSchema,
    netAmount: decimalSchema,
    evidenceId: z.string().min(1),
    observedAt: timestampSchema,
    sourceIndex: z.number().int().nonnegative(),
});
export type SourceDetail = z.infer<typeof sourceDetailSchema>;

const dimensions = {
    month: monthSchema,
    currency: currencySchema.nullable(),
    currencyProvenance: currencyProvenanceSchema,
    unit: textSchema,
};
const amounts = {
    quantity: canonicalDecimalSchema,
    grossAmount: canonicalDecimalSchema,
    discountAmount: canonicalDecimalSchema,
    netAmount: canonicalDecimalSchema,
};

export const billingRowSchema = z
    .strictObject({
        id: z.string().regex(/^billing:[a-f0-9]{64}$/),
        repository: repositoryNameSchema.optional(),
        product: textSchema,
        sku: textSchema,
        ...dimensions,
        periodStart: timestampSchema,
        periodEnd: timestampSchema,
        bucket: bucketSchema,
        selectionStatus: z.enum([
            "matched",
            "unfiltered",
            "excluded",
            "unknown",
            "not-applicable",
        ]),
        ...amounts,
        pricePerUnit: canonicalDecimalSchema.nullable(),
        pricePerUnits: z.array(canonicalDecimalSchema).min(1),
        sourceRows: z.array(sourceDetailSchema).min(1),
        sourceRowCount: z.number().int().positive(),
        amountBasis: amountBasisSchema,
        activityStatus: z.enum(["active", "inactive", "unknown"]),
        activityObservation: jsonObjectSchema.nullable(),
        activityReason: z.string().min(1),
        ownership: jsonValueSchema,
        evidenceIds: evidenceIdsSchema.min(1),
        diagnosticIds: z.array(z.string().min(1)),
        reason: z.string().min(1),
    })
    .superRefine((row, context) => {
        if (
            (row.currency === null) !==
            (row.currencyProvenance === "not-supplied")
        )
            context.addIssue({
                code: "custom",
                message:
                    "Currency provenance contradicts the response currency",
            });
        if ((row.repository === undefined) !== (row.bucket === "unattributed"))
            context.addIssue({
                code: "custom",
                message:
                    "Only source-attributed usage can have a repository bucket",
            });
        if (
            (row.bucket === "unattributed" &&
                row.selectionStatus !== "not-applicable") ||
            (row.bucket === "excluded_by_selection" &&
                row.selectionStatus !== "excluded") ||
            (row.bucket === "included" &&
                !["matched", "unfiltered", "unknown"].includes(
                    row.selectionStatus,
                ))
        )
            context.addIssue({
                code: "custom",
                message: "Selection status contradicts the accounting bucket",
            });
        const observedActivity = row.activityObservation?.classification;
        if (
            row.activityStatus !==
                (observedActivity === "active" ||
                observedActivity === "inactive"
                    ? observedActivity
                    : "unknown") ||
            (row.activityObservation !== null &&
                (typeof row.activityObservation.repository !== "string" ||
                    row.activityObservation.repository.toLowerCase() !==
                        row.repository))
        ) {
            context.addIssue({
                code: "custom",
                message:
                    "Current activity classification must come from the same repository inventory observation",
            });
        }
        if (row.sourceRowCount !== row.sourceRows.length)
            context.addIssue({
                code: "custom",
                message: "Source row count does not match the retained details",
            });
        if (
            new Set(
                row.sourceRows.map((source) =>
                    JSON.stringify([source.evidenceId, source.sourceIndex]),
                ),
            ).size !== row.sourceRows.length
        )
            context.addIssue({
                code: "custom",
                message: "A source row was ingested more than once",
            });
        const organization = row.sourceRows[0]?.organizationName.toLowerCase();
        if (
            !organization ||
            row.sourceRows.some(
                (source) =>
                    source.organizationName.toLowerCase() !== organization,
            ) ||
            row.id !==
                stableId([
                    organization,
                    row.month,
                    row.repository ?? null,
                    row.product,
                    row.sku,
                    row.currency,
                    row.unit,
                ])
        )
            context.addIssue({
                code: "custom",
                message:
                    "Stable group identity must match the source organization and dimensions",
            });
        if (
            row.sourceRows.some((source) => {
                const repository =
                    source.repositoryName === null
                        ? undefined
                        : (source.repositoryName.includes("/")
                              ? source.repositoryName
                              : `${source.organizationName}/${source.repositoryName}`
                          ).toLowerCase();
                return repository !== row.repository;
            })
        )
            context.addIssue({
                code: "custom",
                message:
                    "Repository attribution must be supplied by every retained source row",
            });
        if (
            row.sourceRows.some((source) =>
                numericFields.some(
                    (field) => exactAmount(source[field]) === null,
                ),
            )
        )
            return;
        for (const field of amountFields) {
            if (
                sumDecimals(row.sourceRows.map((source) => source[field])) !==
                row[field]
            )
                context.addIssue({
                    code: "custom",
                    path: [field],
                    message:
                        "Amount does not reconcile to retained source rows",
                });
        }
        const prices = [
            ...new Set(
                row.sourceRows.map((source) => decimal(source.pricePerUnit)),
            ),
        ].sort();
        if (
            JSON.stringify([...row.pricePerUnits].sort()) !==
                JSON.stringify(prices) ||
            row.pricePerUnit !== (prices.length === 1 ? prices[0] : null)
        )
            context.addIssue({
                code: "custom",
                message:
                    "Unit prices must remain distinct, not be summed or averaged",
            });
        if (
            JSON.stringify([...row.evidenceIds].sort()) !==
            JSON.stringify(
                [
                    ...new Set(
                        row.sourceRows.map((source) => source.evidenceId),
                    ),
                ].sort(),
            )
        )
            context.addIssue({
                code: "custom",
                message: "Evidence references do not match the source rows",
            });
        try {
            const bounds = monthBounds(row.month);
            if (
                row.periodStart !== bounds.start ||
                row.periodEnd !== bounds.end ||
                row.sourceRows.some(
                    (source) =>
                        Date.parse(source.date) < Date.parse(bounds.start) ||
                        Date.parse(source.date) >= Date.parse(bounds.end),
                )
            ) {
                context.addIssue({
                    code: "custom",
                    message:
                        "Billing dates contradict the requested monthly partition",
                });
            }
        } catch {
            context.addIssue({
                code: "custom",
                message: "Invalid monthly partition",
            });
        }
    });
export type BillingRow = z.infer<typeof billingRowSchema>;

export const totalLineSchema = z.strictObject({
    ...dimensions,
    ...amounts,
    sourceRowCount: z.number().int().nonnegative(),
    amountBasis: amountBasisSchema,
});
export type TotalLine = z.infer<typeof totalLineSchema>;
const reconciliationSchema = z.strictObject({
    ...dimensions,
    quantityDelta: z.literal("0"),
    grossAmountDelta: z.literal("0"),
    discountAmountDelta: z.literal("0"),
    netAmountDelta: z.literal("0"),
});

export const unresolvedRowSchema = z.strictObject({
    bucket: z.literal("unresolved"),
    month: monthSchema,
    repository: repositoryNameSchema.optional(),
    product: z.string().nullable(),
    sku: z.string().nullable(),
    currency: currencySchema.nullable(),
    unit: z.string().nullable(),
    quantity: canonicalDecimalSchema.nullable(),
    pricePerUnit: canonicalDecimalSchema.nullable(),
    grossAmount: canonicalDecimalSchema.nullable(),
    discountAmount: canonicalDecimalSchema.nullable(),
    netAmount: canonicalDecimalSchema.nullable(),
    sourceIndex: z.number().int().nonnegative(),
    evidenceId: z.string().min(1),
    diagnosticId: z.string().min(1),
    reasonCode: z.string().min(1),
    invalidFields: z.array(z.string()).min(1),
});
export type UnresolvedRow = z.infer<typeof unresolvedRowSchema>;

export const partitionSchema = z.strictObject({
    month: monthSchema,
    start: timestampSchema,
    end: timestampSchema,
    completeness: z.enum(["complete", "partial", "none"]),
    empty: z.boolean().nullable(),
    acceptedRows: z.number().int().nonnegative(),
    unresolvedRows: z.number().int().nonnegative(),
    acceptedPages: z.number().int().nonnegative(),
    unresolvedPages: z.number().int().nonnegative(),
    evidenceIds: evidenceIdsSchema,
    diagnosticIds: z.array(z.string().min(1)),
    reasonCodes: z.array(z.string().min(1)),
});
export type Partition = z.infer<typeof partitionSchema>;

export function stableId(parts: readonly (string | null)[]): string {
    return `billing:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function totalKey(row: Pick<TotalLine, "month" | "currency" | "unit">): string {
    return JSON.stringify([row.month, row.currency, row.unit]);
}

export function sumRows(rows: readonly BillingRow[]): TotalLine[] {
    const groups = new Map<string, TotalLine>();
    for (const row of rows) {
        const key = totalKey(row);
        let group = groups.get(key);
        if (!group) {
            group = {
                month: row.month,
                currency: row.currency,
                currencyProvenance: row.currencyProvenance,
                unit: row.unit,
                quantity: "0",
                grossAmount: "0",
                discountAmount: "0",
                netAmount: "0",
                sourceRowCount: 0,
                amountBasis: row.amountBasis,
            };
            groups.set(key, group);
        }
        for (const field of amountFields)
            group[field] = addDecimal(group[field], row[field]);
        group.sourceRowCount += row.sourceRowCount;
        if (row.amountBasis === "observed-partial")
            group.amountBasis = "observed-partial";
    }
    return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([, value]) => value);
}

export function accounting(rows: readonly BillingRow[]) {
    const allSource = sumRows(rows);
    const included = sumRows(rows.filter((row) => row.bucket === "included"));
    const excluded_by_selection = sumRows(
        rows.filter((row) => row.bucket === "excluded_by_selection"),
    );
    const unattributed = sumRows(
        rows.filter((row) => row.bucket === "unattributed"),
    );
    const reconciliation = allSource.map((total) => {
        const parts = [included, excluded_by_selection, unattributed].flatMap(
            (bucket) =>
                bucket.filter((part) => totalKey(part) === totalKey(total)),
        );
        for (const field of amountFields) {
            if (sumDecimals(parts.map((part) => part[field])) !== total[field])
                throw new Error(
                    "billing_reconciliation_failed: Accepted source amounts do not reconcile",
                );
        }
        return {
            month: total.month,
            currency: total.currency,
            currencyProvenance: total.currencyProvenance,
            unit: total.unit,
            quantityDelta: "0" as const,
            grossAmountDelta: "0" as const,
            discountAmountDelta: "0" as const,
            netAmountDelta: "0" as const,
        };
    });
    return {
        allSource,
        included,
        excluded_by_selection,
        unattributed,
        reconciliation,
    };
}

export const billingTotalsSchema = z.strictObject({
    accountingBasis: z.literal("accepted-source-evidence-only"),
    providerFinality: z.literal("unknown"),
    months: z
        .array(monthSchema)
        .min(1)
        .max(6)
        .refine((values) => new Set(values).size === values.length),
    allSource: z.array(totalLineSchema),
    included: z.array(totalLineSchema),
    excluded_by_selection: z.array(totalLineSchema),
    unattributed: z.array(totalLineSchema),
    reconciliation: z.array(reconciliationSchema),
    acceptedSourceRows: z.number().int().nonnegative(),
    partitions: z.array(partitionSchema).min(1).max(6),
    unresolved: z.strictObject({
        rowCount: z.number().int().nonnegative(),
        pageCount: z.number().int().nonnegative(),
        partitionCount: z.number().int().nonnegative(),
        rows: z.array(unresolvedRowSchema),
    }),
    inventory: z.strictObject({
        requested: z.boolean(),
        coverage: coverageSchema.nullable(),
        reasonCodes: z.array(z.string()),
        diagnosticIds: z.array(z.string()),
        diagnostics: z.array(diagnosticSchema),
    }),
    selectionUnresolved: z.array(repositoryNameSchema),
});

export const billingResultSchema = z
    .strictObject({
        rows: z.array(billingRowSchema),
        totals: billingTotalsSchema,
        work: z.array(workUnitSchema).min(1),
        coverage: coverageSchema,
        limitations: z.array(z.string().min(1)).min(1),
    })
    .superRefine((result, context) => {
        if (
            result.rows.some((row) =>
                amountFields.some(
                    (field) => exactAmount(row[field]) !== row[field],
                ),
            )
        )
            return;
        const expected = accounting(result.rows);
        for (const field of [
            "allSource",
            "included",
            "excluded_by_selection",
            "unattributed",
            "reconciliation",
        ] as const) {
            if (
                JSON.stringify(result.totals[field]) !==
                JSON.stringify(expected[field])
            )
                context.addIssue({
                    code: "custom",
                    path: ["totals", field],
                    message:
                        "Totals must reconcile exactly to accepted rows, separately from selection",
                });
        }
        if (
            new Set(result.rows.map((row) => row.id)).size !==
            result.rows.length
        )
            context.addIssue({
                code: "custom",
                message: "Billing groups must have unique stable IDs",
            });
        if (
            result.totals.acceptedSourceRows !==
            result.rows.reduce((count, row) => count + row.sourceRowCount, 0)
        )
            context.addIssue({
                code: "custom",
                message: "Accepted source row count is inconsistent",
            });
        if (
            result.rows.some(
                (row) => !result.totals.months.includes(row.month),
            ) ||
            result.totals.acceptedSourceRows !==
                result.totals.partitions.reduce(
                    (count, partition) => count + partition.acceptedRows,
                    0,
                )
        )
            context.addIssue({
                code: "custom",
                message:
                    "Accepted rows must belong to requested, accounted-for monthly partitions",
            });
        if (
            result.totals.unresolved.rowCount !==
            result.totals.unresolved.rows.length
        )
            context.addIssue({
                code: "custom",
                message: "Unresolved rows must remain explicitly accounted for",
            });
        if (
            result.totals.unresolved.pageCount !==
                result.totals.partitions.reduce(
                    (count, partition) => count + partition.unresolvedPages,
                    0,
                ) ||
            result.totals.unresolved.partitionCount !==
                result.totals.partitions.filter(
                    (partition) => partition.completeness !== "complete",
                ).length
        )
            context.addIssue({
                code: "custom",
                message:
                    "Unresolved partition/page counts must match the evidence ledger",
            });
        const sources = result.rows.flatMap((row) =>
            row.sourceRows.map((source) =>
                JSON.stringify([source.evidenceId, source.sourceIndex]),
            ),
        );
        if (new Set(sources).size !== sources.length)
            context.addIssue({
                code: "custom",
                message:
                    "A source row cannot appear in multiple billing groups",
            });
        if (
            new Set(result.work.map((unit) => unit.id)).size !==
            result.work.length
        )
            context.addIssue({
                code: "custom",
                message: "Logical work identities must be unique",
            });
        if (
            JSON.stringify(
                result.totals.partitions
                    .map((partition) => partition.month)
                    .sort(),
            ) !== JSON.stringify([...result.totals.months].sort())
        )
            context.addIssue({
                code: "custom",
                message:
                    "Requested partitions must be nonoverlapping and explicitly accounted for",
            });
        for (const partition of result.totals.partitions) {
            const unit = result.work.find(
                (work) => work.id === `billing:${partition.month}:partition`,
            );
            if (
                partition.acceptedRows !==
                    result.rows
                        .filter((row) => row.month === partition.month)
                        .reduce(
                            (count, row) => count + row.sourceRowCount,
                            0,
                        ) ||
                partition.unresolvedRows !==
                    result.totals.unresolved.rows.filter(
                        (row) => row.month === partition.month,
                    ).length ||
                (partition.completeness === "complete" &&
                    (partition.unresolvedRows > 0 ||
                        partition.unresolvedPages > 0 ||
                        partition.acceptedPages === 0 ||
                        partition.reasonCodes.length > 0)) ||
                partition.empty !==
                    (partition.completeness === "complete"
                        ? partition.acceptedRows === 0
                        : null) ||
                !unit?.required ||
                (partition.completeness === "complete"
                    ? unit.outcome !== "valid"
                    : ["valid", "policy-excluded"].includes(unit.outcome)) ||
                result.rows.some(
                    (row) =>
                        row.month === partition.month &&
                        (row.amountBasis !==
                            (partition.completeness === "complete"
                                ? "observed-accepted"
                                : "observed-partial") ||
                            row.evidenceIds.some(
                                (id) => !partition.evidenceIds.includes(id),
                            )),
                )
            ) {
                context.addIssue({
                    code: "custom",
                    message: "Partition completeness contradicts its evidence",
                });
            }
        }
    });
