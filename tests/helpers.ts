import type {
    BudgetAuthority,
    BudgetLimits,
    BudgetSnapshot,
    ClientOptions,
    Clock,
    Collection,
    Config,
    Diagnostic,
    Evidence,
    JsonValue,
    OperationId,
    ReadClient,
    Reservation,
    ScenarioContext,
} from "../src/core/contracts.ts";
import { budgetLimitsSchema, configSchema } from "../src/core/contracts.ts";

export class TestClock implements Clock {
    value: number;
    constructor(iso = "2026-09-15T12:00:00.000Z") {
        this.value = Date.parse(iso);
    }
    now(): Date {
        return new Date(this.value);
    }
    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throw new Error("cancelled");
        this.value += ms;
    }
}
export class MemoryBudget implements BudgetAuthority {
    readonly clock: Clock;
    state: BudgetSnapshot;
    constructor(
        limits: Partial<BudgetLimits> = {},
        clock: Clock = new TestClock(),
    ) {
        this.clock = clock;
        this.state = {
            attempts: 0,
            elapsedMs: 0,
            waitMs: 0,
            retries: 0,
            limits: budgetLimitsSchema.parse(limits),
        };
    }
    async reserve(): Promise<Reservation> {
        if (
            this.state.notBefore &&
            Date.parse(this.state.notBefore) > this.clock.now().getTime()
        )
            return this.problem("provider-wait", "provider_wait");
        if (
            this.state.attempts >= this.state.limits.maxAttempts ||
            this.state.elapsedMs >= this.state.limits.maxElapsedMs
        )
            return this.problem("exhausted", "budget_exhausted");
        return { ok: true, attempt: ++this.state.attempts };
    }
    private problem(
        kind: "exhausted" | "provider-wait",
        code: string,
    ): Reservation {
        return {
            ok: false,
            problem: {
                kind,
                diagnostic: {
                    id: code,
                    code,
                    message: code,
                    retryable: true,
                    remediation:
                        "Resume after an explicit allowance decision or provider deadline.",
                    ...(this.state.notBefore
                        ? { notBefore: this.state.notBefore }
                        : {}),
                },
            },
        };
    }
    async recordWait(ms: number): Promise<void> {
        this.state.waitMs += ms;
        this.state.elapsedMs += ms;
    }
    async recordRetry(): Promise<void> {
        this.state.retries++;
    }
    async deferUntil(iso: string): Promise<void> {
        if (
            !this.state.notBefore ||
            Date.parse(iso) > Date.parse(this.state.notBefore)
        )
            this.state.notBefore = iso;
    }
    snapshot(): BudgetSnapshot {
        return structuredClone(this.state);
    }
}
export function fakeContext(
    responses: Partial<Record<OperationId, JsonValue | Collection>> = {},
    config: Partial<Config> = {},
): ScenarioContext {
    const clock = new TestClock(),
        evidence: Evidence[] = [],
        diagnostics: Diagnostic[] = [];
    const context: ScenarioContext = {
        config: configSchema.parse({ org: "example-org", ...config }),
        clock,
        signal: new AbortController().signal,
        startedAt: clock.now().toISOString(),
        synthetic: true,
        runId: "test-run",
        rootId: "test-run",
        budget: new MemoryBudget({}, clock),
        inputs: {},
        evidence,
        diagnostics,
        addEvidence(value) {
            const item: Evidence = {
                ...value,
                id: `e${evidence.length + 1}`,
                synthetic: true,
            };
            evidence.push(item);
            return item;
        },
        addDiagnostic(value) {
            const item = { ...value, id: `d${diagnostics.length + 1}` };
            diagnostics.push(item);
            return item;
        },
        client: {
            async collect(operation, args) {
                const response = responses[operation];
                if (
                    response &&
                    typeof response === "object" &&
                    !Array.isArray(response) &&
                    "completeness" in response
                )
                    return response as Collection;
                const observed = context.addEvidence({
                    operation,
                    target: args.repo ? `${args.org}/${args.repo}` : args.org,
                    observedAt: clock.now().toISOString(),
                    source: `fixture:${operation}`,
                    data: response === undefined ? [] : (response as JsonValue),
                });
                return {
                    operation,
                    pages: [
                        {
                            evidenceId: observed.id,
                            observedAt: observed.observedAt,
                            data: observed.data,
                        },
                    ],
                    completeness: "complete",
                    problems: [],
                };
            },
        },
    };
    return context;
}
export function clientOptions(
    overrides: Partial<ClientOptions> = {},
): ClientOptions {
    const context = fakeContext();
    return {
        host: "github.com",
        org: "example-org",
        capabilities: ["repositories.list"],
        budget: context.budget,
        clock: context.clock,
        signal: context.signal,
        synthetic: true,
        addEvidence: (value) => context.addEvidence(value),
        addDiagnostic: (value) => context.addDiagnostic(value),
        ...overrides,
    };
}
export function recordingClient(client: ReadClient): {
    client: ReadClient;
    operations: OperationId[];
} {
    const operations: OperationId[] = [];
    return {
        operations,
        client: {
            async collect(operation, args) {
                operations.push(operation);
                return client.collect(operation, args);
            },
        },
    };
}
