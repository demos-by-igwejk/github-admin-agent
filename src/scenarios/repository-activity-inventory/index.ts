import { z } from "zod";
import {
    activityPolicySchema,
    coverageSchema,
    repositoryNameSchema,
    signalSchema,
    workUnitSchema,
    type Collection,
    type JsonObject,
    type JsonValue,
    type OperationId,
    type ReadClient,
    type ScenarioContext,
    type ScenarioDefinition,
    type ScenarioResult,
    type Signal,
    type WorkUnit,
} from "../../core/contracts.ts";
import {
    activityCutoff,
    observedTimestamp,
    validTimestamp,
} from "../../core/time.ts";
import {
    collectionWork,
    discoverRepositories,
    object,
    type RepositoryObservation,
} from "../shared.ts";

const names = signalSchema.options;
const operations: Record<Signal, OperationId> = {
    push: "repositories.get",
    commits: "activity.commits",
    issues: "activity.issues",
    pull_requests: "activity.pull-requests",
    discussions: "activity.discussions",
    actions: "activity.actions",
};
const limitations = [
    "Inactive means inactive under the selected named policy and observed scope, not unused, safe to archive, or safe to delete.",
    "Discovery is limited to API-visible repositories or declared targets; it does not verify the organization-wide population.",
    "Observations form a collection interval, not a transactional snapshot. Original source observation times are retained.",
    "Push metadata is not every kind of collaboration. Commit activity uses default-branch committer dates, not all branches or author dates.",
    "Issues, pull requests, and Discussions measure updates, not necessarily creation, merge, or substantive human collaboration.",
    "Retained Actions runs can prove activity, including reruns of older-created runs. Their absence cannot prove inactivity without a history-coverage contract.",
    "Disabled signals and positive-evidence short circuits are explicit policy exclusions, not completed source reads.",
];

function exactTimestamp(value: unknown): value is string {
    return (
        validTimestamp(value) &&
        new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
    );
}
const timestampSchema = z
    .string()
    .refine(exactTimestamp, "Expected a valid UTC source timestamp");
const signalResultSchema = z.strictObject({
    name: signalSchema,
    state: z.enum([
        "positive",
        "negative",
        "unknown",
        "disabled",
        "not_applicable",
        "skipped",
    ]),
    observedAt: timestampSchema.nullable(),
    latestAt: timestampSchema.nullable(),
    evidenceIds: z.array(z.string().min(1)),
    reason: z.string().min(1),
});
type SignalResult = z.infer<typeof signalResultSchema>;

function classification(
    signals: readonly SignalResult[],
): "active" | "inactive" | "unknown" {
    if (signals.some((signal) => signal.state === "positive")) return "active";
    return signals
        .filter((signal) => signal.state !== "disabled")
        .every(
            (signal) =>
                signal.state === "negative" ||
                signal.state === "not_applicable",
        )
        ? "inactive"
        : "unknown";
}
const rowSchema = z
    .strictObject({
        id: repositoryNameSchema,
        repository: repositoryNameSchema,
        classification: z.enum(["active", "inactive", "unknown"]),
        policy: activityPolicySchema,
        cutoff: timestampSchema,
        signals: z.array(signalResultSchema).length(names.length),
        reason: z.string().min(1),
        evidenceIds: z.array(z.string().min(1)),
    })
    .superRefine((row, ctx) => {
        const invalid = (message: string) =>
            ctx.addIssue({ code: "custom", message });
        const evidenceIds = new Set(row.evidenceIds);
        if (row.id !== row.repository)
            invalid("Row identity must be the repository identity");
        if (row.signals.some((signal, index) => signal.name !== names[index]))
            invalid("All six signals must appear once in canonical order");
        if (classification(row.signals) !== row.classification)
            invalid("Classification contradicts the signal evidence");
        for (const signal of row.signals) {
            if (
                row.policy.signals.includes(signal.name) ===
                (signal.state === "disabled")
            )
                invalid("Signal state contradicts the declared policy");
            if (
                [
                    "positive",
                    "negative",
                    "not_applicable",
                    "disabled",
                    "skipped",
                ].includes(signal.state) &&
                (signal.observedAt === null || signal.evidenceIds.length === 0)
            )
                invalid(
                    "Terminal signal states need observation and evidence references",
                );
            if (
                signal.state === "positive" &&
                (signal.latestAt === null ||
                    signal.observedAt === null ||
                    Date.parse(signal.latestAt) < Date.parse(row.cutoff) ||
                    observedTimestamp(
                        signal.latestAt,
                        signal.observedAt,
                        row.policy.clockSkewSeconds,
                    ) === null)
            )
                invalid(
                    "Positive evidence must be within the observed policy window",
                );
            if (
                signal.state === "negative" &&
                (signal.observedAt === null ||
                    Date.parse(signal.observedAt) < Date.parse(row.cutoff) ||
                    (signal.latestAt !== null &&
                        Date.parse(signal.latestAt) >=
                            Date.parse(row.cutoff)) ||
                    (signal.name === "push" && signal.latestAt === null) ||
                    signal.name === "actions")
            )
                invalid(
                    "Negative evidence must sufficiently cover the named signal",
                );
            if (
                signal.state === "not_applicable" &&
                (!["issues", "discussions"].includes(signal.name) ||
                    signal.observedAt === null ||
                    Date.parse(signal.observedAt) < Date.parse(row.cutoff))
            )
                invalid(
                    "Not-applicable requires a sufficiently recent supported disabled feature",
                );
            if (
                ["disabled", "not_applicable", "skipped"].includes(
                    signal.state,
                ) &&
                signal.latestAt !== null
            )
                invalid("Excluded signals cannot claim an activity timestamp");
            if (
                signal.state === "skipped" &&
                (!row.policy.positiveShortCircuit ||
                    row.classification !== "active")
            )
                invalid(
                    "Skipped evidence requires a permitted positive short circuit",
                );
            if (signal.evidenceIds.some((id) => !evidenceIds.has(id)))
                invalid(
                    "Row evidence must retain every signal evidence reference",
                );
        }
    });
type ActivityRow = z.infer<typeof rowSchema>;
const countSchema = z.number().int().nonnegative();
const resultSchema = z
    .strictObject({
        rows: z.array(rowSchema),
        totals: z.strictObject({
            active: countSchema,
            inactive: countSchema,
            unknown: countSchema,
            observed: countSchema,
            assessed: countSchema,
        }),
        work: z.array(workUnitSchema),
        coverage: coverageSchema,
        limitations: z.array(z.string()),
    })
    .superRefine((result, ctx) => {
        const invalid = (message: string) =>
            ctx.addIssue({ code: "custom", message });
        if (
            new Set(result.rows.map((row) => row.repository.toLowerCase()))
                .size !== result.rows.length
        )
            invalid("Repository identities must be unique");
        if (
            result.totals.assessed !== result.rows.length ||
            result.coverage.assessed !== result.rows.length ||
            result.totals.observed !== result.coverage.observed ||
            result.totals.observed < result.totals.assessed
        )
            invalid("Counts must preserve observed versus assessed scope");
        for (const state of ["active", "inactive", "unknown"] as const) {
            if (
                result.totals[state] !==
                result.rows.filter((row) => row.classification === state).length
            )
                invalid("Classification totals must match the assessed rows");
        }
        const work = new Map(result.work.map((unit) => [unit.id, unit]));
        if (work.size !== result.work.length)
            invalid("Logical work identities must be unique");
        for (const row of result.rows)
            for (const name of names) {
                if (!work.get(workId(row.repository, name))?.required)
                    invalid(
                        "Every repository signal needs a stable required work unit",
                    );
            }
    });

interface Assessment {
    signal: SignalResult;
    work: WorkUnit[];
}
function workId(repository: string, name: Signal): string {
    return `activity:${repository.toLowerCase()}:${name}`;
}
function unique(values: string[]): string[] {
    return [...new Set(values)];
}
function latest(current: string | null, candidate: string): string {
    return current === null || Date.parse(candidate) > Date.parse(current)
        ? candidate
        : current;
}
function diagnosticWork(
    context: ScenarioContext,
    repository: string,
    name: Signal,
    code: string,
    evidenceIds: string[],
    outcome: "failed" | "unassessed" = "failed",
): WorkUnit {
    context.addDiagnostic({
        code,
        message: `The ${name} signal lacks sufficient valid activity evidence (${code}).`,
        operation: operations[name],
        target: repository,
        retryable: false,
        remediation:
            code === "actions_history_insufficient"
                ? "Use a separately justified history-coverage policy or explicitly disable the Actions signal; retained history alone is insufficient."
                : "Inspect the referenced source evidence and permissions, then resume incomplete work or refresh stale observations.",
        ...(evidenceIds[0] ? { evidenceId: evidenceIds[0] } : {}),
    });
    return {
        id: `${workId(repository, name)}:contract:${code}`,
        required: true,
        outcome,
        reasonCode: code,
        evidenceIds,
    };
}
function metadataAssessment(
    context: ScenarioContext,
    repo: RepositoryObservation,
    name: Signal,
    state: SignalResult["state"],
    reason: string,
    latestAt: string | null = null,
): Assessment {
    const evidenceIds = [repo.evidenceId];
    const observedAt = exactTimestamp(repo.observedAt) ? repo.observedAt : null;
    const signal: SignalResult = {
        name,
        state,
        reason,
        observedAt,
        latestAt,
        evidenceIds,
    };
    const work: WorkUnit[] = [
        {
            id: workId(repo.repository, name),
            required: true,
            outcome: state === "unknown" ? "failed" : "valid",
            reasonCode: reason,
            evidenceIds,
        },
    ];
    if (state === "unknown")
        work.push(
            diagnosticWork(context, repo.repository, name, reason, evidenceIds),
        );
    return { signal, work };
}
function policyExclusion(
    context: ScenarioContext,
    repo: RepositoryObservation,
    name: Signal,
    state: "disabled" | "skipped",
    positiveEvidence: string[] = [],
): Assessment {
    const reason =
        state === "disabled" ? "signal_disabled" : "positive_short_circuit";
    const observedAt = context.clock.now().toISOString();
    const evidence = context.addEvidence({
        operation: operations[name],
        target: repo.repository,
        observedAt,
        source: "policy:repository-activity-inventory",
        data: {
            repository: repo.repository,
            signal: name,
            state,
            reason,
            policy: context.config.activity,
            sourceEvidenceIds: positiveEvidence,
        },
    });
    const evidenceIds = unique([...positiveEvidence, evidence.id]);
    return {
        signal: {
            name,
            state,
            observedAt,
            latestAt: null,
            evidenceIds,
            reason,
        },
        work: [
            {
                id: workId(repo.repository, name),
                required: true,
                outcome: "policy-excluded",
                reasonCode: reason,
                evidenceIds,
            },
        ],
    };
}
function assessPush(
    context: ScenarioContext,
    repo: RepositoryObservation,
    cutoff: string,
): Assessment {
    const value = repo.data.pushed_at;
    const reason = !exactTimestamp(repo.observedAt)
        ? "invalid_observation_timestamp"
        : value === null || value === undefined
          ? "missing_push_timestamp"
          : !exactTimestamp(value)
            ? "invalid_activity_timestamp"
            : observedTimestamp(
                    value,
                    repo.observedAt,
                    context.config.activity.clockSkewSeconds,
                ) === null
              ? "future_activity_timestamp"
              : null;
    if (reason !== null || typeof value !== "string")
        return metadataAssessment(
            context,
            repo,
            "push",
            "unknown",
            reason ?? "invalid_activity_timestamp",
        );
    const state =
        Date.parse(value) >= Date.parse(cutoff) ? "positive" : "negative";
    if (
        state === "negative" &&
        Date.parse(repo.observedAt) < Date.parse(cutoff)
    ) {
        return metadataAssessment(
            context,
            repo,
            "push",
            "unknown",
            "observation_before_cutoff",
            value,
        );
    }
    return metadataAssessment(
        context,
        repo,
        "push",
        state,
        state === "positive" ? "activity_in_window" : "no_activity_in_window",
        value,
    );
}
function unresolvedOutcome(work: WorkUnit[]): WorkUnit["outcome"] {
    for (const outcome of [
        "cancelled",
        "failed",
        "unassessed",
        "waiting",
    ] as const) {
        if (work.some((unit) => unit.outcome === outcome)) return outcome;
    }
    return "unassessed";
}
function validId(value: JsonValue | undefined): boolean {
    return typeof value === "string"
        ? value.trim().length > 0
        : typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function collectTimestamps(
    name: Signal,
    value: JsonValue,
    issue: (code: string) => void,
): unknown[] {
    const item = object(value);
    if (!item) {
        issue("invalid_activity_item");
        return [];
    }
    if (name === "commits") {
        const committer = object(object(item.commit)?.committer);
        if (
            typeof item.sha !== "string" ||
            item.sha.length === 0 ||
            !committer
        ) {
            issue("invalid_activity_item");
            return [];
        }
        return [committer.date];
    }
    if (name === "actions") {
        if (!validId(item.id)) {
            issue("invalid_activity_item");
            return [];
        }
        if (
            item.run_attempt !== undefined &&
            (typeof item.run_attempt !== "number" ||
                !Number.isSafeInteger(item.run_attempt) ||
                item.run_attempt < 1)
        )
            issue("invalid_actions_attempt");
        return [
            item.created_at,
            item.updated_at,
            ...(item.run_started_at === undefined ||
            item.run_started_at === null
                ? []
                : [item.run_started_at]),
        ];
    }
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
        issue("invalid_activity_item");
        return [];
    }
    return [item.updatedAt];
}
function assessCollection(
    context: ScenarioContext,
    repo: RepositoryObservation,
    name: Signal,
    cutoff: string,
    collection: Collection,
): Assessment {
    const id = workId(repo.repository, name);
    const sourceWork = collectionWork(id, collection).filter(
        (unit) => unit.id !== id,
    );
    const evidenceIds = unique([
        ...collection.pages.map((page) => page.evidenceId),
        ...collection.problems.flatMap((problem) =>
            problem.diagnostic.evidenceId
                ? [problem.diagnostic.evidenceId]
                : [],
        ),
    ]);
    const issues = new Map<string, Set<string>>();
    const issue = (code: string, evidenceId?: string) => {
        const refs = issues.get(code) ?? new Set<string>();
        if (evidenceId) refs.add(evidenceId);
        issues.set(code, refs);
    };
    let observedAt: string | null = null,
        latestAt: string | null = null,
        positive = false;
    const preCutoffObservations: string[] = [];
    if (collection.operation !== operations[name])
        issue("unexpected_activity_operation");
    if (
        collection.pages.length === 0 &&
        collection.completeness === "complete" &&
        collection.problems.length === 0
    )
        issue("missing_signal_observation");
    for (const page of collection.pages) {
        if (!exactTimestamp(page.observedAt)) {
            issue("invalid_observation_timestamp", page.evidenceId);
            continue;
        }
        observedAt = latest(observedAt, page.observedAt);
        if (!Array.isArray(page.data)) {
            issue("invalid_activity_page", page.evidenceId);
            continue;
        }
        if (collection.operation !== operations[name]) continue;
        if (Date.parse(page.observedAt) < Date.parse(cutoff))
            preCutoffObservations.push(page.evidenceId);
        for (const item of page.data) {
            for (const value of collectTimestamps(name, item, (code) =>
                issue(code, page.evidenceId),
            )) {
                if (!exactTimestamp(value)) {
                    issue("invalid_activity_timestamp", page.evidenceId);
                    continue;
                }
                if (
                    observedTimestamp(
                        value,
                        page.observedAt,
                        context.config.activity.clockSkewSeconds,
                    ) === null
                ) {
                    issue("future_activity_timestamp", page.evidenceId);
                    continue;
                }
                latestAt = latest(latestAt, value);
                if (Date.parse(value) >= Date.parse(cutoff)) positive = true;
            }
        }
    }
    if (observedAt === null) {
        for (const evidence of context.evidence) {
            if (
                evidenceIds.includes(evidence.id) &&
                exactTimestamp(evidence.observedAt)
            )
                observedAt = latest(observedAt, evidence.observedAt);
        }
    }
    if (!positive)
        for (const evidenceId of preCutoffObservations)
            issue("observation_before_cutoff", evidenceId);
    if (
        !positive &&
        name === "actions" &&
        collection.completeness === "complete" &&
        collection.problems.length === 0 &&
        issues.size === 0
    ) {
        for (const evidenceId of evidenceIds)
            issue("actions_history_insufficient", evidenceId);
    }
    const domainWork = [...issues].map(([code, refs]) =>
        diagnosticWork(
            context,
            repo.repository,
            name,
            code,
            [...refs],
            code === "actions_history_insufficient" ? "unassessed" : "failed",
        ),
    );
    const state: SignalResult["state"] = positive
        ? "positive"
        : collection.completeness === "complete" &&
            collection.problems.length === 0 &&
            issues.size === 0
          ? "negative"
          : "unknown";
    const reason =
        state === "positive"
            ? "activity_in_window"
            : state === "negative"
              ? "no_activity_in_window"
              : (collection.problems[0]?.diagnostic.code ??
                issues.keys().next().value ??
                "incomplete_source");
    const unfinished = [...sourceWork, ...domainWork];
    return {
        signal: { name, state, observedAt, latestAt, evidenceIds, reason },
        work: [
            {
                id,
                required: true,
                outcome:
                    state === "unknown"
                        ? unresolvedOutcome(unfinished)
                        : "valid",
                reasonCode: reason,
                evidenceIds,
            },
            ...unfinished,
        ],
    };
}

export async function collectInventory(
    context: ScenarioContext,
): Promise<ScenarioResult> {
    const client: ReadClient = {
        async collect(operation, args) {
            const collection = await context.client.collect(operation, args);
            if (collection.problems.length > 0) {
                const diagnosticIds = new Set(
                    context.diagnostics.map((diagnostic) => diagnostic.id),
                );
                for (const { diagnostic } of collection.problems) {
                    if (diagnosticIds.has(diagnostic.id)) continue;
                    // Cached source receipts need not replay the client's diagnostic callback.
                    context.diagnostics.push(structuredClone(diagnostic));
                    diagnosticIds.add(diagnostic.id);
                }
            }
            return collection;
        },
    };
    const discovery = await discoverRepositories({ ...context, client });
    const policy = context.config.activity;
    const cutoff = activityCutoff(new Date(context.startedAt), policy);
    const rows: ActivityRow[] = [],
        work = [...discovery.work];
    const repositories = discovery.repositories.toSorted((left, right) => {
        const a = left.repository.toLowerCase(),
            b = right.repository.toLowerCase();
        return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const repo of repositories) {
        const assessments = new Map<Signal, Assessment>();
        for (const name of names) {
            if (!policy.signals.includes(name))
                assessments.set(
                    name,
                    policyExclusion(context, repo, name, "disabled"),
                );
            else if (name === "push")
                assessments.set(name, assessPush(context, repo, cutoff));
            else if (
                (name === "issues" && repo.data.has_issues === false) ||
                (name === "discussions" && repo.data.has_discussions === false)
            ) {
                const reason = !exactTimestamp(repo.observedAt)
                    ? "invalid_observation_timestamp"
                    : Date.parse(repo.observedAt) < Date.parse(cutoff)
                      ? "observation_before_cutoff"
                      : null;
                assessments.set(
                    name,
                    metadataAssessment(
                        context,
                        repo,
                        name,
                        reason === null ? "not_applicable" : "unknown",
                        reason ?? `${name}_disabled`,
                    ),
                );
            }
        }
        for (const name of names) {
            if (assessments.has(name)) continue;
            const positives = [...assessments.values()].filter(
                (assessment) => assessment.signal.state === "positive",
            );
            if (policy.positiveShortCircuit && positives.length > 0) {
                assessments.set(
                    name,
                    policyExclusion(
                        context,
                        repo,
                        name,
                        "skipped",
                        unique(
                            positives.flatMap(
                                (assessment) => assessment.signal.evidenceIds,
                            ),
                        ),
                    ),
                );
                continue;
            }
            const branch =
                typeof repo.data.default_branch === "string"
                    ? repo.data.default_branch
                    : undefined;
            if (
                name === "commits" &&
                (branch === undefined || branch.trim().length === 0)
            ) {
                assessments.set(
                    name,
                    metadataAssessment(
                        context,
                        repo,
                        name,
                        "unknown",
                        "missing_default_branch",
                    ),
                );
                continue;
            }
            const args = {
                org: context.config.org,
                repo: repo.repository.split("/")[1]!,
                ...(name === "commits" ? { branch, since: cutoff } : {}),
            };
            assessments.set(
                name,
                assessCollection(
                    context,
                    repo,
                    name,
                    cutoff,
                    await client.collect(operations[name], args),
                ),
            );
        }
        const signals = names.map((name) => assessments.get(name)!.signal);
        const state = classification(signals);
        rows.push({
            id: repo.repository,
            repository: repo.repository,
            classification: state,
            policy,
            cutoff,
            signals,
            reason:
                state === "inactive"
                    ? "inactive_under_selected_policy_and_observed_scope"
                    : state === "active"
                      ? "observed_activity"
                      : (signals.find((signal) => signal.state === "unknown")
                            ?.reason ?? "insufficient_activity_evidence"),
            evidenceIds: unique([
                repo.evidenceId,
                ...signals.flatMap((signal) => signal.evidenceIds),
            ]),
        });
        work.push(...names.flatMap((name) => assessments.get(name)!.work));
    }
    return resultSchema.parse({
        rows,
        totals: {
            active: rows.filter((row) => row.classification === "active")
                .length,
            inactive: rows.filter((row) => row.classification === "inactive")
                .length,
            unknown: rows.filter((row) => row.classification === "unknown")
                .length,
            observed: discovery.coverage.observed,
            assessed: rows.length,
        },
        work,
        coverage: discovery.coverage,
        limitations,
    });
}

const readerClasses = [
    "oauth",
    "classic-pat",
    "fine-grained-pat",
    "app-installation",
    "app-user",
];
export const activityScenario: ScenarioDefinition = {
    manifest: {
        id: "repository-activity-inventory",
        version: "1.0.0",
        status: "implemented",
        title: "Repository activity inventory",
        description:
            "Classify observed repositories as active, inactive under a named policy, or unknown, without billing access.",
        intentExamples: [
            "Find repositories with no recent activity under the configured policy.",
            "Inspect activity for selected repositories without billing authorization.",
        ],
        risk: "read-only",
        modes: ["inspect"],
        platforms: ["github.com"],
        capabilities: [
            {
                operation: "repositories.list",
                resource: "Organization repositories visible to the credential",
                credentialClasses: readerClasses,
                permissions: ["Repository metadata: read"],
                reference:
                    "https://docs.github.com/en/rest/repos/repos#list-organization-repositories",
            },
            {
                operation: "repositories.get",
                resource: "Declared organization repository",
                credentialClasses: readerClasses,
                permissions: ["Repository metadata: read"],
                reference:
                    "https://docs.github.com/en/rest/repos/repos#get-a-repository",
            },
            {
                operation: "repositories.properties",
                resource: "Repository custom property values",
                credentialClasses: readerClasses,
                permissions: ["Repository metadata: read"],
                reference:
                    "https://docs.github.com/en/rest/repos/custom-properties#get-all-custom-property-values-for-a-repository",
            },
            {
                operation: "activity.commits",
                resource: "Default-branch commits since the policy cutoff",
                credentialClasses: readerClasses,
                permissions: ["Repository contents: read"],
                reference:
                    "https://docs.github.com/en/rest/commits/commits#list-commits",
            },
            {
                operation: "activity.issues",
                resource: "Repository issue updates",
                credentialClasses: readerClasses,
                permissions: ["Repository issues: read"],
                reference:
                    "https://docs.github.com/en/graphql/reference/objects#repository",
            },
            {
                operation: "activity.pull-requests",
                resource:
                    "Repository pull request updates, not merge-only activity",
                credentialClasses: readerClasses,
                permissions: ["Repository pull requests: read"],
                reference:
                    "https://docs.github.com/en/graphql/reference/objects#repository",
            },
            {
                operation: "activity.discussions",
                resource: "Repository Discussion updates",
                credentialClasses: readerClasses,
                permissions: ["Repository discussions: read"],
                reference:
                    "https://docs.github.com/en/graphql/reference/objects#repository",
            },
            {
                operation: "activity.actions",
                resource:
                    "All returned pages of retained repository workflow runs",
                credentialClasses: readerClasses,
                permissions: ["Repository Actions: read"],
                reference:
                    "https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository",
            },
        ],
        inputs: [],
        artifacts: [
            "result.json",
            "summary.json",
            "summary.md",
            "evidence/",
            "diagnostics.jsonl",
        ],
        views: {
            defaultRows: 25,
            maxRows: 1000,
            order: "Repository identity ascending, case-insensitive.",
            filters: ["repository", "reason"],
        },
        limitations,
        recovery: [
            "Resume unfinished required reads under the original scope, policy, and cumulative allowance.",
            "Refresh aged evidence in a new run; never relabel original observations with a new collection timestamp.",
        ],
        skill: ".github/skills/repository-activity-inventory/SKILL.md",
        fixtures: ["tests/scenarios/activity.test.ts"],
    },
    inputSchema: z.strictObject({}),
    resultSchema,
    handler: (_input: JsonObject, context: ScenarioContext) =>
        collectInventory(context),
};
