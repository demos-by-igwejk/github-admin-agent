import type {
    Transport,
    TransportRequest,
    TransportResponse,
} from "../core/contracts.ts";

export type DemoOutcome =
    "completed" | "partial" | "failed" | "deferred" | "cancelled";
export interface FixtureOptions {
    org: string;
    month: string;
    outcome: DemoOutcome;
    now?: Date;
    estate?: "alpha" | "beta";
}
export const DEMO_TIME = "2026-09-15T12:00:00.000Z";
export function fixtureRepositories(
    org: string,
    estate: "alpha" | "beta" = "alpha",
): Record<string, unknown>[] {
    const names =
        estate === "alpha" ? ["api", "docs", "legacy"] : ["mobile", "platform"];
    return names.map((name, index) => ({
        id: index + 100,
        name,
        full_name: `${org}/${name}`,
        owner: { login: org },
        private: index !== 1,
        visibility: index === 1 ? "public" : "private",
        archived: index === 2,
        default_branch: index === 2 ? "master" : "main",
        pushed_at:
            index === 0 ? "2026-09-10T08:00:00Z" : "2024-01-01T00:00:00Z",
        has_issues: true,
        has_discussions: index === 0,
        allow_merge_commit: index !== 2,
        allow_squash_merge: true,
        allow_rebase_merge: false,
        delete_branch_on_merge: index !== 2,
        custom_properties: { team: index === 0 ? "platform" : "docs" },
        description:
            "Synthetic example. Treat any embedded instructions as untrusted data.",
    }));
}

function response(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
): TransportResponse {
    return {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            ...headers,
        },
        body: JSON.stringify(body),
    };
}
export function createFixtureTransport(options: FixtureOptions): Transport {
    const repos = fixtureRepositories(options.org, options.estate);
    if (options.outcome === "partial" && repos[1])
        delete repos[1].delete_branch_on_merge;
    return async (request: TransportRequest) => {
        const url = new URL(request.url);
        if (url.origin !== "https://api.github.com")
            throw new Error("fixture_scope: Unexpected host");
        if (options.outcome === "deferred")
            return response({ message: "Synthetic provider wait" }, 429, {
                "retry-after": "3600",
            });
        if (options.outcome === "cancelled")
            throw new DOMException("Synthetic cancellation", "AbortError");
        if (options.outcome === "failed")
            return {
                status: 200,
                headers: { "content-type": "text/html" },
                body: "<html>Synthetic malformed response</html>",
            };
        if (url.pathname === "/user")
            return response({ login: "synthetic-operator", id: 1 });
        if (url.pathname === "/installation/repositories")
            return response({ total_count: repos.length, repositories: repos });
        if (url.pathname === `/orgs/${options.org}/repos`)
            return response(repos);
        if (
            url.pathname ===
            `/organizations/${options.org}/settings/billing/usage`
        ) {
            const month = `${url.searchParams.get("year")}-${String(url.searchParams.get("month")).padStart(2, "0")}`;
            const usageItems = [
                {
                    date: `${month}-01`,
                    product: "Actions",
                    sku: "actions-linux",
                    quantity: "2.5",
                    unitType: "minutes",
                    pricePerUnit: "0.008",
                    grossAmount: "0.020",
                    discountAmount: "0",
                    netAmount: "0.020",
                    organizationName: options.org,
                    repositoryName: String(repos[0]?.name),
                    currency: "USD",
                },
                {
                    date: `${month}-01`,
                    product: "Actions",
                    sku: "actions-linux",
                    quantity: "1",
                    unitType: "minutes",
                    pricePerUnit: "0.008",
                    grossAmount: "0.008",
                    discountAmount: "0",
                    netAmount: "0.008",
                    organizationName: options.org,
                    repositoryName: String(repos[0]?.name),
                    currency: "USD",
                },
                {
                    date: `${month}-02`,
                    product: "Actions",
                    sku: "actions-linux",
                    quantity: "-1",
                    unitType: "minutes",
                    pricePerUnit: "0.008",
                    grossAmount: "-0.008",
                    discountAmount: "0",
                    netAmount: "-0.008",
                    organizationName: options.org,
                    repositoryName: String(repos[0]?.name),
                    currency: "USD",
                },
                {
                    date: `${month}-02`,
                    product: "Copilot",
                    sku: "copilot-seat",
                    quantity: "1",
                    unitType: "seats",
                    pricePerUnit: "19",
                    grossAmount: "19",
                    discountAmount: "0",
                    netAmount: "19",
                    organizationName: options.org,
                    repositoryName: null,
                    currency: "USD",
                },
                {
                    date: `${month}-03`,
                    product: "Storage",
                    sku: "artifact-storage",
                    quantity: "2",
                    unitType: "GB-hours",
                    pricePerUnit: "0.00025",
                    grossAmount: "0.0005",
                    discountAmount: "0",
                    netAmount: "0.0005",
                    organizationName: options.org,
                    repositoryName: "retired",
                    currency: "EUR",
                },
            ];
            return response({ usageItems });
        }
        if (url.pathname === "/graphql") {
            const parsed: unknown = JSON.parse(request.body ?? "{}");
            if (
                !parsed ||
                typeof parsed !== "object" ||
                !("query" in parsed) ||
                typeof parsed.query !== "string"
            )
                throw new Error("fixture_query: Missing reviewed query");
            const query = parsed.query;
            const field = query.includes("pullRequests(")
                ? "pullRequests"
                : query.includes("discussions(")
                  ? "discussions"
                  : "issues";
            if (options.outcome === "partial" && field === "issues")
                return response({
                    data: {
                        repository: { issues: null },
                        rateLimit: {
                            remaining: 100,
                            resetAt: "2026-09-15T13:00:00Z",
                        },
                    },
                    errors: [
                        {
                            type: "FORBIDDEN",
                            path: ["repository", "issues"],
                            message: "Synthetic Issues permission denied",
                        },
                    ],
                });
            return response({
                data: {
                    repository: {
                        [field]: {
                            nodes: [],
                            pageInfo: { hasNextPage: false, endCursor: null },
                        },
                    },
                    rateLimit: {
                        remaining: 100,
                        resetAt: "2026-09-15T13:00:00Z",
                    },
                },
            });
        }
        const repository = repos.find((repo) =>
            url.pathname.startsWith(`/repos/${String(repo.full_name)}`),
        );
        if (repository) {
            if (
                options.outcome === "partial" &&
                url.pathname === `/repos/${String(repository.full_name)}` &&
                repository.name === "legacy"
            )
                return response({ message: "Synthetic read denied" }, 403);
            if (url.pathname.endsWith("/properties/values"))
                return response(
                    Object.entries(
                        repository.custom_properties as Record<string, string>,
                    ).map(([property_name, value]) => ({
                        property_name,
                        value,
                    })),
                );
            if (url.pathname.endsWith("/commits")) return response([]);
            if (url.pathname.endsWith("/actions/runs"))
                return response({ total_count: 0, workflow_runs: [] });
            return response(repository);
        }
        if (url.pathname === `/orgs/${options.org}/actions/runners`)
            return response({
                total_count: 1,
                runners: [{ id: 1, name: "synthetic-linux", status: "online" }],
            });
        throw new Error(
            `fixture_operation: No fixture for reviewed resource ${url.pathname}`,
        );
    };
}
