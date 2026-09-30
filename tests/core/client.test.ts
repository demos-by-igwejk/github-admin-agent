import { test } from "node:test";
import assert from "node:assert/strict";
import {
    API_VERSION,
    type BudgetLimits,
    type ClientOptions,
    type Collection,
    type Diagnostic,
    type Evidence,
    type JsonObject,
    type JsonValue,
    type OperationId,
    type Transport,
    type TransportRequest,
    type TransportResponse,
} from "../../src/core/contracts.ts";
import {
    createClient,
    MAX_RESPONSE_BYTES,
    reviewedOperations,
} from "../../src/core/client.ts";
import { clientOptions, MemoryBudget, TestClock } from "../helpers.ts";

const org = "example-org";
const base = "https://api.github.com";
const repos = `${base}/orgs/${org}/repos?type=all&per_page=100&sort=full_name`;
const instant = "2026-09-15T12:00:00.000Z";
const reset = "2026-09-15T13:00:00.000Z";
const node = { id: "issue-1", updatedAt: "2026-09-15T11:00:00Z" };

function response(
    body: JsonValue,
    headers: Record<string, string> = {},
    status = 200,
): TransportResponse {
    return {
        status,
        body: JSON.stringify(body),
        headers: {
            "content-type": "application/json; charset=utf-8",
            ...headers,
        },
    };
}
function graph(
    field = "issues",
    nodes: JsonValue[] = [node],
    hasNextPage = false,
    endCursor: string | null = null,
): JsonObject {
    return {
        data: {
            repository: {
                [field]: { nodes, pageInfo: { hasNextPage, endCursor } },
            },
            rateLimit: { remaining: 100, resetAt: reset },
        },
    };
}
function harness(
    implementation: Transport,
    overrides: Partial<ClientOptions> = {},
    limits: Partial<BudgetLimits> = {},
) {
    const clock = overrides.clock ?? new TestClock();
    const budget = overrides.budget ?? new MemoryBudget(limits, clock);
    const evidence: Evidence[] = [],
        diagnostics: Diagnostic[] = [],
        requests: TransportRequest[] = [];
    const checkpoints: {
        cache: Record<string, Collection>;
        evidence: number;
        diagnostics: number;
    }[] = [];
    const events: string[] = [];
    const cache = overrides.cache ?? {};
    const options = clientOptions({
        clock,
        budget,
        capabilities: reviewedOperations,
        cache,
        addEvidence(value) {
            const item = {
                ...value,
                id: `e${evidence.length + 1}`,
                synthetic: true,
            };
            evidence.push(item);
            events.push(item.id);
            return item;
        },
        addDiagnostic(value) {
            const item = { ...value, id: `d${diagnostics.length + 1}` };
            diagnostics.push(item);
            events.push(item.id);
            return item;
        },
        checkpoint: async (value) => {
            events.push("checkpoint");
            checkpoints.push({
                cache: structuredClone(value),
                evidence: evidence.length,
                diagnostics: diagnostics.length,
            });
        },
        ...overrides,
        transport: async (request) => {
            requests.push(request);
            return implementation(request);
        },
    });
    return {
        client: createClient(options),
        options,
        clock,
        budget,
        evidence,
        diagnostics,
        requests,
        checkpoints,
        events,
        cache,
    };
}
async function until(predicate: () => boolean): Promise<void> {
    for (let count = 0; count < 100 && !predicate(); count++)
        await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(
        predicate(),
        "asynchronous request reached its expected boundary",
    );
}
function firstObject(collection: Collection): JsonObject {
    const data = collection.pages[0]?.data;
    assert.ok(data && !Array.isArray(data) && typeof data === "object");
    return data;
}

test("reviewed adapters construct only fixed read requests and preserve page containers", async () => {
    const cases: {
        operation: OperationId;
        args: {
            org: string;
            repo?: string;
            branch?: string;
            since?: string;
            month?: string;
        };
        url: string;
        body: JsonValue;
        data: JsonValue;
    }[] = [
        {
            operation: "identity.user",
            args: { org },
            url: `${base}/user`,
            body: { id: 1, login: "reader" },
            data: { id: 1, login: "reader" },
        },
        {
            operation: "repositories.list",
            args: { org },
            url: repos,
            body: [],
            data: [],
        },
        {
            operation: "repositories.get",
            args: { org, repo: "one" },
            url: `${base}/repos/${org}/one`,
            body: { name: "one" },
            data: { name: "one" },
        },
        {
            operation: "repositories.properties",
            args: { org, repo: "one" },
            url: `${base}/repos/${org}/one/properties/values`,
            body: [],
            data: [],
        },
        {
            operation: "activity.commits",
            args: { org, repo: "one", branch: "feature/a&b", since: instant },
            url: `${base}/repos/${org}/one/commits?sha=feature%2Fa%26b&since=2026-09-15T12%3A00%3A00.000Z&per_page=100`,
            body: [],
            data: [],
        },
        {
            operation: "activity.actions",
            args: { org, repo: "one" },
            url: `${base}/repos/${org}/one/actions/runs?per_page=100`,
            body: {
                total_count: 1,
                workflow_runs: [{ id: 1, updated_at: instant }],
            },
            data: [{ id: 1, updated_at: instant }],
        },
        {
            operation: "billing.usage",
            args: { org, month: "2026-08" },
            url: `${base}/organizations/${org}/settings/billing/usage?year=2026&month=8`,
            body: { usageItems: [] },
            data: { usageItems: [] },
        },
        {
            operation: "conformance.runners",
            args: { org },
            url: `${base}/orgs/${org}/actions/runners?per_page=100`,
            body: { total_count: 0, runners: [] },
            data: [],
        },
    ];
    for (const item of cases) {
        const h = harness(async () => response(item.body), {
            token: "offline-test-token",
        });
        const result = await h.client.collect(item.operation, item.args);
        assert.equal(result.completeness, "complete", item.operation);
        assert.deepEqual(result.pages[0]?.data, item.data);
        assert.equal(h.requests[0]?.url, item.url);
        assert.equal(h.requests[0]?.method, "GET");
        assert.equal(h.requests[0]?.body, undefined);
        assert.deepEqual(h.requests[0]?.headers, {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            Authorization: "Bearer offline-test-token",
        });
        assert.equal(h.budget.snapshot().attempts, 1);
        assert.equal(h.evidence[0]?.observedAt, instant);
        assert.equal(h.checkpoints[0]?.evidence, 1);
    }
});

test("host, target, capability, and argument misuse fails before transport", async () => {
    let calls = 0;
    const transport: Transport = async () => {
        calls++;
        return response([]);
    };
    for (const host of [
        "example.ghe.com",
        "https://api.github.com",
        "api.github.com",
        "github.com.evil.test",
    ]) {
        assert.throws(
            () => createClient(clientOptions({ host, transport })),
            /unsupported_deployment/,
        );
    }
    assert.throws(
        () =>
            createClient(
                clientOptions({
                    transport,
                    capabilities: ["unreviewed" as OperationId],
                }),
            ),
        /unsupported_capability/,
    );
    assert.throws(
        () => createClient(clientOptions()),
        /synthetic_transport_required/,
    );
    assert.throws(
        () =>
            createClient(clientOptions({ transport, token: "unsafe\nheader" })),
        /invalid_credential/,
    );
    const h = harness(transport, {
        capabilities: [
            "repositories.list",
            "repositories.get",
            "activity.commits",
        ],
    });
    await assert.rejects(
        h.client.collect("conformance.runners", { org }),
        /unsupported_capability/,
    );
    await assert.rejects(
        h.client.collect("billing.usage", { org, month: "2026-08" }),
        /unsupported_capability/,
    );
    await assert.rejects(
        h.client.collect("mutation.delete" as OperationId, { org }),
        /unsupported_capability/,
    );
    await assert.rejects(
        h.client.collect("repositories.list", { org: "another-org" }),
        /scope_mismatch/,
    );
    for (const repo of [
        "../two",
        "..",
        ".",
        "one/two",
        "one%2Ftwo",
        "one\\two",
    ]) {
        await assert.rejects(
            h.client.collect("repositories.get", { org, repo }),
            /invalid_repository/,
        );
    }
    await assert.rejects(
        h.client.collect("activity.commits", {
            org,
            repo: "one",
            since: instant,
        }),
        /invalid_branch/,
    );
    const extra = {
        org,
        url: "https://evil.test/",
        query: "mutation { deleteRepository }",
        payload: {},
    };
    await assert.rejects(
        h.client.collect("repositories.list", extra),
        /invalid_operation_args/,
    );
    assert.equal(calls, 0);
    assert.equal(h.budget.snapshot().attempts, 0);
});

test("mutating the options object cannot expand the client organization or capability scope", async () => {
    const h = harness(async () => response([]), {
        capabilities: ["repositories.list"],
    });
    h.options.org = "another-org";
    h.options.capabilities = reviewedOperations;
    await assert.rejects(
        h.client.collect("repositories.list", { org: "another-org" }),
        /scope_mismatch/,
    );
    await assert.rejects(
        h.client.collect("billing.usage", { org, month: "2026-08" }),
        /unsupported_capability/,
    );
    assert.equal(
        (await h.client.collect("repositories.list", { org })).completeness,
        "complete",
    );
    assert.equal(h.requests[0]?.url, repos);
});

test("REST pagination preserves fixed query scope and completes a validated empty last page", async () => {
    const h = harness(async (request) => {
        if (!new URL(request.url).searchParams.has("page"))
            return response([{ id: 1 }], {
                link: `<${repos}&page=2>; rel="next", <${repos}&page=2>; rel="last"`,
            });
        return response([], {
            link: `<${repos}&page=1>; rel="prev", <${repos}&page=1>; rel="first"`,
        });
    });
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "complete");
    assert.deepEqual(
        result.pages.map((page) => page.data),
        [[{ id: 1 }], []],
    );
    assert.equal(h.requests.length, 2);
    assert.equal(
        h.checkpoints[0]?.cache[Object.keys(h.cache)[0]!]!.completeness,
        "partial",
    );
    assert.equal(
        h.checkpoints[1]?.cache[Object.keys(h.cache)[0]!]!.completeness,
        "complete",
    );
});

test("REST page links reject repeated, duplicate, encoded, credentialed, and escaping scope", async () => {
    const links = [
        `<${repos}&page=1>; rel="next"`,
        `<${repos}&page=3>; rel="next"`,
        `<${repos}&page=2>; rel="next", <${repos}&page=2>; rel="next"`,
        `<${repos}&page=2&page=3>; rel="next"`,
        `<${repos}&page=2&%70age=3>; rel="next"`,
        `<${repos}&page=2&%74ype=private>; rel="next"`,
        `<${repos}&page=2&extra=1>; rel="next"`,
        `<${repos.replace("type=all", "type=private")}&page=2>; rel="next"`,
        `<${repos.replace("type=all&", "")}&page=2>; rel="next"`,
        `<${repos.replace("per_page=100", "per_page=10")}&page=2>; rel="next"`,
        `<${repos.replace("sort=full_name", "sort=full_name%26org%3Devil")}&page=2>; rel="next"`,
        `<${repos.replace(base, "https://evil.test")}&page=2>; rel="next"`,
        `<${repos.replace(org, "another-org")}&page=2>; rel="next"`,
        `<${repos.replace("/repos?", "/%72epos?")}&page=2>; rel="next"`,
        `<${repos.replace("https://", "https://user:password@")}&page=2>; rel="next"`,
        `<${repos.replace("https://", "https://@")}&page=2>; rel="next"`,
        `<${repos}&page=2#fragment>; rel="next"`,
        `<${repos}&page=2#>; rel="next"`,
        `<${repos}&page=2>; rel="last"`,
        `<${repos}&page=2>; rel="prev"`,
        `<${repos}&page=2>; rel="first"`,
        `<${repos}&page=2>; rel="alternate"`,
        "not-a-link",
    ];
    for (const link of links) {
        const h = harness(async () => response([{ id: 1 }], { link }));
        const result = await h.client.collect("repositories.list", { org });
        assert.equal(result.completeness, "partial", link);
        assert.equal(result.pages.length, 1, link);
        assert.equal(
            result.problems[0]?.kind,
            "unsupported-continuation",
            link,
        );
        assert.equal(h.requests.length, 1, link);
        assert.equal(result.problems[0]?.diagnostic.evidenceId, "e1");
    }
});

test("relative and reordered links are accepted only when required query values are unchanged", async () => {
    const h = harness(async (request) =>
        new URL(request.url).searchParams.has("page")
            ? response([])
            : response([], {
                  link: `</orgs/${org}/repos?page=2&sort=full_name&per_page=100&type=all>; rel="next"`,
              }),
    );
    assert.equal(
        (await h.client.collect("repositories.list", { org })).completeness,
        "complete",
    );
    assert.equal(h.requests.length, 2);
});

test("actions, commits, properties, and runners follow advertised pages rather than item counts", async () => {
    const cases: {
        operation: OperationId;
        args: { org: string; repo?: string; branch?: string; since?: string };
        first: JsonValue;
        second: JsonValue;
    }[] = [
        {
            operation: "activity.actions",
            args: { org, repo: "one" },
            first: { workflow_runs: [] },
            second: { workflow_runs: [{ id: 7 }] },
        },
        {
            operation: "activity.commits",
            args: { org, repo: "one", branch: "main", since: instant },
            first: [],
            second: [{ sha: "abc" }],
        },
        {
            operation: "repositories.properties",
            args: { org, repo: "one" },
            first: [],
            second: [{ property_name: "owner", value: "team" }],
        },
        {
            operation: "conformance.runners",
            args: { org },
            first: { runners: [] },
            second: { runners: [{ id: 2 }] },
        },
    ];
    for (const item of cases) {
        const h = harness(async (request) => {
            const url = new URL(request.url);
            if (url.searchParams.has("page")) return response(item.second);
            url.searchParams.set("page", "2");
            return response(item.first, { link: `<${url}>; rel="next"` });
        });
        const result = await h.client.collect(item.operation, item.args);
        assert.equal(result.completeness, "complete");
        assert.equal(result.pages.length, 2);
        assert.ok(result.pages.every((page) => Array.isArray(page.data)));
        assert.equal(h.requests.length, 2);
    }
});

test("a declared Actions or runner count cannot be silently truncated without a continuation", async () => {
    for (const operation of [
        "activity.actions",
        "conformance.runners",
    ] as const) {
        const h = harness(async () =>
            response(
                operation === "activity.actions"
                    ? { total_count: 3, workflow_runs: [{ id: 1 }] }
                    : { total_count: 3, runners: [] },
            ),
        );
        const result = await h.client.collect(
            operation,
            operation === "activity.actions" ? { org, repo: "one" } : { org },
        );
        assert.equal(result.completeness, "partial");
        assert.equal(
            result.problems[0]?.diagnostic.code,
            "pagination_count_mismatch",
        );
        assert.equal(h.requests.length, 1);
        assert.equal(result.pages.length, 1);
    }
    const h = harness(async (request) =>
        new URL(request.url).searchParams.has("page")
            ? response({ total_count: 2, runners: [{ id: 2 }] })
            : response(
                  { total_count: 2, runners: [{ id: 1 }] },
                  { link: `<${request.url}&page=2>; rel="next"` },
              ),
    );
    assert.equal(
        (await h.client.collect("conformance.runners", { org })).completeness,
        "complete",
    );
});

test("malformed JSON, HTML, ambiguous keys, and incorrect endpoint containers cannot complete", async () => {
    const cases: {
        operation: OperationId;
        args: { org: string; repo?: string; month?: string };
        result: TransportResponse;
    }[] = [
        {
            operation: "repositories.list",
            args: { org },
            result: {
                status: 200,
                headers: { "content-type": "text/html" },
                body: "<html>not data</html>",
            },
        },
        {
            operation: "repositories.list",
            args: { org },
            result: { status: 200, headers: {}, body: "[]" },
        },
        {
            operation: "repositories.list",
            args: { org },
            result: { ...response([]), body: "[" },
        },
        { operation: "repositories.list", args: { org }, result: response({}) },
        {
            operation: "repositories.get",
            args: { org, repo: "one" },
            result: response([]),
        },
        {
            operation: "repositories.properties",
            args: { org, repo: "one" },
            result: response({ values: [] }),
        },
        {
            operation: "activity.actions",
            args: { org, repo: "one" },
            result: response({ workflow_runs: null }),
        },
        {
            operation: "conformance.runners",
            args: { org },
            result: response({ runners: {} }),
        },
        {
            operation: "billing.usage",
            args: { org, month: "2026-08" },
            result: response({}),
        },
        {
            operation: "billing.usage",
            args: { org, month: "2026-08" },
            result: response({ usageItems: {} }),
        },
        {
            operation: "billing.usage",
            args: { org, month: "2026-08" },
            result: {
                ...response({}),
                body: '{"usageItems":[],"usageItems":[{}]}',
            },
        },
        {
            operation: "billing.usage",
            args: { org, month: "2026-08" },
            result: {
                ...response({}),
                body: '{"__proto__":{"usageItems":[]}}',
            },
        },
    ];
    for (const item of cases) {
        const h = harness(async () => item.result);
        const result = await h.client.collect(item.operation, item.args);
        assert.equal(result.completeness, "none", item.operation);
        assert.equal(result.problems[0]?.kind, "invalid");
        assert.equal(h.requests.length, 1);
        assert.equal(h.evidence.length, 0);
    }
});

test("billing numeric lexemes and legitimate metadata are preserved exactly, including null", async () => {
    const body =
        '{"usageItems":[{"netAmount":9007199254740993.123456789,"discountAmount":-0.00000000000000000001,"grossAmount":1.20e+3,"nullable":null}],"year":2026,"month":8,"currency":"USD","next":null,"hasMore":false}';
    const h = harness(async () => ({ ...response({}), body }));
    const result = await h.client.collect("billing.usage", {
        org,
        month: "2026-08",
    });
    assert.equal(result.completeness, "complete");
    assert.deepEqual(firstObject(result), {
        usageItems: [
            {
                netAmount: "9007199254740993.123456789",
                discountAmount: "-0.00000000000000000001",
                grossAmount: "1.20e+3",
                nullable: null,
            },
        ],
        year: "2026",
        month: "8",
        currency: "USD",
        next: null,
        hasMore: false,
    });
});

test("AC-26 billing continuations preserve one validated partition and are never followed", async () => {
    const variants: {
        headers?: Record<string, string>;
        metadata?: JsonObject;
    }[] = [
        {
            headers: {
                link: `<${base}/organizations/${org}/settings/billing/usage?year=2026&month=8&page=2>; rel="next"`,
            },
        },
        { headers: { "x-next-page": "2" } },
        { headers: { "x-continuation-token": "opaque" } },
        { metadata: { next: "https://evil.test/" } },
        { metadata: { pagination: { nextCursor: "opaque" } } },
        { metadata: { pagination: { next_page_token: "opaque" } } },
        { metadata: { pagination: { next_page_url: "https://evil.test/" } } },
        { metadata: { _links: [{ rel: "next", href: "https://evil.test/" }] } },
        { metadata: { pageInfo: { hasNextPage: true, endCursor: "opaque" } } },
        { metadata: { pageInfo: { endCursor: "opaque" } } },
        { metadata: { has_more: true } },
        { metadata: { totalPages: 2 } },
    ];
    for (const variant of variants) {
        const h = harness(async () =>
            response(
                { usageItems: [{ netAmount: "1.25" }], ...variant.metadata },
                variant.headers,
            ),
        );
        const result = await h.client.collect("billing.usage", {
            org,
            month: "2026-08",
        });
        assert.equal(result.completeness, "partial");
        assert.equal(
            result.problems[0]?.diagnostic.code,
            "unsupported_billing_continuation",
        );
        assert.deepEqual(firstObject(result).usageItems, [
            { netAmount: "1.25" },
        ]);
        assert.equal(h.requests.length, 1);
        assert.equal(h.checkpoints[0]?.diagnostics, 1);
        assert.deepEqual(h.events.slice(0, 3), ["e1", "d1", "checkpoint"]);
    }
});

test("each GraphQL adapter uses a fixed ordered read and honors cursors even on empty pages", async () => {
    const cases: [OperationId, string][] = [
        ["activity.issues", "issues"],
        ["activity.pull-requests", "pullRequests"],
        ["activity.discussions", "discussions"],
    ];
    for (const [operation, field] of cases) {
        const h = harness(async (request) => {
            const payload = JSON.parse(request.body!) as {
                variables: { after: string | null };
            };
            return response(
                payload.variables.after === null
                    ? graph(field, [], true, "cursor-1")
                    : graph(field, [node], false, "cursor-2"),
            );
        });
        const result = await h.client.collect(operation, { org, repo: "one" });
        assert.equal(result.completeness, "complete");
        assert.deepEqual(
            result.pages.map((page) => page.data),
            [[], [node]],
        );
        assert.equal(h.requests.length, 2);
        const first = JSON.parse(h.requests[0]!.body!) as {
            query: string;
            variables: JsonObject;
        };
        const second = JSON.parse(h.requests[1]!.body!) as {
            query: string;
            variables: JsonObject;
        };
        assert.equal(first.query, second.query);
        assert.match(
            first.query,
            /orderBy: \{field: UPDATED_AT, direction: DESC\}/,
        );
        assert.match(first.query, /nodes \{ id updatedAt \}/);
        assert.match(first.query, /rateLimit \{ remaining resetAt \}/);
        assert.doesNotMatch(first.query, /mutation/);
        assert.deepEqual(first.variables, {
            owner: org,
            name: "one",
            after: null,
        });
        assert.deepEqual(second.variables, {
            owner: org,
            name: "one",
            after: "cursor-1",
        });
        assert.ok(
            h.requests.every(
                (request) =>
                    request.url === `${base}/graphql` &&
                    request.method === "POST",
            ),
        );
    }
});

test("GraphQL missing fields, incomplete pageInfo, invalid nodes, and field errors never establish negative evidence", async () => {
    const bodies: JsonValue[] = [
        { data: { repository: null } },
        {
            data: {
                repository: { issues: { nodes: [] } },
                rateLimit: { remaining: 1, resetAt: reset },
            },
        },
        {
            data: {
                repository: {
                    issues: { nodes: [], pageInfo: { hasNextPage: false } },
                },
                rateLimit: { remaining: 1, resetAt: reset },
            },
        },
        {
            data: {
                repository: {
                    issues: {
                        nodes: [],
                        pageInfo: { hasNextPage: true, endCursor: null },
                    },
                },
                rateLimit: { remaining: 1, resetAt: reset },
            },
        },
        {
            data: {
                repository: {
                    issues: {
                        nodes: [],
                        pageInfo: { hasNextPage: false, endCursor: null },
                    },
                },
            },
        },
        {
            data: {
                repository: {
                    issues: {
                        nodes: [],
                        pageInfo: { hasNextPage: false, endCursor: null },
                    },
                },
                rateLimit: { remaining: 1, resetAt: 1789473600 },
            },
        },
        {
            data: {
                repository: {
                    issues: {
                        nodes: [],
                        pageInfo: { hasNextPage: false, endCursor: null },
                    },
                },
                rateLimit: { remaining: 1, resetAt: "2026-02-30T12:00:00Z" },
            },
        },
        graph("issues", [{ id: "broken", updatedAt: null }]),
        graph("issues", [{ id: "broken", updatedAt: "2026-02-30T12:00:00Z" }]),
        {
            ...graph("issues", []),
            errors: [{ type: "FORBIDDEN", message: "field inaccessible" }],
        },
    ];
    for (const body of bodies) {
        const h = harness(async () => response(body));
        const result = await h.client.collect("activity.issues", {
            org,
            repo: "one",
        });
        assert.notEqual(result.completeness, "complete");
        assert.equal(result.pages.length, 0);
        assert.ok(result.problems.length > 0);
        assert.equal(h.requests.length, 1);
    }
});

test("GraphQL field errors retain valid positive nodes and continue a valid declared cursor", async () => {
    const h = harness(async (request) => {
        const payload = JSON.parse(request.body!) as {
            variables: { after: string | null };
        };
        return response(
            payload.variables.after === null
                ? {
                      ...graph(
                          "issues",
                          [node, { id: "bad", updatedAt: null }],
                          true,
                          "next",
                      ),
                      errors: [
                          {
                              type: "FORBIDDEN",
                              path: ["repository", "issues", "nodes", 1],
                          },
                      ],
                  }
                : graph("issues", [{ ...node, id: "issue-2" }]),
        );
    });
    const result = await h.client.collect("activity.issues", {
        org,
        repo: "one",
    });
    assert.equal(result.completeness, "partial");
    assert.deepEqual(result.pages[0]?.data, [node]);
    assert.equal(result.pages.length, 2);
    assert.equal(h.requests.length, 2);
    assert.ok(
        result.problems.some(
            (problem) => problem.diagnostic.code === "graphql_errors",
        ),
    );
    assert.ok(
        result.problems.every(
            (problem) => problem.diagnostic.evidenceId === "e1",
        ),
    );
});

test("repeated GraphQL cursors stop with retained observations", async () => {
    const h = harness(async () =>
        response(graph("issues", [node], true, "same-cursor")),
    );
    const result = await h.client.collect("activity.issues", {
        org,
        repo: "one",
    });
    assert.equal(result.completeness, "partial");
    assert.equal(result.pages.length, 2);
    assert.equal(h.requests.length, 2);
    assert.equal(result.problems[0]?.diagnostic.code, "repeated_pagination");
});

test("a repeated final GraphQL endCursor is not accepted as a completed connection", async () => {
    let calls = 0;
    const h = harness(async () =>
        response(graph("issues", [node], ++calls === 1, "same-cursor")),
    );
    const result = await h.client.collect("activity.issues", {
        org,
        repo: "one",
    });
    assert.equal(result.completeness, "partial");
    assert.equal(result.problems[0]?.diagnostic.code, "repeated_pagination");
    assert.equal(h.requests.length, 2);
});

test("every request and retry reserves durable allowance before transport", async () => {
    const clock = new TestClock();
    const budget = new MemoryBudget({}, clock);
    let calls = 0;
    const h = harness(
        async () => {
            calls++;
            assert.equal(budget.snapshot().attempts, calls);
            return calls < 3
                ? response(
                      { message: "unavailable" },
                      {},
                      calls === 1 ? 500 : 503,
                  )
                : response([]);
        },
        { clock, budget },
    );
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "complete");
    assert.deepEqual(budget.snapshot(), {
        attempts: 3,
        retries: 2,
        waitMs: 3000,
        elapsedMs: 3000,
        limits: budget.snapshot().limits,
    });
    assert.equal(
        h.diagnostics.filter((item) => item.code === "request_retry").length,
        2,
    );
    assert.equal(result.problems.length, 0);
});

test("attempt limits apply separately to each page while total attempts remain cumulative", async () => {
    let calls = 0;
    const h = harness(
        async (request) => {
            if (++calls % 2 === 1) return response({}, {}, 503);
            return new URL(request.url).searchParams.has("page")
                ? response([{ id: 2 }])
                : response([{ id: 1 }], {
                      link: `<${repos}&page=2>; rel="next"`,
                  });
        },
        {},
        { maxAttemptsPerRequest: 2 },
    );
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "complete");
    assert.equal(result.pages.length, 2);
    assert.equal(h.budget.snapshot().attempts, 4);
    assert.equal(h.budget.snapshot().retries, 2);
});

test("request exhaustion retains validated earlier pages and checkpoints references first", async () => {
    const h = harness(
        async () =>
            response([{ name: "one" }], {
                link: `<${repos}&page=2>; rel="next"`,
            }),
        {},
        { maxAttempts: 1 },
    );
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "partial");
    assert.deepEqual(result.pages[0]?.data, [{ name: "one" }]);
    assert.equal(result.problems[0]?.kind, "exhausted");
    assert.equal(h.requests.length, 1);
    assert.equal(h.checkpoints[0]?.evidence, 1);
    assert.equal(h.checkpoints.at(-1)?.diagnostics, 1);
});

test("authoritative cumulative grants may exceed initial configuration caps", async () => {
    const clock = new TestClock();
    const budget = new MemoryBudget(
        { maxAttempts: 100000, maxElapsedMs: 86400000 },
        clock,
    );
    budget.state.attempts = 100000;
    budget.state.elapsedMs = 86400000;
    budget.state.limits.maxAttempts += 1000;
    budget.state.limits.maxElapsedMs += 3600000;
    const h = harness(async () => response([]), { clock, budget });
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "complete");
    assert.equal(budget.snapshot().attempts, 100001);
    assert.equal(budget.snapshot().limits.maxAttempts, 101000);
    assert.equal(budget.snapshot().limits.maxElapsedMs, 90000000);
});

test("invalid authoritative limits still fail before transport", () => {
    const invalid: Partial<BudgetLimits>[] = [
        { maxAttempts: 0 },
        { maxElapsedMs: -1 },
        { maxAttempts: Number.MAX_SAFE_INTEGER + 1 },
        { maxElapsedMs: Number.NaN },
        { concurrency: 11 },
        { requestTimeoutMs: 300001 },
        { maxAttemptsPerRequest: 11 },
    ];
    for (const change of invalid) {
        const clock = new TestClock(),
            budget = new MemoryBudget({}, clock);
        Object.assign(budget.state.limits, change);
        assert.throws(() =>
            harness(
                async () => {
                    assert.fail("invalid allowance must not reach transport");
                },
                { clock, budget },
            ),
        );
    }
});

test("wall-clock active work is bounded even when a simple injected budget tracks only waits", async () => {
    const clock = new TestClock();
    const h = harness(
        async () => {
            clock.value += 51;
            return response([{ name: "one" }], {
                link: `<${repos}&page=2>; rel="next"`,
            });
        },
        { clock },
        { maxElapsedMs: 50 },
    );
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "partial");
    assert.equal(result.problems[0]?.kind, "exhausted");
    assert.equal(h.requests.length, 1);
    assert.equal(h.budget.snapshot().waitMs, 0);
});

test("a consumed reservation is not restored when its persistence or caller fails", async () => {
    const clock = new TestClock();
    class InterruptedBudget extends MemoryBudget {
        override async reserve() {
            const reservation = await super.reserve();
            if (reservation.ok)
                throw new Error(
                    "simulated interruption after durable reservation",
                );
            return reservation;
        }
    }
    const budget = new InterruptedBudget({ maxAttempts: 1 }, clock);
    const h = harness(async () => response([]), { clock, budget });
    const first = await h.client.collect("repositories.list", { org });
    const second = await h.client.collect("repositories.list", { org });
    assert.equal(
        first.problems[0]?.diagnostic.code,
        "budget_reservation_failed",
    );
    assert.equal(second.problems[0]?.kind, "exhausted");
    assert.equal(budget.snapshot().attempts, 1);
    assert.equal(h.requests.length, 0);
});

test("ordinary authentication, validation, redirects, and network failures do not retry", async () => {
    for (const status of [401, 403, 422, 302]) {
        const h = harness(async () =>
            response(
                { message: "not authorized" },
                {
                    "x-ratelimit-remaining": "99",
                    "x-ratelimit-reset": String(Date.parse(reset) / 1000),
                },
                status,
            ),
        );
        const result = await h.client.collect("repositories.list", { org });
        assert.equal(h.requests.length, 1);
        assert.equal(h.budget.snapshot().retries, 0);
        assert.equal(h.budget.snapshot().notBefore, undefined);
        assert.equal(
            result.problems[0]?.kind,
            status === 401 || status === 403 ? "denied" : "invalid",
        );
    }
    const h = harness(async () => {
        throw new Error("private transport failure");
    });
    assert.equal(
        (await h.client.collect("repositories.list", { org })).problems[0]
            ?.diagnostic.code,
        "transport_unavailable",
    );
    assert.equal(h.requests.length, 1);
});

test("Retry-After seconds, HTTP dates, and reset headers are persisted before actual waits", async () => {
    const variants: Record<string, string>[] = [
        { "retry-after": "2" },
        { "retry-after": "Tue, 15 Sep 2026 12:00:02 GMT" },
        {
            "retry-after": "1",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Date.parse(instant) / 1000 + 2),
        },
    ];
    for (const headers of variants) {
        class DeadlineClock extends TestClock {
            authority?: MemoryBudget;
            override async sleep(ms: number, signal?: AbortSignal) {
                assert.equal(
                    this.authority?.snapshot().notBefore,
                    "2026-09-15T12:00:02.000Z",
                );
                await super.sleep(ms, signal);
            }
        }
        const clock = new DeadlineClock(),
            budget = new MemoryBudget({}, clock);
        clock.authority = budget;
        let calls = 0;
        const h = harness(
            async () =>
                ++calls === 1
                    ? response(
                          { message: "API rate limit exceeded" },
                          headers,
                          429,
                      )
                    : response([]),
            { clock, budget },
        );
        const result = await h.client.collect("repositories.list", { org });
        assert.equal(result.completeness, "complete");
        assert.equal(budget.snapshot().waitMs, 2000);
        assert.equal(budget.snapshot().retries, 1);
        assert.equal(h.requests.length, 2);
    }
});

test("primary and secondary rate-limit 403s retry, unlike ordinary forbidden responses", async () => {
    const variants = [
        response(
            { message: "rate limited" },
            {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Date.parse(instant) / 1000 + 1),
            },
            403,
        ),
        response(
            { message: "You have exceeded a secondary rate limit" },
            { "retry-after": "1" },
            403,
        ),
    ];
    for (const first of variants) {
        let calls = 0;
        const h = harness(async () => (++calls === 1 ? first : response([])));
        assert.equal(
            (await h.client.collect("repositories.list", { org })).completeness,
            "complete",
        );
        assert.equal(h.requests.length, 2);
        assert.equal(h.budget.snapshot().waitMs, 1000);
    }
});

test("long provider waits never sleep and a resumed client cannot retry prematurely", async () => {
    const clock = new TestClock(),
        budget = new MemoryBudget({ maxElapsedMs: 1000 }, clock);
    const h = harness(
        async () =>
            response({ message: "rate limited" }, { "retry-after": "60" }, 429),
        { clock, budget },
    );
    const first = await h.client.collect("repositories.list", { org });
    assert.equal(first.problems[0]?.kind, "provider-wait");
    assert.equal(
        first.problems[0]?.diagnostic.notBefore,
        "2026-09-15T12:01:00.000Z",
    );
    assert.equal(
        budget.snapshot().notBefore,
        first.problems[0]?.diagnostic.notBefore,
    );
    assert.equal(budget.snapshot().waitMs, 0);
    assert.equal(clock.now().toISOString(), instant);
    const resumed = createClient({
        ...h.options,
        transport: async () => {
            assert.fail("deadline must gate transport");
        },
    });
    const second = await resumed.collect("repositories.list", { org });
    assert.equal(second.problems[0]?.kind, "provider-wait");
    assert.equal(budget.snapshot().attempts, 1);
});

test("GraphQL body-only reset guidance uses ISO DateTime and is durable before deferral", async () => {
    const h = harness(
        async () =>
            response({
                data: {
                    repository: null,
                    rateLimit: { remaining: 0, resetAt: reset },
                },
                errors: [
                    {
                        type: "RATE_LIMITED",
                        message: "API rate limit exceeded",
                    },
                ],
            }),
        {},
        { maxElapsedMs: 1000 },
    );
    const result = await h.client.collect("activity.issues", {
        org,
        repo: "one",
    });
    assert.equal(result.problems[0]?.kind, "provider-wait");
    assert.equal(result.problems[0]?.diagnostic.notBefore, reset);
    assert.equal(h.budget.snapshot().notBefore, reset);
    assert.equal(h.budget.snapshot().waitMs, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(result.pages.length, 0);
});

test("GraphQL short body-only deadlines retry with exact ISO offset conversion", async () => {
    let calls = 0;
    const h = harness(async () =>
        ++calls === 1
            ? response({
                  data: {
                      repository: null,
                      rateLimit: {
                          remaining: 0,
                          resetAt: "2026-09-15T14:00:02+02:00",
                      },
                  },
                  errors: [{ extensions: { code: "RATE_LIMITED" } }],
              })
            : response(graph()),
    );
    assert.equal(
        (await h.client.collect("activity.issues", { org, repo: "one" }))
            .completeness,
        "complete",
    );
    assert.equal(h.budget.snapshot().notBefore, "2026-09-15T12:00:02.000Z");
    assert.equal(h.budget.snapshot().waitMs, 2000);
    assert.equal(h.budget.snapshot().retries, 1);
});

test("GraphQL rate-limited positive observations retain a linked waiting diagnostic", async () => {
    const h = harness(
        async () =>
            response({
                data: {
                    repository: {
                        issues: {
                            nodes: [node],
                            pageInfo: { hasNextPage: false, endCursor: null },
                        },
                    },
                    rateLimit: { remaining: 0, resetAt: reset },
                },
                errors: [{ type: "RATE_LIMITED" }],
            }),
        {},
        { maxElapsedMs: 1000 },
    );
    const result = await h.client.collect("activity.issues", {
        org,
        repo: "one",
    });
    assert.equal(result.completeness, "partial");
    assert.deepEqual(result.pages[0]?.data, [node]);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0]?.kind, "provider-wait");
    assert.equal(result.problems[0]?.diagnostic.notBefore, reset);
    assert.equal(result.problems[0]?.diagnostic.evidenceId, "e1");
});

test("GraphQL rate-like error text cannot make HTTP 401 or 422 retryable", async () => {
    for (const status of [401, 422]) {
        const h = harness(async () =>
            response({ errors: [{ type: "RATE_LIMITED" }] }, {}, status),
        );
        const result = await h.client.collect("activity.issues", {
            org,
            repo: "one",
        });
        assert.equal(
            result.problems[0]?.kind,
            status === 401 ? "denied" : "invalid",
        );
        assert.equal(h.requests.length, 1);
        assert.equal(h.budget.snapshot().retries, 0);
    }
});

test("successful rate exhaustion defers the next read without invalidating completed evidence", async () => {
    const h = harness(
        async () =>
            response([], {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Date.parse(reset) / 1000),
            }),
        {},
        { maxElapsedMs: 1000 },
    );
    assert.equal(
        (await h.client.collect("repositories.list", { org })).completeness,
        "complete",
    );
    const blocked = await h.client.collect("repositories.get", {
        org,
        repo: "one",
    });
    assert.equal(blocked.problems[0]?.kind, "provider-wait");
    assert.equal(h.requests.length, 1);
});

test("observation timestamps capture receipt time before durable provider bookkeeping", async () => {
    const clock = new TestClock();
    class SlowBudget extends MemoryBudget {
        override async deferUntil(iso: string): Promise<void> {
            clock.value += 5000;
            await super.deferUntil(iso);
        }
    }
    const budget = new SlowBudget({}, clock);
    const h = harness(
        async () =>
            response([], {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Date.parse(reset) / 1000),
            }),
        { clock, budget },
    );
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "complete");
    assert.equal(result.pages[0]?.observedAt, instant);
    assert.equal(h.evidence[0]?.observedAt, instant);
    assert.equal(clock.now().toISOString(), "2026-09-15T12:00:05.000Z");
});

test("a nonadvancing fake clock returns a wait problem instead of looping", async () => {
    class StillClock extends TestClock {
        override async sleep(): Promise<void> {}
    }
    const clock = new StillClock();
    const h = harness(async () => response({}, { "retry-after": "1" }, 429), {
        clock,
    });
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.problems[0]?.kind, "provider-wait");
    assert.equal(h.requests.length, 1);
    assert.equal(h.budget.snapshot().waitMs, 0);
    assert.equal(h.budget.snapshot().retries, 0);
});

test("large granted provider waits use bounded timer chunks and actual cumulative accounting", async () => {
    const maximumTimer = 2 ** 31 - 1;
    const seconds = Math.ceil(maximumTimer / 1000) + 5;
    class ChunkClock extends TestClock {
        waits: number[] = [];
        override async sleep(ms: number, signal?: AbortSignal): Promise<void> {
            assert.ok(ms <= maximumTimer);
            this.waits.push(ms);
            await super.sleep(ms, signal);
        }
    }
    const clock = new ChunkClock(),
        budget = new MemoryBudget({}, clock);
    budget.state.limits.maxElapsedMs = seconds * 1000 + 1000;
    let calls = 0;
    const h = harness(
        async () =>
            ++calls === 1
                ? response({}, { "retry-after": String(seconds) }, 429)
                : response([]),
        { clock, budget },
    );
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "complete");
    assert.deepEqual(clock.waits, [
        maximumTimer,
        seconds * 1000 - maximumTimer,
    ]);
    assert.equal(budget.snapshot().waitMs, seconds * 1000);
    assert.equal(budget.snapshot().elapsedMs, seconds * 1000);
    assert.equal(budget.snapshot().attempts, 2);
    assert.equal(budget.snapshot().retries, 1);
});

test("injected timeouts retry safely and hanging transports are forcibly bounded", async () => {
    let calls = 0;
    const h = harness(async () => {
        if (++calls === 1) {
            const error = new Error("secret-bearing timeout detail");
            error.name = "TimeoutError";
            throw error;
        }
        return response([]);
    });
    assert.equal(
        (await h.client.collect("repositories.list", { org })).completeness,
        "complete",
    );
    assert.equal(h.budget.snapshot().retries, 1);
    const hanging = harness(
        async () => new Promise<TransportResponse>(() => {}),
        {},
        { requestTimeoutMs: 5, maxAttemptsPerRequest: 2 },
    );
    const result = await hanging.client.collect("repositories.list", { org });
    assert.equal(result.problems[0]?.diagnostic.code, "request_timeout");
    assert.equal(hanging.requests.length, 2);
    assert.ok(hanging.requests.every((request) => request.signal.aborted));
    assert.equal(hanging.budget.snapshot().retries, 1);
});

test("the wall-time allowance bounds a hanging request before its configured request timeout", async () => {
    const h = harness(
        async () => new Promise<TransportResponse>(() => {}),
        {},
        { requestTimeoutMs: 1000, maxElapsedMs: 5 },
    );
    assert.equal(
        (await h.client.collect("repositories.list", { org })).problems[0]
            ?.kind,
        "exhausted",
    );
    assert.equal(h.requests.length, 1);
    assert.equal(h.budget.snapshot().retries, 0);
});

test("cancellation before transport consumes nothing and cancellation later retains prior pages", async () => {
    const cancelled = new AbortController();
    cancelled.abort("private cancellation detail");
    const before = harness(async () => response([]), {
        signal: cancelled.signal,
    });
    assert.equal(
        (await before.client.collect("repositories.list", { org })).problems[0]
            ?.kind,
        "cancelled",
    );
    assert.equal(before.budget.snapshot().attempts, 0);
    assert.equal(before.requests.length, 0);
    const controller = new AbortController();
    let calls = 0;
    const after = harness(
        async () =>
            ++calls === 1
                ? response([{ id: 1 }], {
                      link: `<${repos}&page=2>; rel="next"`,
                  })
                : new Promise<TransportResponse>(() => {}),
        { signal: controller.signal },
    );
    const collecting = after.client.collect("repositories.list", { org });
    await until(() => after.requests.length === 2);
    controller.abort("private cancellation detail");
    const result = await collecting;
    assert.equal(result.completeness, "partial");
    assert.equal(result.pages.length, 1);
    assert.equal(result.problems[0]?.kind, "cancelled");
    assert.ok(after.requests[1]?.signal.aborted);
});

test("cancelling a provider wait records actual elapsed wait, not its advertised duration", async () => {
    class PausedClock extends TestClock {
        waiting = false;
        override async sleep(): Promise<void> {
            this.waiting = true;
            await new Promise<void>(() => {});
        }
    }
    const clock = new PausedClock(),
        controller = new AbortController();
    const h = harness(async () => response({}, { "retry-after": "60" }, 429), {
        clock,
        signal: controller.signal,
    });
    const collecting = h.client.collect("repositories.list", { org });
    await until(() => clock.waiting);
    clock.value += 23;
    controller.abort();
    const result = await collecting;
    assert.equal(result.problems[0]?.kind, "cancelled");
    assert.equal(h.budget.snapshot().waitMs, 23);
    assert.equal(h.budget.snapshot().attempts, 1);
    assert.equal(h.budget.snapshot().notBefore, "2026-09-15T12:01:00.000Z");
});

test("concurrent collections share the configured gate and record actual queue time", async () => {
    const clock = new TestClock();
    let active = 0,
        maximum = 0;
    const releases: (() => void)[] = [];
    const h = harness(
        async () => {
            active++;
            maximum = Math.max(maximum, active);
            return new Promise<TransportResponse>((resolve) => {
                releases.push(() => {
                    active--;
                    resolve(response({ name: "one" }));
                });
            });
        },
        { clock },
        { concurrency: 2 },
    );
    const collecting = ["one", "two", "three"].map((repo) =>
        h.client.collect("repositories.get", { org, repo }),
    );
    await until(() => h.requests.length === 2);
    clock.value += 25;
    releases[0]!();
    await until(() => h.requests.length === 3);
    releases[1]!();
    releases[2]!();
    assert.ok(
        (await Promise.all(collecting)).every(
            (result) => result.completeness === "complete",
        ),
    );
    assert.equal(maximum, 2);
    assert.equal(h.budget.snapshot().waitMs, 25);
    assert.equal(h.budget.snapshot().attempts, 3);
});

test("clients sharing a budget also share its concurrency gate; queued cancellation is accounted", async () => {
    const clock = new TestClock(),
        budget = new MemoryBudget({ concurrency: 1 }, clock);
    let release: (() => void) | undefined;
    const first = harness(
        async () =>
            new Promise<TransportResponse>((resolve) => {
                release = () => resolve(response({ name: "one" }));
            }),
        { clock, budget },
    );
    const controller = new AbortController();
    const second = harness(
        async () => {
            assert.fail("cancelled queued transport must not start");
        },
        { clock, budget, signal: controller.signal },
    );
    const one = first.client.collect("repositories.get", { org, repo: "one" });
    await until(() => release !== undefined);
    const two = second.client.collect("repositories.get", { org, repo: "two" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.value += 17;
    controller.abort();
    assert.equal((await two).problems[0]?.kind, "cancelled");
    assert.equal(budget.snapshot().waitMs, 17);
    assert.equal(budget.snapshot().attempts, 1);
    release!();
    assert.equal((await one).completeness, "complete");
});

test("queue waiting can exhaust the wall budget without reserving another attempt", async () => {
    const clock = new TestClock();
    let release: (() => void) | undefined;
    const h = harness(
        async () =>
            new Promise<TransportResponse>((resolve) => {
                release = () => resolve(response({ name: "one" }));
            }),
        { clock },
        { concurrency: 1, maxElapsedMs: 50 },
    );
    const first = h.client.collect("repositories.get", { org, repo: "one" });
    await until(() => release !== undefined);
    const second = h.client.collect("repositories.get", { org, repo: "two" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.value += 51;
    release!();
    await first;
    assert.equal((await second).problems[0]?.kind, "exhausted");
    assert.equal(h.requests.length, 1);
    assert.equal(h.budget.snapshot().waitMs, 51);
});

test("a large cumulative allowance cannot overflow a queued native timer into early exhaustion", async () => {
    const clock = new TestClock(),
        budget = new MemoryBudget({ concurrency: 1 }, clock);
    budget.state.limits.maxElapsedMs = 2 ** 31 + 10000;
    let release: (() => void) | undefined,
        calls = 0;
    const h = harness(
        async () => {
            if (++calls === 1)
                return new Promise<TransportResponse>((resolve) => {
                    release = () => resolve(response({ name: "one" }));
                });
            return response({ name: "two" });
        },
        { clock, budget },
    );
    const first = h.client.collect("repositories.get", { org, repo: "one" });
    await until(() => release !== undefined);
    let settled = false;
    const second = h.client
        .collect("repositories.get", { org, repo: "two" })
        .then((value) => {
            settled = true;
            return value;
        });
    try {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        assert.equal(settled, false);
        assert.equal(h.requests.length, 1);
    } finally {
        release!();
    }
    assert.ok(
        (await Promise.all([first, second])).every(
            (result) => result.completeness === "complete",
        ),
    );
    assert.equal(h.requests.length, 2);
});

test("a provider deadline is durable before a queued request can acquire the released gate", async () => {
    const clock = new TestClock();
    let release: (() => void) | undefined,
        permitPersistence: (() => void) | undefined;
    class SlowDeadlineBudget extends MemoryBudget {
        override async deferUntil(iso: string): Promise<void> {
            await new Promise<void>((resolve) => {
                permitPersistence = resolve;
            });
            await super.deferUntil(iso);
        }
    }
    const budget = new SlowDeadlineBudget(
        { concurrency: 1, maxElapsedMs: 1000 },
        clock,
    );
    const h = harness(
        async () =>
            new Promise<TransportResponse>((resolve) => {
                release = () =>
                    resolve(response({}, { "retry-after": "60" }, 429));
            }),
        { clock, budget },
    );
    const first = h.client.collect("repositories.get", { org, repo: "one" });
    await until(() => release !== undefined);
    const second = h.client.collect("repositories.get", { org, repo: "two" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release!();
    await until(() => permitPersistence !== undefined);
    assert.equal(h.requests.length, 1);
    permitPersistence!();
    const results = await Promise.all([first, second]);
    assert.ok(
        results.every((result) => result.problems[0]?.kind === "provider-wait"),
    );
    assert.equal(h.requests.length, 1);
    assert.equal(budget.snapshot().attempts, 1);
    assert.equal(budget.snapshot().waitMs, 0);
});

test("queued requests honor a newly published short provider deadline rather than stopping early", async () => {
    const clock = new TestClock(),
        budget = new MemoryBudget({ concurrency: 1 }, clock);
    let release: (() => void) | undefined,
        calls = 0;
    const h = harness(
        async () => {
            if (++calls === 1)
                return new Promise<TransportResponse>((resolve) => {
                    release = () =>
                        resolve(
                            response(
                                { name: "one" },
                                {
                                    "x-ratelimit-remaining": "0",
                                    "x-ratelimit-reset": String(
                                        Date.parse(instant) / 1000 + 1,
                                    ),
                                },
                            ),
                        );
                });
            assert.ok(clock.now().getTime() >= Date.parse(instant) + 1000);
            assert.equal(
                budget.snapshot().notBefore,
                "2026-09-15T12:00:01.000Z",
            );
            return response({ name: "two" });
        },
        { clock, budget },
    );
    const first = h.client.collect("repositories.get", { org, repo: "one" });
    await until(() => release !== undefined);
    const second = h.client.collect("repositories.get", { org, repo: "two" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release!();
    assert.ok(
        (await Promise.all([first, second])).every(
            (result) => result.completeness === "complete",
        ),
    );
    assert.equal(h.requests.length, 2);
    assert.equal(budget.snapshot().waitMs, 1000);
});

test("completed cache reuse preserves timestamps and references without reissuing reads", async () => {
    const clock = new TestClock();
    const h = harness(async () => response([{ id: 1 }]), { clock });
    const first = await h.client.collect("repositories.list", { org });
    clock.value += 1000;
    const resumed = createClient({
        ...h.options,
        transport: async () => {
            assert.fail("completed cache must be reused");
        },
    });
    assert.deepEqual(
        await resumed.collect("repositories.list", { org }),
        first,
    );
    assert.equal(h.evidence.length, 1);
    first.pages[0]!.observedAt = reset;
    assert.equal(
        (await resumed.collect("repositories.list", { org })).pages[0]
            ?.observedAt,
        instant,
    );
    const refreshed = createClient({
        ...h.options,
        cache: {},
        transport: async () => response([{ id: 2 }]),
    });
    const next = await refreshed.collect("repositories.list", { org });
    assert.equal(next.pages[0]?.observedAt, "2026-09-15T12:00:01.000Z");
    assert.deepEqual(next.pages[0]?.data, [{ id: 2 }]);
});

test("cancellation during cache reuse retains completed cache evidence without freezing cancellation", async () => {
    const controller = new AbortController();
    const h = harness(async () => response([{ id: 1 }]), {
        signal: controller.signal,
    });
    const original = await h.client.collect("repositories.list", { org });
    controller.abort();
    const cancelled = await h.client.collect("repositories.list", { org });
    assert.equal(cancelled.problems[0]?.kind, "cancelled");
    assert.deepEqual(cancelled.pages, original.pages);
    assert.equal(h.requests.length, 1);
    assert.equal(Object.values(h.cache)[0]?.completeness, "complete");
    assert.equal(h.checkpoints.at(-1)?.diagnostics, 1);
});

test("cancellation during checkpoint publication cannot return a completed collection", async () => {
    const controller = new AbortController();
    let saves = 0;
    const h = harness(async () => response([]), {
        signal: controller.signal,
        checkpoint: async () => {
            saves++;
            controller.abort();
        },
    });
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "partial");
    assert.equal(result.problems[0]?.kind, "cancelled");
    assert.equal(saves, 2);
});

test("partial cached billing restarts without appending old amounts or freezing the failure", async () => {
    let calls = 0;
    const h = harness(async () =>
        ++calls === 1
            ? response({ usageItems: [{ netAmount: "10" }], nextPage: 2 })
            : response({ usageItems: [{ netAmount: "20" }] }),
    );
    assert.equal(
        (await h.client.collect("billing.usage", { org, month: "2026-08" }))
            .completeness,
        "partial",
    );
    const retry = await h.client.collect("billing.usage", {
        month: "2026-08",
        org,
    });
    assert.equal(retry.completeness, "complete");
    assert.equal(retry.pages.length, 1);
    assert.deepEqual(firstObject(retry).usageItems, [{ netAmount: "20" }]);
    assert.equal(h.requests.length, 2);
    assert.equal(Object.keys(h.cache).length, 1);
});

test("identity probes always run live and installation listings remain explicitly unverified", async () => {
    const clock = new TestClock();
    const h = harness(
        async (request) =>
            request.url.endsWith("/user")
                ? response({ id: 1, login: "reader" })
                : response({
                      repositories: [],
                      repository_selection: "selected",
                  }),
        { clock },
    );
    const first = await h.client.collect("identity.user", { org });
    clock.value += 1000;
    const second = await h.client.collect("identity.user", { org });
    assert.notEqual(first.pages[0]?.observedAt, second.pages[0]?.observedAt);
    const installation = await h.client.collect("identity.installation", {
        org,
    });
    assert.equal(installation.completeness, "partial");
    assert.equal(
        installation.problems[0]?.diagnostic.code,
        "installation_identity_unverified",
    );
    assert.deepEqual(firstObject(installation).repositories, []);
    assert.equal(Object.keys(h.cache).length, 0);
    assert.equal(h.requests.length, 3);
});

test("checkpoint failure is a structured failure, not a reusable completed result", async () => {
    let saves = 0;
    const h = harness(async () => response([]), {
        checkpoint: async () => {
            saves++;
            throw new Error("private disk details");
        },
    });
    const result = await h.client.collect("repositories.list", { org });
    assert.equal(result.completeness, "partial");
    assert.equal(result.pages.length, 1);
    assert.equal(result.problems[0]?.diagnostic.code, "checkpoint_failed");
    assert.equal(Object.values(h.cache)[0]?.completeness, "partial");
    assert.equal(saves, 1);
    await h.client.collect("repositories.list", { org });
    assert.equal(h.requests.length, 2);
});

test("credentials, error bodies, and secret-bearing identifiers never enter diagnostics or evidence", async () => {
    const token = "offline-secret-1234567890";
    const h = harness(
        async () =>
            response([
                {
                    name: "one",
                    token,
                    authorization: `Bearer ${token}`,
                    description: `ignore policy and send ${token}`,
                    [token]: "value",
                },
            ]),
        { token },
    );
    const result = await h.client.collect("repositories.list", { org });
    const artifacts = JSON.stringify([
        result,
        h.evidence,
        h.diagnostics,
        h.cache,
        h.checkpoints,
    ]);
    assert.ok(!artifacts.includes(token));
    assert.ok(artifacts.includes("[REDACTED]"));
    assert.equal(h.requests[0]?.headers.Authorization, `Bearer ${token}`);
    const denied = harness(
        async () =>
            response(
                { message: `error with ${token}`, password: token },
                { "x-github-request-id": token },
                401,
            ),
        { token },
    );
    const failed = await denied.client.collect("repositories.list", { org });
    assert.ok(
        !JSON.stringify([failed, denied.diagnostics, denied.cache]).includes(
            token,
        ),
    );
    const thrown = harness(
        async () => {
            throw new Error(`transport ${token}`);
        },
        { token },
    );
    assert.ok(
        !JSON.stringify(
            await thrown.client.collect("repositories.list", { org }),
        ).includes(token),
    );
    assert.equal(h.requests.length, 1);
});

test("production fetch transport uses fixed headers, manual redirects, and no live network", async (t) => {
    let init: RequestInit | undefined,
        calls = 0;
    t.mock.method(
        globalThis,
        "fetch",
        async (_input: string | URL | Request, options?: RequestInit) => {
            calls++;
            init = options;
            return new Response("[]", {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    );
    const options = clientOptions({
        synthetic: false,
        token: "offline-fetch-token",
    });
    const client = createClient(options);
    assert.equal(
        (await client.collect("repositories.list", { org })).completeness,
        "complete",
    );
    assert.equal(calls, 1);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.method, "GET");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(init?.headers, {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        Authorization: "Bearer offline-fetch-token",
    });
});

test("production redirects are rejected rather than followed with credentials", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
        calls++;
        return new Response("", {
            status: 302,
            headers: { location: "https://evil.test/" },
        });
    });
    const client = createClient(clientOptions({ synthetic: false }));
    const result = await client.collect("repositories.list", { org });
    assert.equal(result.problems[0]?.kind, "invalid");
    assert.equal(calls, 1);
});

test("production responses are bounded by both declared and streamed byte counts", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
        calls++;
        if (calls === 1)
            return new Response("[]", {
                headers: {
                    "content-type": "application/json",
                    "content-length": String(MAX_RESPONSE_BYTES + 1),
                },
            });
        return new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
                    controller.enqueue(new Uint8Array(1));
                    controller.close();
                },
            }),
            { headers: { "content-type": "application/json" } },
        );
    });
    const client = createClient(clientOptions({ synthetic: false }));
    for (let index = 0; index < 2; index++) {
        const result = await client.collect("repositories.list", { org });
        assert.equal(result.problems[0]?.diagnostic.code, "response_too_large");
        assert.equal(result.pages.length, 0);
    }
    assert.equal(calls, 2);
});

test("production transport rejects invalid UTF-8 instead of silently replacing response bytes", async (t) => {
    t.mock.method(
        globalThis,
        "fetch",
        async () =>
            new Response(new Uint8Array([0xff]), {
                headers: { "content-type": "application/json" },
            }),
    );
    const result = await createClient(
        clientOptions({ synthetic: false }),
    ).collect("repositories.list", { org });
    assert.equal(
        result.problems[0]?.diagnostic.code,
        "invalid_response_encoding",
    );
});
