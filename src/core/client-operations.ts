import { isSafeNumber, parse } from "lossless-json";
import {
    monthSchema,
    operationIds,
    type JsonObject,
    type JsonValue,
    type OperationArgs,
    type OperationId,
    type ProblemKind,
} from "./contracts.ts";
import { validTimestamp } from "./time.ts";

export const reviewedOperations: readonly OperationId[] = Object.freeze([
    ...operationIds,
]);
const origin = "https://api.github.com";
type AdapterKind =
    | "object"
    | "array"
    | "actions"
    | "runners"
    | "installation"
    | "billing"
    | "graphql";
const operations: Record<
    OperationId,
    { kind: AdapterKind; fields: readonly (keyof OperationArgs)[] }
> = {
    "identity.user": { kind: "object", fields: ["org"] },
    "identity.installation": { kind: "installation", fields: ["org"] },
    "repositories.list": { kind: "array", fields: ["org"] },
    "repositories.get": { kind: "object", fields: ["org", "repo"] },
    "repositories.properties": { kind: "array", fields: ["org", "repo"] },
    "activity.commits": {
        kind: "array",
        fields: ["org", "repo", "branch", "since"],
    },
    "activity.issues": { kind: "graphql", fields: ["org", "repo"] },
    "activity.pull-requests": { kind: "graphql", fields: ["org", "repo"] },
    "activity.discussions": { kind: "graphql", fields: ["org", "repo"] },
    "activity.actions": { kind: "actions", fields: ["org", "repo"] },
    "billing.usage": { kind: "billing", fields: ["org", "month"] },
    "conformance.runners": { kind: "runners", fields: ["org"] },
};
const graphFields: Partial<Record<OperationId, string>> = {
    "activity.issues": "issues",
    "activity.pull-requests": "pullRequests",
    "activity.discussions": "discussions",
};
const graphQueries = {
    issues: "query AdminActivityIssues($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { issues(first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { id updatedAt } pageInfo { hasNextPage endCursor } } } rateLimit { remaining resetAt } }",
    pullRequests:
        "query AdminActivityPullRequests($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { pullRequests(first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { id updatedAt } pageInfo { hasNextPage endCursor } } } rateLimit { remaining resetAt } }",
    discussions:
        "query AdminActivityDiscussions($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { discussions(first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { id updatedAt } pageInfo { hasNextPage endCursor } } } rateLimit { remaining resetAt } }",
} as const;

export interface ApprovedRead {
    operation: OperationId;
    args: OperationArgs;
    target: string;
    url: string;
    kind: AdapterKind;
    cacheable: boolean;
    graphField?: keyof typeof graphQueries;
}
export interface PageIssue {
    kind: ProblemKind;
    code: string;
    message: string;
    retryable: boolean;
    remediation: string;
    notBefore?: string;
}
export interface DecodedPage {
    data?: JsonValue;
    next?: string;
    cursor?: string;
    totalCount?: number;
    issues: PageIssue[];
}
export function invalidPage(code: string, message: string): PageIssue {
    return {
        kind: "invalid",
        code,
        message,
        retryable: false,
        remediation:
            "Review the documented endpoint contract and source permissions before retrying this read.",
    };
}
function continuationIssue(code: string, message: string): PageIssue {
    return {
        kind: "unsupported-continuation",
        code,
        message,
        retryable: false,
        remediation:
            "Review the continuation contract; retained evidence is not a completed collection.",
    };
}
export function object(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isoTime(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const match =
        /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-](\d\d):(\d\d))$/.exec(
            value,
        );
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const year = Number(match[1]),
        month = Number(match[2]),
        day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= days[month - 1]! &&
        Number(match[4]) < 24 &&
        Number(match[5]) < 60 &&
        Number(match[6]) < 60 &&
        (match[7] === undefined ||
            (Number(match[7]) < 24 && Number(match[8]) < 60))
    );
}
export function nonnegativeInteger(value: unknown): number | undefined {
    if (
        typeof value !== "number" &&
        (typeof value !== "string" || !/^\d+$/.test(value))
    )
        return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
export function approveRead(
    org: string,
    capabilities: ReadonlySet<OperationId>,
    operation: OperationId,
    args: OperationArgs,
): ApprovedRead {
    if (!Object.hasOwn(operations, operation) || !capabilities.has(operation))
        throw new Error(
            "unsupported_capability: This read is not in the scenario capability set",
        );
    const definition = operations[operation];
    if (
        !object(args) ||
        Object.keys(args).some(
            (key) => !definition.fields.includes(key as keyof OperationArgs),
        )
    )
        throw new Error(
            "invalid_operation_args: Only reviewed operation arguments are accepted",
        );
    if (
        typeof args.org !== "string" ||
        args.org.toLowerCase() !== org.toLowerCase()
    )
        throw new Error(
            "scope_mismatch: The read is outside the configured organization",
        );
    if (
        definition.fields.includes("repo") &&
        (typeof args.repo !== "string" ||
            !/^[A-Za-z0-9._-]{1,100}$/.test(args.repo) ||
            args.repo === "." ||
            args.repo === "..")
    )
        throw new Error(
            "invalid_repository: Expected one repository name in the configured organization",
        );
    if (
        definition.fields.includes("branch") &&
        (typeof args.branch !== "string" ||
            args.branch.length < 1 ||
            args.branch.length > 1024 ||
            /[\u0000-\u001f\u007f]/.test(args.branch))
    )
        throw new Error("invalid_branch: Expected a bounded branch name");
    if (
        definition.fields.includes("since") &&
        (!validTimestamp(args.since) || !isoTime(args.since))
    )
        throw new Error("invalid_since: Expected a UTC timestamp");
    if (
        definition.fields.includes("month") &&
        !monthSchema.safeParse(args.month).success
    )
        throw new Error("invalid_month: Expected YYYY-MM");
    const canonical: OperationArgs = { org };
    for (const field of definition.fields) {
        if (field !== "org" && args[field] !== undefined)
            canonical[field] = args[field];
    }
    const owner = encodeURIComponent(org);
    const repo = encodeURIComponent(canonical.repo ?? "");
    const repository = `/repos/${owner}/${repo}`;
    let path: string;
    const query = new URLSearchParams();
    switch (operation) {
        case "identity.user":
            path = "/user";
            break;
        case "identity.installation":
            path = "/installation/repositories";
            break;
        case "repositories.list":
            path = `/orgs/${owner}/repos`;
            query.set("type", "all");
            query.set("per_page", "100");
            query.set("sort", "full_name");
            break;
        case "repositories.get":
            path = repository;
            break;
        case "repositories.properties":
            path = `${repository}/properties/values`;
            break;
        case "activity.commits":
            path = `${repository}/commits`;
            query.set("sha", canonical.branch!);
            query.set("since", canonical.since!);
            query.set("per_page", "100");
            break;
        case "activity.actions":
            path = `${repository}/actions/runs`;
            query.set("per_page", "100");
            break;
        case "activity.issues":
        case "activity.pull-requests":
        case "activity.discussions":
            path = "/graphql";
            break;
        case "billing.usage":
            path = `/organizations/${owner}/settings/billing/usage`;
            query.set("year", canonical.month!.slice(0, 4));
            query.set("month", String(Number(canonical.month!.slice(5))));
            break;
        case "conformance.runners":
            path = `/orgs/${owner}/actions/runners`;
            query.set("per_page", "100");
            break;
    }
    const field = graphFields[operation];
    return {
        operation,
        args: canonical,
        target: canonical.repo ? `${org}/${canonical.repo}` : org,
        url: `${origin}${path}${query.size ? `?${query}` : ""}`,
        kind: definition.kind,
        cacheable: !operation.startsWith("identity."),
        ...(field === "issues" ||
        field === "pullRequests" ||
        field === "discussions"
            ? { graphField: field }
            : {}),
    };
}
export function approvedRequest(
    read: ApprovedRead,
    continuation?: string,
): { url: string; method: "GET" | "POST"; body?: string } {
    if (!read.graphField)
        return { url: continuation ?? read.url, method: "GET" };
    return {
        url: read.url,
        method: "POST",
        body: JSON.stringify({
            query: graphQueries[read.graphField],
            variables: {
                owner: read.args.org,
                name: read.args.repo,
                after: continuation ?? null,
            },
        }),
    };
}
function jsonValue(value: unknown, depth = 0): value is JsonValue {
    if (depth > 64) return false;
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    )
        return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every((item) => jsonValue(item, depth + 1));
    return (
        object(value) &&
        Object.getPrototypeOf(value) === Object.prototype &&
        Object.values(value).every((item) => jsonValue(item, depth + 1))
    );
}
export function parseBody(
    body: string,
    billing: boolean,
): JsonValue | undefined {
    try {
        const parsed: unknown = parse(body, null, {
            parseNumber: (value) =>
                billing || !isSafeNumber(value) ? value : Number(value),
            onDuplicateKey: () => {
                throw new SyntaxError("Conflicting JSON keys are not accepted");
            },
        });
        return jsonValue(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}
export function jsonContentType(headers: Record<string, string>): boolean {
    const type = headers["content-type"]?.split(";", 1)[0]?.trim();
    return (
        type !== undefined &&
        /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i.test(type)
    );
}
export function rateError(value: unknown): boolean {
    if (!object(value)) return false;
    const extension = object(value.extensions) ? value.extensions : {};
    const type = value.type ?? extension.type ?? extension.code;
    if (
        typeof type === "string" &&
        /^(?:RATE_LIMITED|RATE_LIMIT|RATE_LIMIT_EXCEEDED)$/i.test(type)
    )
        return true;
    return (
        typeof value.message === "string" &&
        /^(?:API )?rate limit exceeded\b|you have exceeded (?:a )?(?:secondary )?rate limit\b|abuse detection mechanism/i.test(
            value.message.slice(0, 1024),
        )
    );
}
export function graphRateErrors(body: JsonValue | undefined): boolean {
    return (
        object(body) &&
        Array.isArray(body.errors) &&
        body.errors.length > 0 &&
        body.errors.every(rateError)
    );
}
export function graphHasNodes(
    read: ApprovedRead,
    body: JsonValue | undefined,
): boolean {
    const data = object(body) && object(body.data) ? body.data : undefined;
    const repository =
        data && object(data.repository) ? data.repository : undefined;
    const connection =
        repository && read.graphField ? repository[read.graphField] : undefined;
    return (
        object(connection) &&
        Array.isArray(connection.nodes) &&
        connection.nodes.some(validNode)
    );
}
function validNode(node: JsonValue): boolean {
    return (
        object(node) &&
        ((typeof node.id === "string" && node.id.length > 0) ||
            (typeof node.id === "number" && Number.isSafeInteger(node.id))) &&
        validTimestamp(node.updatedAt) &&
        isoTime(node.updatedAt)
    );
}
function graphPage(read: ApprovedRead, body: JsonValue): DecodedPage {
    const issues: PageIssue[] = [];
    if (!object(body))
        return {
            issues: [
                invalidPage(
                    "graphql_invalid_response",
                    "The GraphQL response must be an object.",
                ),
            ],
        };
    const errors = body.errors;
    if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) {
        issues.push(
            graphRateErrors(body)
                ? {
                      kind: "provider-wait",
                      code: "graphql_rate_limited",
                      message:
                          "GraphQL rate limiting left some requested activity fields unresolved.",
                      retryable: true,
                      remediation:
                          "Retain the positive observations and retry unfinished work after the provider deadline.",
                  }
                : invalidPage(
                      "graphql_errors",
                      "GraphQL reported field errors; missing activity is not negative evidence.",
                  ),
        );
    }
    const data = object(body.data) ? body.data : undefined;
    const repository =
        data && object(data.repository) ? data.repository : undefined;
    const connection =
        repository && read.graphField ? repository[read.graphField] : undefined;
    if (!object(connection) || !Array.isArray(connection.nodes)) {
        issues.push(
            invalidPage(
                "graphql_missing_connection",
                "The required repository connection or its nodes are missing.",
            ),
        );
        return { issues };
    }
    const nodes = connection.nodes.filter(validNode);
    if (nodes.length !== connection.nodes.length)
        issues.push(
            invalidPage(
                "graphql_invalid_nodes",
                "Some GraphQL activity nodes lack valid identifiers or timestamps.",
            ),
        );
    const rate = data && object(data.rateLimit) ? data.rateLimit : undefined;
    if (
        !rate ||
        nonnegativeInteger(rate.remaining) === undefined ||
        !isoTime(rate.resetAt)
    ) {
        issues.push(
            invalidPage(
                "graphql_missing_rate_limit",
                "The requested GraphQL rate-limit fields are incomplete.",
            ),
        );
    }
    const info = connection.pageInfo;
    let next: string | undefined;
    let cursor: string | undefined;
    if (
        !object(info) ||
        typeof info.hasNextPage !== "boolean" ||
        !Object.hasOwn(info, "endCursor") ||
        !(
            info.endCursor === null ||
            (typeof info.endCursor === "string" &&
                info.endCursor.length > 0 &&
                info.endCursor.length <= 4096 &&
                !/[\u0000-\u001f\u007f]/.test(info.endCursor))
        ) ||
        (info.hasNextPage && typeof info.endCursor !== "string")
    ) {
        issues.push(
            invalidPage(
                "graphql_invalid_page_info",
                "GraphQL pageInfo is incomplete; the connection cannot be considered fully collected.",
            ),
        );
    } else {
        cursor =
            typeof info.endCursor === "string" ? info.endCursor : undefined;
        if (info.hasNextPage) next = cursor;
    }
    return {
        ...(nodes.length > 0 || issues.length === 0 ? { data: nodes } : {}),
        ...(next ? { next } : {}),
        ...(cursor ? { cursor } : {}),
        issues,
    };
}
function meaningful(value: JsonValue | undefined): boolean {
    return (
        value !== undefined &&
        value !== null &&
        value !== false &&
        value !== 0 &&
        value !== "" &&
        value !== "false"
    );
}
export function unmodelledContinuation(
    body: JsonValue,
    headers: Record<string, string>,
    exclude: string,
): boolean {
    if (headers.link?.trim()) return true;
    for (const [key, value] of Object.entries(headers)) {
        if (
            /(?:next(?:[-_](?:page|cursor|token))?$|next[-_](?:page|cursor|token)|continuation|has[-_]more)/i.test(
                key,
            ) &&
            meaningful(value.trim())
        )
            return true;
        if (/total[-_]pages$/i.test(key) && Number(value) > 1) return true;
    }
    function inspect(value: JsonValue, depth: number): boolean {
        if (depth > 64) return false;
        if (Array.isArray(value))
            return value.some((item) => inspect(item, depth + 1));
        if (!object(value)) return false;
        for (const [key, item] of Object.entries(value)) {
            if (key === exclude) continue;
            const normalized = key.replaceAll(/[_-]/g, "").toLowerCase();
            if (
                /^(?:next(?:page|url|link|cursor|token|pagetoken|pageurl)?|continuation(?:token|url)?|cursor|endcursor|hasmore|hasnext(?:page)?)$/.test(
                    normalized,
                ) &&
                meaningful(item)
            )
                return true;
            if (
                normalized === "totalpages" &&
                (typeof item === "number" || typeof item === "string") &&
                Number(item) > 1
            )
                return true;
            if (
                normalized === "rel" &&
                typeof item === "string" &&
                item.split(/\s+/).includes("next")
            )
                return true;
            if (
                (object(item) || Array.isArray(item)) &&
                inspect(item, depth + 1)
            )
                return true;
        }
        return false;
    }
    return object(body) && inspect(body, 0);
}
function restContinuation(
    read: ApprovedRead,
    currentUrl: string,
    header: string,
): { next?: string; issue?: PageIssue } {
    const invalid = () => ({
        issue: continuationIssue(
            "invalid_pagination",
            "A pagination link is malformed, repeated, or outside the approved request scope.",
        ),
    });
    if (header.length > 16384 || /[\u0000-\u001f\u007f]/.test(header))
        return invalid();
    const base = new URL(read.url);
    const currentPage = Number(
        new URL(currentUrl).searchParams.get("page") ?? "1",
    );
    const relations = new Map<string, { page: number; url: string }>();
    const parts = header.split(/,\s*(?=<)/);
    if (parts.length > 16) return invalid();
    for (const part of parts) {
        const match =
            /^\s*<([^<>]+)>\s*;\s*rel=(?:"([a-z ]+)"|([a-z]+))\s*$/i.exec(part);
        if (!match) return invalid();
        const raw = match[1]!;
        if (/[\\#\s]/.test(raw) || raw.length > 8192) return invalid();
        let url: URL;
        try {
            url = new URL(raw, currentUrl);
        } catch {
            return invalid();
        }
        if (
            url.origin !== origin ||
            url.pathname !== base.pathname ||
            url.username ||
            url.password ||
            url.hash ||
            /^https?:\/\/[^/]*@/i.test(raw) ||
            /^\/\/[^/]*@/.test(raw)
        )
            return invalid();
        const keys = [...url.searchParams.keys()];
        if (
            new Set(keys).size !== keys.length ||
            keys.length !== base.searchParams.size + 1 ||
            !url.searchParams.has("page")
        )
            return invalid();
        for (const [key, value] of base.searchParams)
            if (url.searchParams.get(key) !== value) return invalid();
        if (keys.some((key) => key !== "page" && !base.searchParams.has(key)))
            return invalid();
        const pageText = url.searchParams.get("page")!;
        const page = Number(pageText);
        if (!/^[1-9]\d*$/.test(pageText) || !Number.isSafeInteger(page))
            return invalid();
        for (const relation of (match[2] ?? match[3]!)
            .toLowerCase()
            .split(" ")) {
            if (
                !["next", "last", "prev", "first"].includes(relation) ||
                relations.has(relation)
            )
                return invalid();
            relations.set(relation, { page, url: url.href });
        }
    }
    const next = relations.get("next");
    const last = relations.get("last");
    const previous = relations.get("prev");
    const first = relations.get("first");
    if (
        next &&
        (next.page !== currentPage + 1 || (last && last.page < next.page))
    )
        return invalid();
    if (
        (previous && previous.page !== currentPage - 1) ||
        (first && first.page !== 1) ||
        (last && last.page < currentPage)
    )
        return invalid();
    if (!next && last && last.page > currentPage) return invalid();
    return next ? { next: next.url } : {};
}
export function decodePage(
    read: ApprovedRead,
    body: JsonValue,
    headers: Record<string, string>,
    currentUrl: string,
): DecodedPage {
    if (read.kind === "graphql") return graphPage(read, body);
    let data: JsonValue | undefined;
    switch (read.kind) {
        case "array":
            if (Array.isArray(body)) data = body;
            break;
        case "object":
            if (object(body)) data = body;
            break;
        case "actions":
            if (object(body) && Array.isArray(body.workflow_runs))
                data = body.workflow_runs;
            break;
        case "runners":
            if (object(body) && Array.isArray(body.runners))
                data = body.runners;
            break;
        case "installation":
            if (object(body) && Array.isArray(body.repositories)) data = body;
            break;
        case "billing":
            if (object(body) && Array.isArray(body.usageItems)) data = body;
            break;
    }
    if (data === undefined)
        return {
            issues: [
                invalidPage(
                    "invalid_response_container",
                    "The response is missing the required endpoint-specific data container.",
                ),
            ],
        };
    if (read.kind === "billing") {
        return {
            data,
            issues: unmodelledContinuation(body, headers, "usageItems")
                ? [
                      continuationIssue(
                          "unsupported_billing_continuation",
                          "Detailed billing advertised an unmodelled continuation; this validated partition is incomplete.",
                      ),
                  ]
                : [],
        };
    }
    const issues: PageIssue[] = [];
    let totalCount: number | undefined;
    if (
        (read.kind === "actions" || read.kind === "runners") &&
        object(body) &&
        Object.hasOwn(body, "total_count")
    ) {
        totalCount = nonnegativeInteger(body.total_count);
        if (totalCount === undefined)
            issues.push(
                invalidPage(
                    "invalid_total_count",
                    "The endpoint returned an invalid declared item count.",
                ),
            );
    }
    const count = totalCount === undefined ? {} : { totalCount };
    if (read.kind === "installation") {
        issues.push({
            kind: "unavailable",
            code: "installation_identity_unverified",
            message:
                "An installation repository listing does not verify the installation principal or its effective grants.",
            retryable: false,
            remediation:
                "Keep installation identity and grant assurance unverified; use the documented explicit credential-profile decision.",
        });
    }
    if (read.kind === "object" && headers.link?.trim()) {
        issues.push(
            continuationIssue(
                "unsupported_continuation",
                "A single-object read advertised an unmodelled continuation.",
            ),
        );
        return { data, ...count, issues };
    }
    const { link: _link, ...otherHeaders } = headers;
    const container =
        read.kind === "actions"
            ? "workflow_runs"
            : read.kind === "runners"
              ? "runners"
              : read.kind === "installation"
                ? "repositories"
                : "";
    if (unmodelledContinuation(body, otherHeaders, container)) {
        issues.push(
            continuationIssue(
                "unsupported_continuation",
                "The response advertised an unmodelled continuation.",
            ),
        );
        return { data, ...count, issues };
    }
    if (!headers.link?.trim()) return { data, ...count, issues };
    const continuation = restContinuation(read, currentUrl, headers.link);
    if (continuation.issue) issues.push(continuation.issue);
    return {
        data,
        ...count,
        ...(continuation.next ? { next: continuation.next } : {}),
        issues,
    };
}
