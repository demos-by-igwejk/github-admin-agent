import type {
    ClientProblem,
    Collection,
    Coverage,
    JsonObject,
    JsonValue,
    ScenarioContext,
    WorkUnit,
} from "../core/contracts.ts";

export function object(value: JsonValue | undefined): JsonObject | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
export function items(
    collection: Collection,
): { value: JsonValue; evidenceId: string; observedAt: string }[] {
    return collection.pages.flatMap((page) =>
        (Array.isArray(page.data) ? page.data : [page.data]).map((value) => ({
            value,
            evidenceId: page.evidenceId,
            observedAt: page.observedAt,
        })),
    );
}
export function problemOutcome(problem: ClientProblem): WorkUnit["outcome"] {
    if (problem.kind === "cancelled") return "cancelled";
    if (problem.kind === "exhausted" || problem.kind === "provider-wait")
        return "waiting";
    return "failed";
}
export function collectionWork(id: string, collection: Collection): WorkUnit[] {
    const evidenceIds = collection.pages.map((page) => page.evidenceId);
    const work: WorkUnit[] =
        evidenceIds.length > 0 || collection.completeness === "complete"
            ? [{ id, required: true, outcome: "valid", evidenceIds }]
            : [];
    for (const [index, problem] of collection.problems.entries())
        work.push({
            id: `${id}:problem:${index}`,
            required: true,
            outcome: problemOutcome(problem),
            reasonCode: problem.diagnostic.code,
            evidenceIds: problem.diagnostic.evidenceId
                ? [problem.diagnostic.evidenceId]
                : [],
        });
    if (
        collection.completeness !== "complete" &&
        collection.problems.length === 0
    )
        work.push({
            id: `${id}:unfinished`,
            required: true,
            outcome: "unassessed",
            reasonCode: "incomplete_source",
            evidenceIds,
        });
    return work;
}
export interface RepositoryObservation {
    repository: string;
    data: JsonObject;
    evidenceId: string;
    observedAt: string;
}
export interface RepositoryDiscovery {
    repositories: RepositoryObservation[];
    work: WorkUnit[];
    coverage: Coverage;
}

export async function discoverRepositories(
    context: ScenarioContext,
): Promise<RepositoryDiscovery> {
    const { config, client } = context;
    const requested = config.selection.repositories;
    const declared =
        requested.length > 0 || config.selection.mode === "declared-targets";
    if (declared && requested.length === 0) {
        const evidence = context.addEvidence({
            operation: "repositories.list",
            target: config.org,
            observedAt: context.startedAt,
            source: "input:selection",
            data: { repositories: [] },
        });
        return {
            repositories: [],
            work: [
                {
                    id: "discovery:empty-declared-scope",
                    required: true,
                    outcome: "valid",
                    evidenceIds: [evidence.id],
                },
            ],
            coverage: {
                discovery: "declared-targets",
                requested: 0,
                observed: 0,
                assessed: 0,
                pagination: "not-applicable",
                unassessed: [],
                excluded: [],
                notes: [
                    "The operator explicitly requested an empty target list; no discovery request was made.",
                ],
            },
        };
    }
    const collections = declared
        ? await Promise.all(
              requested.map((fullName) => {
                  const [org, repo] = fullName.split("/");
                  if (org?.toLowerCase() !== config.org.toLowerCase())
                      throw new Error(
                          "scope_mismatch: Repository is outside the configured organization",
                      );
                  return client.collect("repositories.get", {
                      org: config.org,
                      repo,
                  });
              }),
          )
        : [await client.collect("repositories.list", { org: config.org })];
    const work = collections.flatMap((collection, index) =>
        collectionWork(
            `discovery:${declared ? requested[index] : config.org}`,
            collection,
        ),
    );
    const repositories: RepositoryObservation[] = [];
    for (const entry of collections.flatMap(items)) {
        const repo = object(entry.value);
        if (
            !repo ||
            typeof repo.full_name !== "string" ||
            repo.full_name.split("/")[0]?.toLowerCase() !==
                config.org.toLowerCase()
        ) {
            context.addDiagnostic({
                code: "invalid_repository",
                message:
                    "Repository identity is missing or outside the approved organization",
                retryable: false,
                remediation:
                    "Inspect the source contract and refresh after correcting it.",
                evidenceId: entry.evidenceId,
            });
            work.push({
                id: `discovery:invalid:${work.length}`,
                required: true,
                outcome: "failed",
                reasonCode: "invalid_repository",
                evidenceIds: [entry.evidenceId],
            });
            continue;
        }
        if (
            repositories.some(
                (existing) =>
                    existing.repository.toLowerCase() ===
                    repo.full_name?.toString().toLowerCase(),
            )
        )
            continue;
        repositories.push({
            repository: repo.full_name,
            data: repo,
            evidenceId: entry.evidenceId,
            observedAt: entry.observedAt,
        });
    }
    repositories.sort((a, b) => a.repository.localeCompare(b.repository, "en"));
    const excluded: string[] = [],
        unassessed: string[] = [];
    const selected: RepositoryObservation[] = [];
    for (const repo of repositories) {
        const filters = Object.entries(config.selection.properties);
        if (filters.length > 0) {
            const embedded = object(repo.data.custom_properties);
            let properties = embedded;
            if (!properties) {
                const collected = await client.collect(
                    "repositories.properties",
                    {
                        org: config.org,
                        repo: repo.repository.split("/")[1],
                    },
                );
                work.push(
                    ...collectionWork(
                        `properties:${repo.repository}`,
                        collected,
                    ),
                );
                if (collected.completeness !== "complete") {
                    unassessed.push(repo.repository);
                    continue;
                }
                properties = {};
                for (const entry of items(collected)) {
                    const property = object(entry.value);
                    if (
                        property &&
                        typeof property.property_name === "string" &&
                        typeof property.value === "string"
                    )
                        properties[property.property_name] = property.value;
                }
            }
            if (!filters.every(([key, value]) => properties[key] === value)) {
                excluded.push(repo.repository);
                continue;
            }
        }
        selected.push(repo);
    }
    const cap = config.selection.maxAssessments;
    if (cap !== undefined && selected.length > cap) {
        const capped = selected.splice(cap);
        excluded.push(...capped.map((repo) => repo.repository));
        work.push({
            id: "selection:assessment-cap",
            required: true,
            outcome: "policy-excluded",
            reasonCode: "assessment_cap",
            evidenceIds: [],
        });
    }
    return {
        repositories: selected,
        work,
        coverage: {
            discovery: declared ? "declared-targets" : "api-visible",
            requested: declared ? requested.length : null,
            observed: repositories.length,
            assessed: selected.length,
            pagination: collections.every(
                (collection) => collection.completeness === "complete",
            )
                ? "complete"
                : "partial",
            unassessed: [
                ...unassessed,
                ...requested.filter(
                    (name) =>
                        !repositories.some(
                            (repo) =>
                                repo.repository.toLowerCase() ===
                                name.toLowerCase(),
                        ),
                ),
            ],
            excluded,
            notes: [
                declared
                    ? "Coverage is limited to the declared targets."
                    : "Discovery is limited to repositories visible to this credential; organization-wide population is unverified.",
                ...(repositories.length === 0
                    ? [
                          declared
                              ? "No declared targets were observed."
                              : "The API-visible listing is empty; this does not prove the organization has no repositories.",
                      ]
                    : []),
                ...(cap !== undefined
                    ? [
                          `Deep assessment was explicitly capped at ${cap}; discovery counts remain separate.`,
                      ]
                    : []),
            ],
        },
    };
}
