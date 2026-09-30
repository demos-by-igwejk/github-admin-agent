import { z } from "zod";
import {
    jsonObjectSchema,
    monthSchema,
    repositoryNameSchema,
    type Coverage,
    type Diagnostic,
    type JsonObject,
    type ScenarioContext,
    type ScenarioDefinition,
    type ScenarioResult,
    type WorkUnit,
} from "../../core/contracts.ts";
import { addDecimal, compareDecimal, decimal } from "../../core/decimal.ts";
import { lastCompletedMonth, monthBounds } from "../../core/time.ts";
import {
    activityScenario,
    collectInventory,
} from "../repository-activity-inventory/index.ts";
import {
    accounting,
    amountFields,
    billingResultSchema,
    stableId,
    utcDate,
    type BillingRow,
    type Bucket,
} from "./model.ts";
import { collectUsage, repositoryIdentity } from "./source.ts";

const limitations = [
    "This report uses detailed organization billing usage, not the summary endpoint, on github.com. Provider finality remains unknown; these are observations, not a certified invoice.",
    "Credential classes are accepted operator declarations, not verified endpoint support or grants. Endpoint-specific live grant acceptance is pending. Fine-grained PAT and GitHub App authorization for this exact organization endpoint remain unverified; enterprise endpoint support does not establish organization endpoint support.",
    "At most six completed UTC month partitions may be requested per run. This is product policy, not an API retention guarantee; older completed months are not automatically excluded.",
    "The default month and completed-month eligibility are anchored to the recorded run start. Resume does not advance the billing period; an explicit refresh has a new run start.",
    "The detailed usage contract does not supply a default currency. Missing currency is null with provenance not-supplied; those amounts cannot be called dollars or combined with a named currency.",
    "Currencies, usage units, and monthly partitions stay separate. Unit prices are neither summed nor averaged. Signed adjustments and duplicate business rows are retained.",
    "Group pricePerUnit is null when multiple distinct source prices exist; pricePerUnits and original source numeric strings remain in the details. A source-null price is unresolved, not a zero or average price.",
    "The shared exact-decimal engine is bounded. Unsupported numeric lexemes or aggregate magnitudes remain explicitly unresolved rather than being rounded or converted to floating point.",
    "All-source accounting covers validated accepted rows only. Unresolved rows and partitions remain unknown, not zero. Observed partial amounts are neither complete partition totals nor bounds on the eventual invoice.",
    "Source-attributed usage remains attributed even when the repository is absent from current inventory. User-level Copilot and other usage without repository attribution remain unattributed; ownership mappings never allocate spend.",
    "Inventory describes current activity under the selected policy and its original observation times, not historical activity during the billing month. Inactivity does not imply that archiving would eliminate charges.",
    "Only in-run inventory composition is supported. Cross-run inventory reuse is rejected; it requires a separate compatibility and freshness contract.",
    "Included means source-attributed usage without a proven selection exclusion. Unresolved custom-property selection is explicitly flagged and retained, rather than guessed or silently discarded.",
    "An explicitly empty declared-targets selection excludes every source-attributed charge, without changing all-source accounting or allocating unattributed usage. An empty API-visible selection is unfiltered.",
    "Unresolved page counts describe observed invalid pages only. The count and amounts of unreturned pages are unknown.",
];

const inputSchema = z.strictObject({
    months: z
        .array(
            monthSchema.refine(
                (value) => /^(19|20|21)\d\d-/.test(value),
                "Expected a supported UTC YYYY-MM partition",
            ),
        )
        .min(1)
        .max(
            6,
            "Product policy permits at most six completed UTC months per run; this is not an API retention guarantee",
        )
        .refine(
            (values) => new Set(values).size === values.length,
            "Monthly partitions must be unique and nonoverlapping",
        )
        .optional(),
    inventory: z.boolean().default(true),
});

function ownerMap(context: ScenarioContext): Map<string, string> {
    if (context.inputs.owners === undefined) return new Map();
    const owners = z
        .record(repositoryNameSchema, z.string().min(1))
        .parse(context.inputs.owners);
    const result = new Map<string, string>();
    for (const [name, owner] of Object.entries(owners)) {
        const repository = repositoryIdentity(name, context.config.org);
        if (!repository)
            throw new Error(
                "invalid_owners_scope: The prepared owner map contains an out-of-scope repository",
            );
        if (result.has(repository))
            throw new Error(
                "duplicate_owner: Owner keys must be unique ignoring case",
            );
        result.set(repository, owner);
    }
    return result;
}

function inventoryDiagnostics(
    context: ScenarioContext,
    work: readonly WorkUnit[],
    firstDiagnostic: number,
): Diagnostic[] {
    const unfinished = work.filter(
        (unit) =>
            unit.required &&
            !["valid", "policy-excluded"].includes(unit.outcome),
    );
    const reasons = new Set(
        unfinished.flatMap((unit) =>
            unit.reasonCode ? [unit.reasonCode] : [],
        ),
    );
    const evidenceIds = new Set(unfinished.flatMap((unit) => unit.evidenceIds));
    const diagnostics = context.diagnostics.filter(
        (diagnostic, index) =>
            index >= firstDiagnostic ||
            (diagnostic.operation !== "billing.usage" &&
                (reasons.has(diagnostic.code) ||
                    (diagnostic.evidenceId !== undefined &&
                        evidenceIds.has(diagnostic.evidenceId)))),
    );
    for (const unit of unfinished) {
        if (
            !unit.reasonCode ||
            diagnostics.some(
                (diagnostic) => diagnostic.code === unit.reasonCode,
            )
        )
            continue;
        const diagnostic = context.addDiagnostic({
            code: unit.reasonCode,
            message: `Required current-inventory work did not finish: ${unit.id}.`,
            retryable: unit.outcome === "waiting",
            remediation:
                "Review the linked inventory evidence and the enabled signal permissions, then resume incomplete work or refresh stale observations.",
            ...(unit.evidenceIds[0] ? { evidenceId: unit.evidenceIds[0] } : {}),
        });
        diagnostics.push(diagnostic);
    }
    return diagnostics;
}

interface SelectionDecision {
    bucket: Bucket;
    status: BillingRow["selectionStatus"];
}

function selectionFor(
    repository: string | undefined,
    context: ScenarioContext,
    inventory: ScenarioResult | undefined,
): SelectionDecision {
    if (!repository)
        return { bucket: "unattributed", status: "not-applicable" };
    const selected = context.config.selection.repositories;
    const declared =
        selected.length > 0 ||
        context.config.selection.mode === "declared-targets";
    if (declared && !selected.some((name) => name.toLowerCase() === repository))
        return { bucket: "excluded_by_selection", status: "excluded" };
    if (Object.keys(context.config.selection.properties).length === 0)
        return {
            bucket: "included",
            status: declared ? "matched" : "unfiltered",
        };
    if (
        inventory?.rows.some(
            (row) => row.repository?.toLowerCase() === repository,
        )
    )
        return { bucket: "included", status: "matched" };
    if (
        inventory &&
        !inventory.work.some((unit) => unit.reasonCode === "assessment_cap") &&
        inventory.coverage.excluded.some(
            (name) => name.toLowerCase() === repository,
        )
    ) {
        return { bucket: "excluded_by_selection", status: "excluded" };
    }
    return { bucket: "included", status: "unknown" };
}

function coverageFor(
    partitions: Awaited<ReturnType<typeof collectUsage>>["partitions"],
    inventory: ScenarioResult | undefined,
    rows: readonly BillingRow[],
    inventoryRequested: boolean,
): Coverage {
    const incomplete = partitions
        .filter((partition) => partition.completeness !== "complete")
        .map((partition) => `billing:${partition.month}`);
    const selectionUnknown = rows
        .filter((row) => row.selectionStatus === "unknown")
        .flatMap((row) => (row.repository ? [row.repository] : []));
    const billingExcluded = rows
        .filter((row) => row.bucket === "excluded_by_selection")
        .flatMap((row) => (row.repository ? [row.repository] : []));
    const base: Coverage = inventory?.coverage ?? {
        discovery: "not-applicable",
        requested: partitions.length,
        observed: partitions.filter((partition) => partition.acceptedPages > 0)
            .length,
        assessed: partitions.filter(
            (partition) => partition.completeness === "complete",
        ).length,
        pagination: incomplete.length > 0 ? "partial" : "complete",
        unassessed: [],
        excluded: [],
        notes: [
            inventoryRequested
                ? "Current repository inventory did not return a usable coverage result."
                : "Inventory was disabled; coverage counts refer to requested monthly billing partitions, not repositories.",
        ],
    };
    return {
        ...base,
        pagination:
            incomplete.length > 0 ||
            base.pagination === "partial" ||
            (inventoryRequested && !inventory)
                ? "partial"
                : "complete",
        unassessed: [
            ...new Set([
                ...base.unassessed,
                ...incomplete,
                ...selectionUnknown,
            ]),
        ],
        excluded: [...new Set([...base.excluded, ...billingExcluded])],
        notes: [
            ...base.notes,
            `Detailed billing accepted ${partitions.reduce((count, partition) => count + partition.acceptedRows, 0)} source rows across ${partitions.length} requested completed UTC month partitions; exact partition coverage is recorded separately in totals.partitions.`,
            "All-source financial totals are separate from repository selection. Inventory assessment caps do not by themselves exclude source-attributed charges.",
            ...(inventory
                ? [
                      "Repository coverage describes current inventory only; billing periods and per-source observation times remain distinct.",
                  ]
                : []),
        ],
    };
}

async function handler(
    input: JsonObject,
    context: ScenarioContext,
): Promise<ScenarioResult> {
    const options = inputSchema.parse(input);
    if (!utcDate(context.startedAt, false))
        throw new Error(
            "invalid_run_start: Billing requires the original valid UTC run start",
        );
    const startedAt = new Date(context.startedAt);
    const months = [
        ...(options.months ?? [lastCompletedMonth(startedAt)]),
    ].sort();
    for (const month of months) monthBounds(month, startedAt);
    for (const repository of context.config.selection.repositories) {
        if (!repositoryIdentity(repository, context.config.org))
            throw new Error(
                "scope_mismatch: Repository selection is outside the configured organization",
            );
    }
    const emptyDeclaredScope =
        context.config.selection.mode === "declared-targets" &&
        context.config.selection.repositories.length === 0;
    if (
        !options.inventory &&
        !emptyDeclaredScope &&
        Object.keys(context.config.selection.properties).length > 0
    )
        throw new Error(
            "conflicting_selection: Custom-property selection requires in-run inventory; inventory:false performs no repository reads",
        );
    const owners = ownerMap(context);
    const usage = await collectUsage(months, context);
    const work = [...usage.work];
    let inventory: ScenarioResult | undefined;
    let inventoryWork: WorkUnit[] = [],
        diagnostics: Diagnostic[] = [];
    if (options.inventory) {
        const firstDiagnostic = context.diagnostics.length;
        try {
            inventory = await collectInventory(context);
            inventoryWork = inventory.work;
        } catch (error) {
            const code = context.signal.aborted
                ? "inventory_cancelled"
                : error instanceof z.ZodError
                  ? "inventory_contract_failure"
                  : "inventory_collection_failure";
            const diagnostic = context.addDiagnostic({
                code,
                message:
                    "Current inventory did not produce a usable result. Validated billing evidence is retained independently.",
                retryable: false,
                remediation:
                    "Review the inventory diagnostics and enabled repository permissions, correct the inventory failure, and resume or refresh explicitly.",
            });
            inventoryWork = [
                {
                    id: "billing:inventory",
                    required: true,
                    outcome: context.signal.aborted ? "cancelled" : "failed",
                    reasonCode: diagnostic.code,
                    evidenceIds: [],
                },
            ];
        }
        work.push(...inventoryWork);
        diagnostics = inventoryDiagnostics(
            context,
            inventoryWork,
            firstDiagnostic,
        );
    }
    const inventoryRows = new Map(
        inventory?.rows.flatMap((row) =>
            row.repository
                ? [[row.repository.toLowerCase(), row] as const]
                : [],
        ) ?? [],
    );
    const partitions = new Map(
        usage.partitions.map((partition) => [partition.month, partition]),
    );
    const groups = new Map<string, BillingRow>();
    const unknownSelections = new Map<string, Diagnostic>();
    for (const entry of usage.accepted) {
        const { repository, month, detail } = entry,
            source = entry.usage;
        const currency = source.currency ?? null;
        const id = stableId([
            context.config.org.toLowerCase(),
            month,
            repository ?? null,
            source.product,
            source.sku,
            currency,
            source.unitType,
        ]);
        let group = groups.get(id);
        if (!group) {
            const partition = partitions.get(month)!;
            const selection = selectionFor(repository, context, inventory);
            let selectionDiagnostic: Diagnostic | undefined;
            if (selection.status === "unknown" && repository) {
                selectionDiagnostic = unknownSelections.get(repository);
                if (!selectionDiagnostic) {
                    selectionDiagnostic = context.addDiagnostic({
                        code: "billing_selection_unresolved",
                        message:
                            "Current inventory could not establish whether this source-attributed repository matches the configured custom properties. Its accepted amounts are retained, not silently excluded.",
                        operation: "repositories.properties",
                        target: repository,
                        retryable: false,
                        remediation:
                            "Resolve the inventory/property-read failure or explicitly change the selection. An assessment cap or absence from current inventory does not prove a property mismatch.",
                        evidenceId: detail.evidenceId,
                    });
                    unknownSelections.set(repository, selectionDiagnostic);
                    work.push({
                        id: `billing:selection:${repository}`,
                        required: true,
                        outcome: "unassessed",
                        reasonCode: selectionDiagnostic.code,
                        evidenceIds: [detail.evidenceId],
                    });
                }
            }
            const observation = repository
                ? inventoryRows.get(repository)
                : undefined;
            const relatedDiagnostics = diagnostics.filter(
                (diagnostic) =>
                    !repository ||
                    !diagnostic.target ||
                    diagnostic.target.toLowerCase() === repository ||
                    diagnostic.target.toLowerCase() ===
                        context.config.org.toLowerCase() ||
                    observation?.evidenceIds.includes(
                        diagnostic.evidenceId ?? "",
                    ),
            );
            const activityStatus =
                observation?.classification === "active" ||
                observation?.classification === "inactive"
                    ? observation.classification
                    : "unknown";
            const activityReason =
                typeof observation?.reason === "string"
                    ? observation.reason
                    : !repository
                      ? "source_unattributed"
                      : !options.inventory
                        ? "inventory_not_requested"
                        : (relatedDiagnostics[0]?.code ??
                          (!inventory
                              ? "inventory_collection_failure"
                              : "repository_not_observed_in_current_inventory"));
            group = {
                id,
                ...(repository ? { repository } : {}),
                product: source.product,
                sku: source.sku,
                month,
                currency,
                currencyProvenance:
                    currency === null ? "not-supplied" : "response",
                unit: source.unitType,
                periodStart: partition.start,
                periodEnd: partition.end,
                bucket: selection.bucket,
                selectionStatus: selection.status,
                quantity: "0",
                pricePerUnit: null,
                pricePerUnits: [],
                grossAmount: "0",
                discountAmount: "0",
                netAmount: "0",
                sourceRows: [],
                sourceRowCount: 0,
                amountBasis:
                    partition.completeness === "complete"
                        ? "observed-accepted"
                        : "observed-partial",
                activityStatus,
                activityObservation: observation
                    ? jsonObjectSchema.parse(observation)
                    : null,
                activityReason,
                ownership: repository ? (owners.get(repository) ?? null) : null,
                evidenceIds: [],
                diagnosticIds: [
                    ...new Set([
                        ...partition.diagnosticIds,
                        ...relatedDiagnostics.map(
                            (diagnostic) => diagnostic.id,
                        ),
                        ...(selectionDiagnostic
                            ? [selectionDiagnostic.id]
                            : []),
                    ]),
                ],
                reason:
                    selection.bucket === "unattributed"
                        ? "source_unattributed"
                        : selection.bucket === "excluded_by_selection"
                          ? "excluded_by_selection"
                          : (selectionDiagnostic?.code ??
                            partition.reasonCodes[0] ??
                            activityReason),
            };
            groups.set(id, group);
        }
        for (const field of amountFields)
            group[field] = addDecimal(group[field], detail[field]);
        group.sourceRows.push(detail);
        group.sourceRowCount++;
        const price = decimal(detail.pricePerUnit);
        if (!group.pricePerUnits.includes(price))
            group.pricePerUnits.push(price);
        if (!group.evidenceIds.includes(detail.evidenceId))
            group.evidenceIds.push(detail.evidenceId);
    }
    const rows = [...groups.values()].sort((left, right) => {
        const a = [
            left.month,
            left.repository ?? "",
            left.product,
            left.sku,
            left.currency ?? "",
            left.unit,
            left.id,
        ];
        const b = [
            right.month,
            right.repository ?? "",
            right.product,
            right.sku,
            right.currency ?? "",
            right.unit,
            right.id,
        ];
        return JSON.stringify(a).localeCompare(JSON.stringify(b), "en");
    });
    for (const row of rows) {
        row.pricePerUnits.sort(compareDecimal);
        row.pricePerUnit =
            row.pricePerUnits.length === 1 ? row.pricePerUnits[0]! : null;
    }
    return billingResultSchema.parse({
        rows,
        totals: {
            accountingBasis: "accepted-source-evidence-only",
            providerFinality: "unknown",
            months,
            ...accounting(rows),
            acceptedSourceRows: usage.accepted.length,
            partitions: usage.partitions,
            unresolved: {
                rowCount: usage.unresolved.length,
                pageCount: usage.partitions.reduce(
                    (count, partition) => count + partition.unresolvedPages,
                    0,
                ),
                partitionCount: usage.partitions.filter(
                    (partition) => partition.completeness !== "complete",
                ).length,
                rows: usage.unresolved,
            },
            inventory: {
                requested: options.inventory,
                coverage: inventory?.coverage ?? null,
                reasonCodes: [
                    ...new Set(
                        inventoryWork.flatMap((unit) =>
                            unit.required &&
                            !["valid", "policy-excluded"].includes(
                                unit.outcome,
                            ) &&
                            unit.reasonCode
                                ? [unit.reasonCode]
                                : [],
                        ),
                    ),
                ],
                diagnosticIds: diagnostics.map((diagnostic) => diagnostic.id),
                diagnostics,
            },
            selectionUnresolved: [...unknownSelections.keys()].sort(),
        },
        work,
        coverage: coverageFor(
            usage.partitions,
            inventory,
            rows,
            options.inventory,
        ),
        limitations: [
            ...new Set([...limitations, ...(inventory?.limitations ?? [])]),
        ],
    });
}

export const billingScenario: ScenarioDefinition = {
    manifest: {
        id: "repository-billing-report",
        version: "1.0.0",
        status: "implemented",
        title: "Repository billing report",
        description:
            "Report exact observed detailed organization usage by repository, product, SKU, currency, unit, and completed UTC month, with optional independent current inventory.",
        intentExamples: [
            "Report last completed month repository costs without allocating unattributed usage.",
            "Review observed charges for inactive repositories and repositories absent from current inventory.",
        ],
        risk: "read-only",
        modes: ["inspect"],
        platforms: ["github.com"],
        capabilities: [
            {
                operation: "billing.usage",
                resource:
                    "GET /organizations/{org}/settings/billing/usage?year={year}&month={month}",
                credentialClasses: [
                    "oauth",
                    "classic-pat",
                    "fine-grained-pat",
                    "app-installation",
                    "app-user",
                ],
                permissions: [
                    "The billing tutorial documents a classic PAT flow for an organization owner or billing manager; exact endpoint-specific live grant acceptance is pending.",
                    "Fine-grained PAT and GitHub App grants for this exact organization endpoint are unverified. No specific fine-grained permission recipe is asserted; accepted credential declarations are not support claims.",
                    "OAuth billing authorization for this exact endpoint is unverified. No OAuth scope recipe or normal gh browser-login billing support is asserted.",
                ],
                reference:
                    "https://docs.github.com/en/rest/billing/usage#get-billing-usage-report-for-an-organization",
            },
            ...activityScenario.manifest.capabilities,
        ],
        inputs: [
            {
                name: "owners",
                defaultPath: "config/owners.csv",
                required: false,
                sensitivity: "configuration",
            },
        ],
        artifacts: [
            "result.json",
            "summary.json",
            "summary.md",
            "evidence/",
            "diagnostics.jsonl",
        ],
        views: {
            defaultRows: 10,
            maxRows: 1000,
            order: "Month, repository, product, SKU, currency, unit, stable identity ascending; selected rows take priority in bounded views.",
            filters: ["repository", "sku", "reason"],
        },
        limitations,
        recovery: [
            "Resume incomplete monthly partitions with the original shared allowance; cache/page identity prevents repeated ingestion.",
            "Refresh stale evidence explicitly. Complete billing collection does not establish provider finality.",
            "Correct source or inventory diagnostics without discarding previously validated billing evidence.",
        ],
        skill: ".github/skills/repository-billing-report/SKILL.md",
        fixtures: ["tests/scenarios/billing.test.ts"],
    },
    inputSchema,
    resultSchema: billingResultSchema,
    handler,
};
