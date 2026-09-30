import type {
    Diagnostic,
    JsonObject,
    JsonValue,
    ScenarioContext,
    WorkUnit,
} from "../../core/contracts.ts";
import { repositoryNameSchema } from "../../core/contracts.ts";
import { addDecimal, decimal } from "../../core/decimal.ts";
import { monthBounds } from "../../core/time.ts";
import { object, problemOutcome } from "../shared.ts";
import {
    amountFields,
    currencySchema,
    exactAmount,
    sourceUsageSchema,
    utcDate,
    type Partition,
    type SourceDetail,
    type SourceUsage,
    type UnresolvedRow,
} from "./model.ts";

export interface AcceptedUsage {
    month: string;
    repository?: string;
    usage: SourceUsage;
    detail: SourceDetail;
}

export function repositoryIdentity(
    value: string,
    org: string,
): string | undefined {
    const fullName = value.includes("/") ? value : `${org}/${value}`;
    if (
        !repositoryNameSchema.safeParse(fullName).success ||
        fullName.split("/")[0]?.toLowerCase() !== org.toLowerCase()
    )
        return undefined;
    return fullName.toLowerCase();
}

function metadataNumber(value: JsonValue | undefined): number | undefined {
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^\d{1,4}$/.test(value))
        return Number(value);
    return undefined;
}

function envelopeProblem(
    data: JsonObject,
    month: string,
    org: string,
): { code: string; fields: string[] } | undefined {
    const [year, number] = month.split("-").map(Number);
    const fields: string[] = [];
    if ("year" in data && metadataNumber(data.year) !== year)
        fields.push("year");
    if ("month" in data && metadataNumber(data.month) !== number)
        fields.push("month");
    if ("day" in data && metadataNumber(data.day) !== 0) fields.push("day");
    if (
        "organizationName" in data &&
        (typeof data.organizationName !== "string" ||
            data.organizationName.toLowerCase() !== org.toLowerCase())
    )
        fields.push("organizationName");
    for (const field of ["enterpriseName", "costCenterId", "costCenterName"]) {
        if (
            data[field] !== undefined &&
            data[field] !== null &&
            data[field] !== ""
        )
            fields.push(field);
    }
    return fields.length > 0
        ? { code: "billing_partition_mismatch", fields }
        : undefined;
}

function hasContinuation(data: JsonObject): boolean {
    const indicator = (value: JsonValue | undefined) =>
        value !== undefined &&
        value !== null &&
        value !== false &&
        value !== "" &&
        value !== 0 &&
        value !== "0";
    return (
        [
            "next",
            "nextPage",
            "next_page",
            "nextPageToken",
            "next_page_token",
            "continuation",
            "continuationToken",
            "hasMore",
            "has_more",
        ].some((key) => indicator(data[key])) ||
        indicator(object(data.links)?.next)
    );
}

export function retainDiagnostic(
    context: ScenarioContext,
    diagnostic: Diagnostic,
): Diagnostic {
    const existing = context.diagnostics.find(
        (item) => item.id === diagnostic.id,
    );
    if (existing) return existing;
    const { id: _id, ...value } = diagnostic;
    return context.addDiagnostic(value);
}

export async function collectUsage(
    months: readonly string[],
    context: ScenarioContext,
): Promise<{
    accepted: AcceptedUsage[];
    partitions: Partition[];
    unresolved: UnresolvedRow[];
    work: WorkUnit[];
}> {
    const accepted: AcceptedUsage[] = [],
        partitions: Partition[] = [],
        unresolved: UnresolvedRow[] = [],
        work: WorkUnit[] = [];
    const seenPages = new Map<
        string,
        { month: string; data: string; observedAt: string }
    >();
    const startedAt = new Date(context.startedAt);
    for (const month of months) {
        const bounds = monthBounds(month, startedAt);
        const partition: Partition = {
            month,
            ...bounds,
            completeness: "none",
            empty: null,
            acceptedRows: 0,
            unresolvedRows: 0,
            acceptedPages: 0,
            unresolvedPages: 0,
            evidenceIds: [],
            diagnosticIds: [],
            reasonCodes: [],
        };
        const unitId = `billing:${month}`,
            partitionWork: WorkUnit[] = [];
        const absoluteAmounts = new Map<string, string>();
        const decimalPlaces = new Map<string, number>();
        const addProblem = (
            code: string,
            message: string,
            id: string,
            evidenceId?: string,
            outcome: WorkUnit["outcome"] = "failed",
        ): Diagnostic => {
            const diagnostic = context.addDiagnostic({
                code,
                message,
                operation: "billing.usage",
                target: `${context.config.org}:${month}`,
                retryable: false,
                remediation:
                    code === "billing_decimal_range"
                        ? "Review the supported shared exact-decimal range before rerunning this partition. Do not round the amounts or convert them to floating point to claim completion."
                        : "Inspect the linked detailed usage evidence and the organization/month scope. Correct the source contract or refresh the affected partition; do not substitute the summary endpoint.",
                ...(evidenceId ? { evidenceId } : {}),
            });
            partition.diagnosticIds.push(diagnostic.id);
            partition.reasonCodes.push(code);
            partitionWork.push({
                id,
                required: true,
                outcome,
                reasonCode: code,
                evidenceIds: evidenceId ? [evidenceId] : [],
            });
            return diagnostic;
        };
        const collection = await context.client.collect("billing.usage", {
            org: context.config.org,
            month,
        });
        if (collection.operation !== "billing.usage") {
            addProblem(
                "billing_operation_mismatch",
                "The collection is not from the detailed billing usage operation.",
                `${unitId}:operation`,
            );
        } else {
            for (const [pageIndex, page] of collection.pages.entries()) {
                const pageId = `${unitId}:page:${pageIndex}`;
                const evidenceId =
                    typeof page.evidenceId === "string" &&
                    page.evidenceId.length > 0
                        ? page.evidenceId
                        : undefined;
                if (!evidenceId || !utcDate(page.observedAt, false)) {
                    partition.unresolvedPages++;
                    addProblem(
                        "billing_invalid_provenance",
                        "The billing page lacks an evidence identity or valid original observation timestamp.",
                        pageId,
                        evidenceId,
                    );
                    continue;
                }
                const previous = seenPages.get(evidenceId),
                    serialized = JSON.stringify(page.data);
                if (previous) {
                    if (
                        previous.month === month &&
                        previous.data === serialized &&
                        previous.observedAt === page.observedAt
                    )
                        continue;
                    partition.unresolvedPages++;
                    addProblem(
                        "billing_overlapping_evidence",
                        "One evidence identity was reused across different monthly partitions or different page contents.",
                        pageId,
                        evidenceId,
                    );
                    continue;
                }
                seenPages.set(evidenceId, {
                    month,
                    data: serialized,
                    observedAt: page.observedAt,
                });
                partition.evidenceIds.push(evidenceId);
                const data = object(page.data);
                if (!data || !Array.isArray(data.usageItems)) {
                    partition.unresolvedPages++;
                    addProblem(
                        "billing_invalid_page",
                        "Detailed usage must be an object containing a usageItems array; an empty object, summary, HTML, or null is not an empty billing result.",
                        pageId,
                        evidenceId,
                    );
                    continue;
                }
                const metadata = envelopeProblem(
                    data,
                    month,
                    context.config.org,
                );
                if (metadata) {
                    partition.unresolvedPages++;
                    addProblem(
                        metadata.code,
                        `Billing metadata contradicts the requested organization/month partition: ${metadata.fields.join(", ")}. Daily and cost-center partitions are not supported.`,
                        pageId,
                        evidenceId,
                    );
                    continue;
                }
                let acceptedOnPage = 0,
                    unresolvedOnPage = 0;
                for (const [sourceIndex, raw] of data.usageItems.entries()) {
                    const parsed = sourceUsageSchema.safeParse(raw),
                        row = object(raw);
                    let code = "billing_invalid_row",
                        fields: string[] = [];
                    let repository: string | undefined;
                    const pendingAmounts = new Map<string, string>();
                    const pendingPlaces = new Map<string, number>();
                    if (!parsed.success) {
                        fields = [
                            ...new Set(
                                parsed.error.issues.map(
                                    (issue) => issue.path.join(".") || "row",
                                ),
                            ),
                        ];
                    } else {
                        if (
                            parsed.data.organizationName.toLowerCase() !==
                            context.config.org.toLowerCase()
                        ) {
                            code = "billing_scope_mismatch";
                            fields.push("organizationName");
                        }
                        const timestamp = Date.parse(parsed.data.date);
                        if (
                            timestamp < Date.parse(bounds.start) ||
                            timestamp >= Date.parse(bounds.end)
                        ) {
                            code = "billing_period_mismatch";
                            fields.push("date");
                        }
                        if (
                            parsed.data.repositoryName !== undefined &&
                            parsed.data.repositoryName !== null
                        ) {
                            repository = repositoryIdentity(
                                parsed.data.repositoryName,
                                context.config.org,
                            );
                            if (!repository) {
                                code = "billing_repository_mismatch";
                                fields.push("repositoryName");
                            }
                        }
                        if (fields.length === 0) {
                            // Bound absolute sums so later selection buckets remain representable without rounding.
                            for (const field of amountFields) {
                                const value = decimal(parsed.data[field]);
                                const key = JSON.stringify([
                                    parsed.data.currency ?? null,
                                    parsed.data.unitType,
                                    field,
                                ]);
                                const total = addDecimal(
                                    absoluteAmounts.get(key) ?? "0",
                                    value.startsWith("-")
                                        ? value.slice(1)
                                        : value,
                                );
                                const places = Math.max(
                                    decimalPlaces.get(key) ?? 0,
                                    value.split(".")[1]?.length ?? 0,
                                );
                                const widest = `${total.split(".")[0]}${places > 0 ? `.${"0".repeat(places - 1)}1` : ""}`;
                                if (
                                    exactAmount(total) === null ||
                                    exactAmount(`-${widest}`) === null
                                ) {
                                    code = "billing_decimal_range";
                                    fields.push(field);
                                }
                                pendingAmounts.set(key, total);
                                pendingPlaces.set(key, places);
                            }
                        }
                    }
                    if (fields.length > 0 || !parsed.success) {
                        const message =
                            code === "billing_decimal_range"
                                ? `Detailed usage row ${sourceIndex} exceeds the bounded exact-decimal aggregation range for ${fields.join(", ")}. It remains unresolved rather than rounded; earlier accepted rows are retained.`
                                : `Detailed usage row ${sourceIndex} is unresolved because required fields are missing, unknown, malformed, or outside the requested scope: ${fields.join(", ")}. No amounts from this row were included in accepted totals.`;
                        const diagnostic = addProblem(
                            code,
                            message,
                            `${pageId}:row:${sourceIndex}`,
                            evidenceId,
                        );
                        const rawRepository =
                            typeof row?.organizationName === "string" &&
                            row.organizationName.toLowerCase() ===
                                context.config.org.toLowerCase() &&
                            typeof row.repositoryName === "string"
                                ? repositoryIdentity(
                                      row.repositoryName,
                                      context.config.org,
                                  )
                                : undefined;
                        const rawCurrency = currencySchema.safeParse(
                            row?.currency,
                        );
                        unresolved.push({
                            bucket: "unresolved",
                            month,
                            ...(rawRepository
                                ? { repository: rawRepository }
                                : {}),
                            product:
                                typeof row?.product === "string"
                                    ? row.product
                                    : null,
                            sku: typeof row?.sku === "string" ? row.sku : null,
                            currency: rawCurrency.success
                                ? rawCurrency.data
                                : null,
                            unit:
                                typeof row?.unitType === "string"
                                    ? row.unitType
                                    : null,
                            quantity: exactAmount(row?.quantity),
                            pricePerUnit: exactAmount(row?.pricePerUnit),
                            grossAmount: exactAmount(row?.grossAmount),
                            discountAmount: exactAmount(row?.discountAmount),
                            netAmount: exactAmount(row?.netAmount),
                            sourceIndex,
                            evidenceId,
                            diagnosticId: diagnostic.id,
                            reasonCode: code,
                            invalidFields: fields,
                        });
                        unresolvedOnPage++;
                        continue;
                    }
                    const usage = parsed.data;
                    for (const [key, value] of pendingAmounts)
                        absoluteAmounts.set(key, value);
                    for (const [key, value] of pendingPlaces)
                        decimalPlaces.set(key, value);
                    accepted.push({
                        month,
                        ...(repository ? { repository } : {}),
                        usage,
                        detail: {
                            date: usage.date,
                            organizationName: usage.organizationName,
                            repositoryName: usage.repositoryName ?? null,
                            quantity: usage.quantity,
                            pricePerUnit: usage.pricePerUnit,
                            grossAmount: usage.grossAmount,
                            discountAmount: usage.discountAmount,
                            netAmount: usage.netAmount,
                            evidenceId,
                            observedAt: page.observedAt,
                            sourceIndex,
                        },
                    });
                    acceptedOnPage++;
                }
                if (acceptedOnPage > 0 || data.usageItems.length === 0) {
                    partition.acceptedPages++;
                    partitionWork.push({
                        id: `${pageId}:accepted`,
                        required: true,
                        outcome: "valid",
                        evidenceIds: [evidenceId],
                    });
                }
                partition.acceptedRows += acceptedOnPage;
                partition.unresolvedRows += unresolvedOnPage;
                if (unresolvedOnPage > 0) partition.unresolvedPages++;
                if (
                    hasContinuation(data) &&
                    !collection.problems.some(
                        (problem) =>
                            problem.kind === "unsupported-continuation",
                    )
                ) {
                    addProblem(
                        "unsupported_billing_continuation",
                        "Detailed billing signals an unmodelled continuation. Validated rows are retained as observed partial amounts; no continuation was followed.",
                        `${pageId}:continuation`,
                        evidenceId,
                    );
                }
            }
        }
        for (const [index, problem] of collection.problems.entries()) {
            const diagnostic = retainDiagnostic(context, problem.diagnostic);
            partition.diagnosticIds.push(diagnostic.id);
            partition.reasonCodes.push(diagnostic.code);
            partitionWork.push({
                id: `${unitId}:source-problem:${index}`,
                required: true,
                outcome: problemOutcome(problem),
                reasonCode: diagnostic.code,
                evidenceIds: diagnostic.evidenceId
                    ? [diagnostic.evidenceId]
                    : [],
            });
        }
        if (
            collection.pages.length === 0 &&
            collection.completeness === "complete"
        ) {
            addProblem(
                "billing_missing_evidence",
                "No detailed usage page was returned. Only an observed usageItems: [] response establishes an empty requested partition.",
                `${unitId}:missing-evidence`,
            );
        }
        if (
            collection.completeness !== "complete" &&
            collection.problems.length === 0
        ) {
            addProblem(
                "billing_incomplete_partition",
                "The requested billing partition did not finish; missing usage is unknown, not zero.",
                `${unitId}:unfinished`,
                undefined,
                "unassessed",
            );
        }
        const unfinished = partitionWork.filter(
            (unit) => unit.outcome !== "valid",
        );
        partition.completeness =
            unfinished.length === 0 && partition.acceptedPages > 0
                ? "complete"
                : partition.acceptedPages > 0
                  ? "partial"
                  : "none";
        partition.empty =
            partition.completeness === "complete"
                ? partition.acceptedRows === 0
                : null;
        partition.diagnosticIds = [...new Set(partition.diagnosticIds)];
        partition.reasonCodes = [...new Set(partition.reasonCodes)];
        const outcome =
            (["cancelled", "failed", "unassessed", "waiting"] as const).find(
                (candidate) =>
                    unfinished.some((unit) => unit.outcome === candidate),
            ) ?? (partition.completeness === "complete" ? "valid" : "failed");
        work.push(...partitionWork, {
            id: `${unitId}:partition`,
            required: true,
            outcome,
            evidenceIds: partition.evidenceIds,
            ...(partition.reasonCodes[0]
                ? { reasonCode: partition.reasonCodes[0] }
                : {}),
        });
        partitions.push(partition);
    }
    return { accepted, partitions, unresolved, work };
}
