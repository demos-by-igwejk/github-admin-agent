import { z } from "zod";
import {
    scenarioResultSchema,
    type JsonObject,
    type ScenarioDefinition,
    type ScenarioResult,
    type ScenarioRow,
    type WorkUnit,
} from "../../core/contracts.ts";
import { policySchema } from "../../core/config.ts";
import { collectionWork, discoverRepositories, object } from "../shared.ts";

const outcomes = ["compliant", "drift", "unknown", "not_applicable"] as const;
const findingSchema = z.object({
    id: z.string(),
    repository: z.string(),
    rule: z.string(),
    setting: z.string(),
    expected: z.union([z.string(), z.boolean()]),
    observed: z.union([z.string(), z.boolean(), z.null()]),
    outcome: z.enum(outcomes),
    observedAt: z.string().nullable(),
    source: z.string().nullable(),
    evidenceIds: z.array(z.string()),
    reason: z.string().optional(),
});
const resultSchema = scenarioResultSchema.superRefine((result, context) => {
    for (const [index, row] of result.rows.entries()) {
        const parsed = findingSchema.safeParse(row);
        if (!parsed.success)
            for (const issue of parsed.error.issues)
                context.addIssue({
                    code: "custom",
                    path: ["rows", index, ...issue.path],
                    message: issue.message,
                });
    }
});

export const settingsScenario: ScenarioDefinition = {
    manifest: {
        id: "repository-settings-audit",
        version: "1.0.0",
        status: "implemented",
        title: "Repository settings audit",
        description:
            "Compare observed repository settings with an explicit versioned baseline without changing GitHub.",
        intentExamples: [
            "Which repositories differ from our declared settings baseline?",
            "Show merge-setting drift for selected repositories.",
        ],
        risk: "read-only",
        modes: ["inspect"],
        platforms: ["github.com"],
        capabilities: [
            "repositories.list",
            "repositories.get",
            "repositories.properties",
        ].map((operation) => ({
            operation: z
                .enum([
                    "repositories.list",
                    "repositories.get",
                    "repositories.properties",
                ])
                .parse(operation),
            resource:
                operation === "repositories.list"
                    ? "/orgs/{org}/repos"
                    : operation === "repositories.get"
                      ? "/repos/{org}/{repo}"
                      : "/repos/{org}/{repo}/properties/values",
            credentialClasses: [
                "oauth",
                "classic-pat",
                "fine-grained-pat",
                "app-installation",
                "app-user",
            ],
            permissions: [
                "Repository metadata read; endpoint-specific access remains subject to live acceptance.",
                "OAuth private-repository access uses the broader repo scope; gh browser login also includes read:org and gist. Only the collector operation set is read-only.",
            ],
            reference: "https://docs.github.com/en/rest/repos/repos",
        })),
        inputs: [
            {
                name: "policy",
                defaultPath: "config/policies/repositories.json",
                required: true,
                sensitivity: "configuration",
            },
        ],
        artifacts: [
            "result.json",
            "summary.json",
            "summary.md",
            "evidence/evidence.json",
            "diagnostics.jsonl",
            "exports/rows.json",
        ],
        views: {
            defaultRows: 50,
            maxRows: 1000,
            order: "repository then stable rule ID",
            filters: ["repository", "reason"],
        },
        limitations: [
            "This is a policy comparison, not compliance certification or remediation.",
            "Absent fields and denied reads are unknown, not drift.",
            "Population is limited to the declared or API-visible scope.",
        ],
        recovery: [
            "Resume compatible unfinished reads; refresh explicitly for a new observation.",
        ],
        skill: ".github/skills/repository-settings-audit/SKILL.md",
        fixtures: [
            "settings-match",
            "settings-drift",
            "settings-unknown",
            "settings-not-applicable",
        ],
    },
    inputSchema: z.strictObject({}),
    resultSchema,
    async handler(_input, context): Promise<ScenarioResult> {
        const policy = policySchema.parse(context.inputs.policy);
        const discovery = await discoverRepositories(context);
        const rows: ScenarioRow[] = [],
            work: WorkUnit[] = [...discovery.work];
        const totals: JsonObject = {
            compliant: 0,
            drift: 0,
            unknown: 0,
            not_applicable: 0,
            repositories: discovery.repositories.length,
            policy: policy.name,
        };
        for (const repository of discovery.repositories) {
            let data = repository.data,
                evidenceId = repository.evidenceId,
                observedAt = repository.observedAt;
            const needsDetail = policy.rules.some(
                (rule) =>
                    (!rule.repositories ||
                        rule.repositories.some(
                            (name) =>
                                name.toLowerCase() ===
                                repository.repository.toLowerCase(),
                        )) &&
                    data[rule.setting] === undefined,
            );
            if (needsDetail) {
                const collection = await context.client.collect(
                    "repositories.get",
                    {
                        org: context.config.org,
                        repo: repository.repository.split("/")[1],
                    },
                );
                work.push(
                    ...collectionWork(
                        `settings-detail:${repository.repository}`,
                        collection,
                    ),
                );
                const page = collection.pages[0];
                const detail = object(page?.data);
                if (
                    page &&
                    detail &&
                    typeof detail.full_name === "string" &&
                    detail.full_name.toLowerCase() ===
                        repository.repository.toLowerCase()
                ) {
                    data = detail;
                    evidenceId = page.evidenceId;
                    observedAt = page.observedAt;
                } else if (collection.completeness === "complete") {
                    const diagnostic = context.addDiagnostic({
                        code: "settings_identity_mismatch",
                        message:
                            "Settings detail does not identify the requested repository.",
                        operation: "repositories.get",
                        target: repository.repository,
                        evidenceId: page?.evidenceId,
                        retryable: false,
                        remediation:
                            "Inspect the source identity contract before refreshing.",
                    });
                    work.push({
                        id: `settings-identity:${repository.repository}`,
                        required: true,
                        outcome: "failed",
                        reasonCode: diagnostic.code,
                        evidenceIds: page ? [page.evidenceId] : [],
                    });
                }
            }
            for (const rule of policy.rules) {
                const applicable =
                    !rule.repositories ||
                    rule.repositories.some(
                        (name) =>
                            name.toLowerCase() ===
                            repository.repository.toLowerCase(),
                    );
                const actual = data[rule.setting];
                const valid =
                    typeof actual === typeof rule.expected &&
                    (typeof actual === "string" ||
                        typeof actual === "boolean") &&
                    (rule.setting !== "visibility" ||
                        actual === "public" ||
                        actual === "private" ||
                        actual === "internal") &&
                    (rule.setting !== "default_branch" ||
                        (typeof actual === "string" && actual.length > 0));
                const outcome = !applicable
                    ? "not_applicable"
                    : !valid
                      ? "unknown"
                      : actual === rule.expected
                        ? "compliant"
                        : "drift";
                const id = `${repository.repository}:${rule.id}`;
                const reason = !applicable
                    ? "rule_not_applicable"
                    : !valid
                      ? "settings_field_unavailable"
                      : undefined;
                if (outcome === "unknown")
                    context.addDiagnostic({
                        code: "settings_field_unavailable",
                        message: `Required setting ${rule.setting} is absent or has an invalid type.`,
                        operation: "repositories.get",
                        target: repository.repository,
                        retryable: true,
                        remediation:
                            "Check endpoint permissions and field availability, then resume or refresh.",
                        evidenceId,
                    });
                rows.push({
                    id,
                    repository: repository.repository,
                    rule: rule.id,
                    setting: rule.setting,
                    expected: rule.expected,
                    observed:
                        valid &&
                        applicable &&
                        (typeof actual === "string" ||
                            typeof actual === "boolean")
                            ? actual
                            : null,
                    outcome,
                    observedAt,
                    source:
                        context.evidence.find((item) => item.id === evidenceId)
                            ?.source ?? `evidence:${evidenceId}`,
                    evidenceIds: [evidenceId],
                    ...(reason ? { reason } : {}),
                });
                work.push({
                    id: `settings-rule:${id}`,
                    required: true,
                    outcome:
                        outcome === "unknown"
                            ? "failed"
                            : !applicable
                              ? "policy-excluded"
                              : "valid",
                    ...(reason ? { reasonCode: reason } : {}),
                    evidenceIds: [evidenceId],
                });
                totals[outcome] = Number(totals[outcome]) + 1;
            }
        }
        for (const repository of discovery.coverage.unassessed) {
            for (const rule of policy.rules) {
                rows.push({
                    id: `${repository}:${rule.id}`,
                    repository,
                    rule: rule.id,
                    setting: rule.setting,
                    expected: rule.expected,
                    observed: null,
                    outcome: "unknown",
                    observedAt: null,
                    source: null,
                    evidenceIds: [],
                    reason: "settings_repository_unassessed",
                });
                totals.unknown = Number(totals.unknown) + 1;
            }
        }
        rows.sort((left, right) => left.id.localeCompare(right.id, "en"));
        return {
            rows,
            totals,
            work,
            coverage: discovery.coverage,
            limitations: [
                ...settingsScenario.manifest.limitations,
                `Baseline: ${policy.name} (schema ${policy.schemaVersion}). No GitHub mutations were performed.`,
            ],
        };
    },
};
