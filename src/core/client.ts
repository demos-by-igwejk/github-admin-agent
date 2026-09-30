import {
    API_VERSION,
    budgetLimitsSchema,
    type BudgetAuthority,
    type ClientOptions,
    type ClientProblem,
    type Clock,
    type Collection,
    type Diagnostic,
    type JsonValue,
    type ReadClient,
    type Transport,
    type TransportRequest,
    type TransportResponse,
} from "./contracts.ts";
import {
    approveRead,
    approvedRequest,
    decodePage,
    graphHasNodes,
    graphRateErrors,
    invalidPage,
    isoTime,
    jsonContentType,
    nonnegativeInteger,
    object,
    parseBody,
    rateError,
    reviewedOperations,
    type ApprovedRead,
    type PageIssue,
} from "./client-operations.ts";
import {
    ClientTransportError,
    fetchTransport,
    MAX_RESPONSE_BYTES,
} from "./client-transport.ts";
import { digest, redact, redactText } from "./redact.ts";

export { reviewedOperations, fetchTransport, MAX_RESPONSE_BYTES };
const MAX_TIMER_MS = 2 ** 31 - 1;

type GateResult =
    | { release: () => void; waitedMs: number }
    | { failure: "cancelled" | "exhausted"; waitedMs: number };
interface GateWaiter {
    grant(): void;
}

class SharedGate {
    readonly budget: BudgetAuthority;
    readonly clock: Clock;
    private active = 0;
    private readonly queue: GateWaiter[] = [];
    private readonly startedAt: number;
    private readonly initialElapsed: number;
    constructor(budget: BudgetAuthority, clock: Clock) {
        this.budget = budget;
        this.clock = clock;
        this.startedAt = clock.now().getTime();
        this.initialElapsed = budget.snapshot().elapsedMs;
    }
    remaining(): number {
        const state = this.budget.snapshot();
        return Math.max(
            0,
            state.limits.maxElapsedMs -
                Math.max(
                    state.elapsedMs,
                    this.initialElapsed +
                        Math.max(
                            0,
                            this.clock.now().getTime() - this.startedAt,
                        ),
                ),
        );
    }
    acquire(signal: AbortSignal): Promise<GateResult> {
        const start = this.clock.now().getTime();
        const remaining = this.remaining();
        if (signal.aborted)
            return Promise.resolve({ failure: "cancelled", waitedMs: 0 });
        if (remaining <= 0)
            return Promise.resolve({ failure: "exhausted", waitedMs: 0 });
        return new Promise((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const waited = () =>
                Math.max(0, this.clock.now().getTime() - start);
            const remove = () => {
                const index = this.queue.indexOf(waiter);
                if (index >= 0) this.queue.splice(index, 1);
                if (timer !== undefined) clearTimeout(timer);
                signal.removeEventListener("abort", cancel);
            };
            const fail = (failure: "cancelled" | "exhausted") => {
                if (settled) return;
                settled = true;
                remove();
                resolve({ failure, waitedMs: waited() });
            };
            const cancel = () => fail("cancelled");
            const scheduleExpiration = () => {
                const delay = this.remaining();
                if (delay <= 0) {
                    fail("exhausted");
                    return;
                }
                timer = setTimeout(
                    () => {
                        if (delay > MAX_TIMER_MS) scheduleExpiration();
                        else fail("exhausted");
                    },
                    Math.min(Math.ceil(delay), MAX_TIMER_MS),
                );
            };
            const waiter: GateWaiter = {
                grant: () => {
                    if (settled) return;
                    if (signal.aborted) {
                        fail("cancelled");
                        return;
                    }
                    if (this.remaining() <= 0) {
                        fail("exhausted");
                        return;
                    }
                    settled = true;
                    remove();
                    this.active++;
                    let released = false;
                    resolve({
                        waitedMs: waited(),
                        release: () => {
                            if (released) return;
                            released = true;
                            this.active--;
                            this.pump();
                        },
                    });
                },
            };
            signal.addEventListener("abort", cancel, { once: true });
            this.queue.push(waiter);
            scheduleExpiration();
            this.pump();
        });
    }
    private pump(): void {
        while (
            this.queue.length &&
            this.active < this.budget.snapshot().limits.concurrency
        )
            this.queue[0]!.grant();
    }
}
const sharedGates = new WeakMap<BudgetAuthority, SharedGate>();

type TransportOutcome =
    | { response: TransportResponse }
    | {
          failure:
              | "cancelled"
              | "timeout"
              | "exhausted"
              | "network"
              | "response_too_large"
              | "invalid_response_encoding";
      };
function requestWithDeadline(
    transport: Transport,
    request: Omit<TransportRequest, "signal">,
    signal: AbortSignal,
    timeoutMs: number,
    wallLimited: boolean,
): Promise<TransportOutcome> {
    return new Promise((resolve) => {
        const controller = new AbortController();
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (outcome: TransportOutcome) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            resolve(outcome);
        };
        const cancel = () => {
            controller.abort();
            finish({ failure: "cancelled" });
        };
        const fail = (error: unknown) => {
            if (signal.aborted) finish({ failure: "cancelled" });
            else if (error instanceof ClientTransportError)
                finish({ failure: error.code });
            else if (error instanceof Error && error.name === "TimeoutError")
                finish({ failure: "timeout" });
            else finish({ failure: "network" });
        };
        if (signal.aborted) {
            cancel();
            return;
        }
        signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(
            () => {
                controller.abort();
                finish({ failure: wallLimited ? "exhausted" : "timeout" });
            },
            Math.max(1, Math.ceil(timeoutMs)),
        );
        try {
            Promise.resolve(
                transport({ ...request, signal: controller.signal }),
            ).then((response) => finish({ response }), fail);
        } catch (error) {
            fail(error);
        }
    });
}
function normalizeResponse(
    value: TransportResponse,
): TransportResponse | undefined {
    if (
        !value ||
        typeof value.body !== "string" ||
        !Number.isInteger(value.status) ||
        value.status < 100 ||
        value.status > 599 ||
        !value.headers ||
        typeof value.headers !== "object" ||
        Array.isArray(value.headers)
    )
        return undefined;
    const headers: Record<string, string> = {};
    for (const [name, item] of Object.entries(value.headers)) {
        if (typeof item !== "string") return undefined;
        const key = name.toLowerCase();
        headers[key] =
            headers[key] === undefined ? item : `${headers[key]}, ${item}`;
    }
    return { status: value.status, body: value.body, headers };
}
function providerGuidance(
    read: ApprovedRead,
    response: TransportResponse,
    body: JsonValue | undefined,
    now: number,
): { rateLimited: boolean; notBefore?: string } {
    const headers = response.headers;
    const retryAfter = headers["retry-after"]?.trim();
    let retryAt: number | undefined;
    if (retryAfter) {
        const time = /^\d+(?:\.\d+)?$/.test(retryAfter)
            ? now + Number(retryAfter) * 1000
            : Date.parse(retryAfter);
        if (Number.isFinite(time) && Math.abs(time) <= 8.64e15) retryAt = time;
    }
    const remaining = nonnegativeInteger(headers["x-ratelimit-remaining"]);
    const graphData =
        read.graphField && object(body) && object(body.data)
            ? body.data
            : undefined;
    const graphRate =
        graphData && object(graphData.rateLimit)
            ? graphData.rateLimit
            : undefined;
    const graphLimited = read.graphField !== undefined && graphRateErrors(body);
    const rateLimited =
        response.status === 429 ||
        graphLimited ||
        (response.status === 403 &&
            (remaining === 0 || retryAt !== undefined || rateError(body)));
    const deadlines: number[] = retryAt === undefined ? [] : [retryAt];
    const exhausted =
        remaining === 0 ||
        (graphRate && nonnegativeInteger(graphRate.remaining) === 0);
    if (rateLimited || exhausted) {
        const reset = headers["x-ratelimit-reset"];
        if (
            reset &&
            /^\d+(?:\.\d+)?$/.test(reset) &&
            Number.isFinite(Number(reset)) &&
            Number(reset) * 1000 <= 8.64e15
        )
            deadlines.push(Number(reset) * 1000);
        if (graphRate && isoTime(graphRate.resetAt))
            deadlines.push(Date.parse(graphRate.resetAt));
    }
    if ((rateLimited || exhausted) && deadlines.length === 0)
        deadlines.push(now + 60000);
    if (deadlines.length === 0) return { rateLimited };
    return {
        rateLimited,
        notBefore: new Date(Math.max(...deadlines)).toISOString(),
    };
}
function safeData(value: JsonValue, secrets: readonly string[]): JsonValue {
    const cleaned = redact(value, secrets);
    function keys(item: JsonValue): JsonValue {
        if (Array.isArray(item)) return item.map(keys);
        if (object(item))
            return Object.fromEntries(
                Object.entries(item).map(([key, child]) => [
                    redactText(key, secrets),
                    keys(child),
                ]),
            );
        return item;
    }
    return keys(cleaned);
}
function abortableSleep(
    clock: Clock,
    milliseconds: number,
    signal: AbortSignal,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(new Error("cancelled"));
        };
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
        try {
            clock.sleep(milliseconds, signal).then(
                () => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                },
                () => {
                    signal.removeEventListener("abort", abort);
                    reject(new Error("wait_failed"));
                },
            );
        } catch {
            signal.removeEventListener("abort", abort);
            reject(new Error("wait_failed"));
        }
    });
}

/** Completed non-identity reads may be reused. Identity probes always revalidate live. */
export function createClient(options: ClientOptions): ReadClient {
    options = { ...options };
    if (options.host !== "github.com")
        throw new Error(
            "unsupported_deployment: Only github.com and its reviewed API origin are supported",
        );
    if (
        typeof options.org !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(options.org)
    )
        throw new Error("invalid_organization: Expected one organization slug");
    if (
        !Array.isArray(options.capabilities) ||
        options.capabilities.some(
            (operation) => !reviewedOperations.includes(operation),
        )
    )
        throw new Error(
            "unsupported_capability: Only explicitly reviewed read operations are accepted",
        );
    if (
        options.token !== undefined &&
        (typeof options.token !== "string" ||
            /[\u0000-\u0020\u007f]/.test(options.token))
    )
        throw new Error(
            "invalid_credential: Expected a token without whitespace or control characters",
        );
    if (options.synthetic && !options.transport)
        throw new Error(
            "synthetic_transport_required: Synthetic collection cannot fall back to the live API",
        );
    const limits = options.budget.snapshot().limits;
    // Durable grants can exceed initial configuration caps without changing request-level limits.
    if (
        ![limits.maxAttempts, limits.maxElapsedMs].every(
            (value) => Number.isSafeInteger(value) && value > 0,
        )
    ) {
        throw new Error(
            "invalid_budget_limits: Cumulative allowance limits must be positive safe integers",
        );
    }
    budgetLimitsSchema
        .pick({
            requestTimeoutMs: true,
            maxAttemptsPerRequest: true,
            concurrency: true,
        })
        .parse({
            requestTimeoutMs: limits.requestTimeoutMs,
            maxAttemptsPerRequest: limits.maxAttemptsPerRequest,
            concurrency: limits.concurrency,
        });
    let gate = sharedGates.get(options.budget);
    if (!gate) {
        gate = new SharedGate(options.budget, options.clock);
        sharedGates.set(options.budget, gate);
    }
    if (gate.clock !== options.clock)
        throw new Error(
            "client_clock_mismatch: Clients sharing one budget must share its clock",
        );
    const shared = gate;
    const capabilities = new Set(options.capabilities);
    const transport = options.transport ?? fetchTransport;
    const cache = options.cache ?? {};
    const secrets = options.token ? [options.token] : [];
    const inFlight = new Map<string, Promise<Collection>>();
    let checkpointTail: Promise<void> = Promise.resolve();

    async function run(
        read: ApprovedRead,
        key: string,
        cancelledCache?: Collection,
    ): Promise<Collection> {
        const collection: Collection = cancelledCache
            ? structuredClone(cancelledCache)
            : {
                  operation: read.operation,
                  pages: [],
                  completeness: "none",
                  problems: [],
              };
        let checkpointFailed = false;
        const clean = (text: string) => redactText(text, secrets);
        function diagnostic(
            issue: PageIssue,
            response?: TransportResponse,
            evidenceId?: string,
        ): Diagnostic {
            const id = response?.headers["x-github-request-id"];
            return options.addDiagnostic({
                code: clean(issue.code),
                message: clean(issue.message),
                operation: read.operation,
                target: clean(read.target),
                retryable: issue.retryable,
                remediation: clean(issue.remediation),
                ...(response ? { status: response.status } : {}),
                ...(id && /^[A-Za-z0-9:_-]{1,128}$/.test(id)
                    ? { requestId: clean(id) }
                    : {}),
                ...(evidenceId ? { evidenceId } : {}),
                ...(issue.notBefore ? { notBefore: issue.notBefore } : {}),
            });
        }
        const problem = (
            issue: PageIssue,
            response?: TransportResponse,
            evidenceId?: string,
        ): ClientProblem => ({
            kind: issue.kind,
            diagnostic: diagnostic(issue, response, evidenceId),
        });
        const cancelled = () =>
            problem({
                kind: "cancelled",
                code: "cancelled",
                message:
                    "Collection was cancelled; already validated observations are retained.",
                retryable: true,
                remediation:
                    "Resume the same lineage after reviewing the cancellation receipt.",
            });
        const exhausted = () =>
            problem({
                kind: "exhausted",
                code: "budget_exhausted",
                message:
                    "The cumulative request or elapsed-time allowance is exhausted.",
                retryable: true,
                remediation:
                    "Resume only after an explicit additional-allowance decision.",
            });
        const unavailable = (code: string, message: string) =>
            problem({
                kind: "unavailable",
                code,
                message,
                retryable: true,
                remediation:
                    "Inspect the local execution diagnostic and resume unfinished work without resetting its allowance.",
            });
        const providerWait = (notBefore: string) =>
            problem({
                kind: "provider-wait",
                code: "provider_wait",
                message:
                    "The provider deadline cannot be completed within the remaining execution allowance.",
                retryable: true,
                remediation:
                    "Resume the same lineage no earlier than the recorded deadline with sufficient remaining allowance.",
                notBefore,
            });
        function completeness(done: boolean): void {
            collection.completeness =
                done && collection.problems.length === 0
                    ? "complete"
                    : collection.pages.length
                      ? "partial"
                      : "none";
        }
        async function save(done: boolean): Promise<boolean> {
            completeness(done);
            if (read.cacheable && !cancelledCache)
                cache[key] = structuredClone(collection);
            if (checkpointFailed) return false;
            if (!options.checkpoint) return true;
            const snapshot = structuredClone(cache);
            const checkpoint = checkpointTail.then(
                () => options.checkpoint!(snapshot),
                () => options.checkpoint!(snapshot),
            );
            checkpointTail = checkpoint;
            try {
                await checkpoint;
                return true;
            } catch {
                checkpointFailed = true;
                collection.problems.push(
                    unavailable(
                        "checkpoint_failed",
                        "The client could not durably checkpoint its validated progress.",
                    ),
                );
                completeness(false);
                if (read.cacheable && !cancelledCache)
                    cache[key] = structuredClone(collection);
                return false;
            }
        }
        async function recordWait(
            milliseconds: number,
        ): Promise<ClientProblem | undefined> {
            if (milliseconds <= 0) return undefined;
            try {
                await options.budget.recordWait(milliseconds);
                return undefined;
            } catch {
                return unavailable(
                    "budget_record_failed",
                    "Elapsed waiting could not be durably recorded.",
                );
            }
        }
        async function waitUntil(
            deadline: number,
            provider: boolean,
        ): Promise<ClientProblem | undefined> {
            for (;;) {
                const start = options.clock.now().getTime();
                if (options.signal.aborted) return cancelled();
                if (deadline <= start) return undefined;
                const notBefore = new Date(deadline).toISOString();
                if (deadline - start >= shared.remaining())
                    return provider ? providerWait(notBefore) : exhausted();
                if (
                    options.budget.snapshot().attempts >=
                    options.budget.snapshot().limits.maxAttempts
                )
                    return provider ? providerWait(notBefore) : exhausted();
                const duration = Math.min(deadline - start, MAX_TIMER_MS);
                let failed = false;
                try {
                    await abortableSleep(
                        options.clock,
                        duration,
                        options.signal,
                    );
                } catch {
                    failed = true;
                }
                const end = options.clock.now().getTime();
                const accounting = await recordWait(Math.max(0, end - start));
                if (accounting) return accounting;
                if (options.signal.aborted) return cancelled();
                if (failed)
                    return unavailable(
                        "wait_failed",
                        "Waiting was interrupted without completing the required delay.",
                    );
                if (end < start + duration)
                    return provider
                        ? providerWait(notBefore)
                        : unavailable(
                              "wait_incomplete",
                              "The injected clock did not complete the required retry delay.",
                          );
            }
        }
        async function beforeRequest(): Promise<ClientProblem | undefined> {
            if (options.signal.aborted) return cancelled();
            const state = options.budget.snapshot();
            if (state.notBefore) {
                if (!isoTime(state.notBefore))
                    return problem(
                        invalidPage(
                            "invalid_budget_deadline",
                            "The persisted provider deadline is invalid.",
                        ),
                    );
                const waiting = await waitUntil(
                    Date.parse(state.notBefore),
                    true,
                );
                if (waiting) return waiting;
            }
            if (
                state.attempts >= state.limits.maxAttempts ||
                shared.remaining() <= 0
            )
                return exhausted();
            return undefined;
        }
        type CheckedOutcome =
            | Exclude<TransportOutcome, { response: TransportResponse }>
            | {
                  response: TransportResponse;
                  body?: JsonValue;
                  observedAt: string;
                  rateLimited: boolean;
                  notBefore?: string;
              };
        async function attempt(
            request: Omit<TransportRequest, "signal">,
            retry: boolean,
        ): Promise<CheckedOutcome | ClientProblem> {
            for (;;) {
                const before = await beforeRequest();
                if (before) return before;
                const acquired = await shared.acquire(options.signal);
                const waiting = await recordWait(acquired.waitedMs);
                if ("failure" in acquired)
                    return (
                        waiting ??
                        (acquired.failure === "cancelled"
                            ? cancelled()
                            : exhausted())
                    );
                try {
                    if (waiting) return waiting;
                    if (options.signal.aborted) return cancelled();
                    const state = options.budget.snapshot();
                    if (
                        state.notBefore &&
                        Date.parse(state.notBefore) >
                            options.clock.now().getTime()
                    )
                        continue;
                    if (shared.remaining() <= 0) return exhausted();
                    let reservation;
                    try {
                        reservation = await options.budget.reserve();
                    } catch {
                        return unavailable(
                            "budget_reservation_failed",
                            "A request attempt could not be durably reserved; transport was not invoked.",
                        );
                    }
                    if (!reservation.ok) {
                        const value = reservation.problem;
                        return problem({
                            kind: value.kind,
                            code: value.diagnostic.code,
                            message: value.diagnostic.message,
                            retryable: value.diagnostic.retryable,
                            remediation: value.diagnostic.remediation,
                            ...(value.diagnostic.notBefore &&
                            isoTime(value.diagnostic.notBefore)
                                ? { notBefore: value.diagnostic.notBefore }
                                : {}),
                        });
                    }
                    if (options.signal.aborted) return cancelled();
                    if (retry) {
                        try {
                            await options.budget.recordRetry();
                        } catch {
                            return unavailable(
                                "budget_record_failed",
                                "A repeated attempt could not be durably recorded; transport was not invoked.",
                            );
                        }
                    }
                    const remaining = shared.remaining();
                    if (remaining <= 0) return exhausted();
                    const timeout =
                        options.budget.snapshot().limits.requestTimeoutMs;
                    const outcome = await requestWithDeadline(
                        transport,
                        request,
                        options.signal,
                        Math.min(timeout, remaining),
                        remaining <= timeout,
                    );
                    if ("failure" in outcome) return outcome;
                    const observedAt = options.clock.now().toISOString();
                    const response = normalizeResponse(outcome.response);
                    if (!response)
                        return problem(
                            invalidPage(
                                "invalid_transport_response",
                                "The transport returned an invalid response envelope.",
                            ),
                        );
                    if (
                        Buffer.byteLength(response.body, "utf8") >
                        MAX_RESPONSE_BYTES
                    )
                        return problem(
                            invalidPage(
                                "response_too_large",
                                "The response exceeded the bounded response-size limit.",
                            ),
                            response,
                        );
                    const body = jsonContentType(response.headers)
                        ? parseBody(response.body, read.kind === "billing")
                        : undefined;
                    const guidance = providerGuidance(
                        read,
                        response,
                        body,
                        options.clock.now().getTime(),
                    );
                    if (guidance.notBefore) {
                        try {
                            await options.budget.deferUntil(guidance.notBefore);
                        } catch {
                            return unavailable(
                                "provider_deadline_not_persisted",
                                "The provider deadline could not be durably recorded; no retry was attempted.",
                            );
                        }
                    }
                    return {
                        response,
                        observedAt,
                        ...(body === undefined ? {} : { body }),
                        ...guidance,
                    };
                } finally {
                    acquired.release();
                }
            }
        }
        type PageResponse =
            | {
                  response: TransportResponse;
                  body: JsonValue;
                  observedAt: string;
                  notBefore?: string;
              }
            | { stop: ClientProblem };
        async function getPage(continuation?: string): Promise<PageResponse> {
            const prepared = approvedRequest(read, continuation);
            const limit =
                options.budget.snapshot().limits.maxAttemptsPerRequest;
            for (let index = 0; index < limit; index++) {
                const headers: Record<string, string> = {
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": API_VERSION,
                };
                if (options.token)
                    headers.Authorization = `Bearer ${options.token}`;
                if (prepared.method === "POST")
                    headers["Content-Type"] = "application/json";
                const outcome = await attempt(
                    { ...prepared, headers },
                    index > 0,
                );
                if ("diagnostic" in outcome) return { stop: outcome };
                let response: TransportResponse | undefined;
                let body: JsonValue | undefined;
                let notBefore: string | undefined;
                let retryable = false;
                let failure: ClientProblem | undefined;
                if ("failure" in outcome) {
                    if (outcome.failure === "cancelled")
                        return { stop: cancelled() };
                    if (outcome.failure === "exhausted")
                        return { stop: exhausted() };
                    if (
                        outcome.failure === "response_too_large" ||
                        outcome.failure === "invalid_response_encoding"
                    ) {
                        return {
                            stop: problem(
                                invalidPage(
                                    outcome.failure,
                                    "The response exceeded the bounded transport contract.",
                                ),
                            ),
                        };
                    }
                    retryable = outcome.failure === "timeout";
                    if (!retryable || index + 1 === limit)
                        failure = unavailable(
                            outcome.failure === "timeout"
                                ? "request_timeout"
                                : "transport_unavailable",
                            "The read transport did not produce a usable response.",
                        );
                } else {
                    response = outcome.response;
                    body = outcome.body;
                    notBefore = outcome.notBefore;
                    const graphRateFailure =
                        read.graphField &&
                        graphRateErrors(body) &&
                        !graphHasNodes(read, body);
                    if (
                        response.status >= 200 &&
                        response.status < 300 &&
                        !graphRateFailure
                    ) {
                        if (!jsonContentType(response.headers))
                            return {
                                stop: problem(
                                    invalidPage(
                                        "invalid_content_type",
                                        "The successful response was not a JSON media type.",
                                    ),
                                    response,
                                ),
                            };
                        if (body === undefined)
                            return {
                                stop: problem(
                                    invalidPage(
                                        "invalid_json",
                                        "The successful response was not bounded, unambiguous JSON.",
                                    ),
                                    response,
                                ),
                            };
                        return {
                            response,
                            body,
                            observedAt: outcome.observedAt,
                            ...(notBefore ? { notBefore } : {}),
                        };
                    }
                    retryable =
                        response.status === 429 ||
                        (response.status === 403 && outcome.rateLimited) ||
                        (response.status >= 200 &&
                            response.status < 300 &&
                            Boolean(graphRateFailure)) ||
                        response.status >= 500;
                    if (!retryable) {
                        const denied =
                            response.status === 401 || response.status === 403;
                        const invalid =
                            response.status === 422 ||
                            (response.status >= 300 && response.status < 400);
                        failure = problem(
                            {
                                kind: denied
                                    ? "denied"
                                    : invalid
                                      ? "invalid"
                                      : "unavailable",
                                code: denied
                                    ? "access_denied"
                                    : invalid
                                      ? "request_rejected"
                                      : "http_unavailable",
                                message: denied
                                    ? "The credential is not authorized for the required read."
                                    : invalid
                                      ? "The provider rejected or redirected the reviewed request."
                                      : "The provider did not return the required resource.",
                                retryable: false,
                                remediation: denied
                                    ? "Correct the explicitly selected credential profile and revalidate identity and grants; do not escalate automatically."
                                    : "Review the target, endpoint contract, and provider availability.",
                            },
                            response,
                        );
                    } else if (index + 1 === limit) {
                        failure =
                            notBefore &&
                            Date.parse(notBefore) >
                                options.clock.now().getTime()
                                ? providerWait(notBefore)
                                : unavailable(
                                      "request_attempts_exhausted",
                                      "The bounded attempts for this request were exhausted.",
                                  );
                    }
                }
                if (failure) return { stop: failure };
                if (!retryable)
                    return {
                        stop: unavailable(
                            "transport_unavailable",
                            "The read transport did not produce a usable response.",
                        ),
                    };
                diagnostic(
                    {
                        kind: "unavailable",
                        code: "request_retry",
                        message:
                            "An eligible read failure will be retried within the same cumulative allowance.",
                        retryable: true,
                        remediation:
                            "Retain the lineage and its provider deadline when resuming.",
                        ...(notBefore ? { notBefore } : {}),
                    },
                    response,
                );
                if (!(await save(false)))
                    return {
                        stop: collection.problems[
                            collection.problems.length - 1
                        ]!,
                    };
                if (notBefore) {
                    const waiting = await waitUntil(
                        Date.parse(notBefore),
                        true,
                    );
                    if (waiting) return { stop: waiting };
                } else {
                    const waiting = await waitUntil(
                        options.clock.now().getTime() +
                            Math.min(1000 * 2 ** index, 30000),
                        false,
                    );
                    if (waiting) return { stop: waiting };
                }
            }
            return {
                stop: unavailable(
                    "request_attempts_exhausted",
                    "The bounded attempts for this request were exhausted.",
                ),
            };
        }
        let continuation: string | undefined;
        let declaredCount = 0,
            observedCount = 0;
        const visited = new Set<string>();
        for (;;) {
            const request = approvedRequest(read, continuation);
            visited.add(continuation ?? (read.graphField ? "" : read.url));
            const result = await getPage(continuation);
            if ("stop" in result) {
                if (!collection.problems.includes(result.stop))
                    collection.problems.push(result.stop);
                await save(false);
                return collection;
            }
            const decoded = decodePage(
                read,
                result.body,
                result.response.headers,
                request.url,
            );
            if (decoded.totalCount !== undefined)
                declaredCount = Math.max(declaredCount, decoded.totalCount);
            let evidenceId: string | undefined;
            if (decoded.data !== undefined) {
                const observedAt = result.observedAt;
                const data = safeData(decoded.data, secrets);
                const evidence = options.addEvidence({
                    operation: read.operation,
                    target: clean(read.target),
                    observedAt,
                    source: clean(request.url),
                    data,
                });
                evidenceId = evidence.id;
                collection.pages.push({ evidenceId, observedAt, data });
                if (Array.isArray(data)) observedCount += data.length;
            }
            for (const issue of decoded.issues) {
                collection.problems.push(
                    problem(
                        {
                            ...issue,
                            ...(issue.kind === "provider-wait" &&
                            result.notBefore
                                ? { notBefore: result.notBefore }
                                : {}),
                        },
                        result.response,
                        evidenceId,
                    ),
                );
            }
            const cursor = decoded.cursor ?? decoded.next;
            if (cursor && visited.has(cursor)) {
                collection.problems.push(
                    problem(
                        {
                            kind: "unsupported-continuation",
                            code: "repeated_pagination",
                            message:
                                "The provider repeated a previously requested continuation.",
                            retryable: false,
                            remediation:
                                "Review pagination before resuming; do not infer completion from repeated cursors.",
                        },
                        result.response,
                        evidenceId,
                    ),
                );
                decoded.next = undefined;
            }
            if (!decoded.next && declaredCount > observedCount) {
                collection.problems.push(
                    problem(
                        {
                            kind: "unsupported-continuation",
                            code: "pagination_count_mismatch",
                            message:
                                "The endpoint declares more items than its collected pages expose, without a usable continuation.",
                            retryable: false,
                            remediation:
                                "Review endpoint result limits and missing pagination; retained observations do not establish complete history.",
                        },
                        result.response,
                        evidenceId,
                    ),
                );
            }
            if (options.signal.aborted) {
                collection.problems.push(cancelled());
                decoded.next = undefined;
            }
            if (!(await save(decoded.next === undefined))) return collection;
            if (
                options.signal.aborted &&
                !collection.problems.some((value) => value.kind === "cancelled")
            ) {
                collection.problems.push(cancelled());
                await save(false);
                return collection;
            }
            if (!decoded.next) return collection;
            continuation = decoded.next;
        }
    }

    return {
        async collect(operation, args) {
            const read = approveRead(
                options.org,
                capabilities,
                operation,
                args,
            );
            const key = `${operation}:${digest(read.args)}`;
            const existing = Object.hasOwn(cache, key) ? cache[key] : undefined;
            if (
                read.cacheable &&
                existing?.operation === operation &&
                existing.completeness === "complete" &&
                existing.problems.length === 0 &&
                existing.pages.length > 0
            ) {
                return options.signal.aborted
                    ? run(read, key, existing)
                    : structuredClone(existing);
            }
            if (!read.cacheable) return run(read, key);
            const pending = inFlight.get(key);
            if (pending) return structuredClone(await pending);
            const work = run(read, key);
            inFlight.set(key, work);
            try {
                return structuredClone(await work);
            } finally {
                inFlight.delete(key);
            }
        },
    };
}
