import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
    budgetLimitsSchema,
    configSchema,
    jsonObjectSchema,
    jsonValueSchema,
} from "./contracts.ts";
import type {
    BudgetSnapshot,
    OpenRunOptions,
    Reservation,
    RunSession,
    StoredRun,
} from "./contracts.ts";
import { isFsError, resolveSafePath } from "./paths.ts";
import { digest } from "./redact.ts";
import {
    bindingSchema,
    budgetSnapshotSchema,
    checkpointSchema,
    counterSchema,
    hashSchema,
    identitySchema,
    safeIdSchema,
    sanitize,
    statusSchema,
    storedRunSchema,
    timestampSchema,
    validate,
} from "./storage-schemas.ts";
import {
    acquireLock,
    atomicWrite,
    ensureDirectory,
    readSealed,
    reportsRoot,
    seal,
    writeExclusive,
} from "./storage.ts";
import type { StorageLock } from "./storage.ts";

const allowanceSchema = z
    .strictObject({
        additionalAttempts: counterSchema
            .refine((value) => value > 0)
            .optional(),
        additionalElapsedMs: counterSchema
            .refine((value) => value > 0)
            .optional(),
        reason: z.string().trim().min(1).max(2000),
    })
    .refine(
        (value) =>
            value.additionalAttempts !== undefined ||
            value.additionalElapsedMs !== undefined,
        "An allowance must add budget",
    );
const grantSchema = z.strictObject({
    id: safeIdSchema,
    runId: safeIdSchema,
    parentRunId: safeIdSchema,
    at: timestampSchema,
    additionalAttempts: counterSchema,
    additionalElapsedMs: counterSchema,
    reason: z.string().min(1).max(2000),
});
const pointerSchema = z.strictObject({
    sequence: counterSchema.refine((value) => value > 0),
    snapshotId: safeIdSchema,
    sha256: hashSchema,
});
const rootSchema = z.strictObject({
    schemaVersion: z.literal("1"),
    rootId: safeIdSchema,
    headRunId: safeIdSchema,
    sequence: counterSchema,
    baseLimits: budgetLimitsSchema,
    budget: budgetSnapshotSchema,
    grants: z.array(grantSchema),
    runs: z.record(safeIdSchema, pointerSchema),
    attachedAt: timestampSchema.optional(),
});
type RootRecord = z.infer<typeof rootSchema>;
const runRefSchema = z.strictObject({
    schemaVersion: z.literal("1"),
    runId: safeIdSchema,
    rootId: safeIdSchema,
});
const headPath = (id: string) => path.join(".state", "roots", id, "head.json");
const runDirectory = (id: string) => path.join(".state", "runs", id);
const refPath = (id: string) => path.join(runDirectory(id), "ref.json");
const snapshotPath = (id: string, snapshotId: string) =>
    path.join(runDirectory(id), "checkpoints", `${snapshotId}.json`);

function safeSum(left: number, right: number): number {
    const sum = left + right;
    if (!Number.isSafeInteger(sum) || sum < 0)
        throw new Error(
            "invalid_budget: Cumulative accounting exceeds a safe integer",
        );
    return sum;
}

function clockTime(options: OpenRunOptions): string {
    const value = options.clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
        throw new Error("invalid_clock: Expected a valid Date");
    return value.toISOString();
}

function accrue(root: RootRecord, now: string): void {
    if (root.attachedAt) {
        const elapsed = Date.parse(now) - Date.parse(root.attachedAt);
        if (elapsed < 0)
            throw new Error(
                "clock_regression: Clock moved behind the durable elapsed-accounting boundary",
            );
        root.budget.elapsedMs = safeSum(root.budget.elapsedMs, elapsed);
    }
    root.attachedAt = now;
}

function validateRoot(record: RootRecord): void {
    if (
        record.sequence < 1 ||
        record.runs[record.headRunId]?.sequence !== record.sequence ||
        !record.runs[record.rootId]
    ) {
        throw new Error(
            "corrupt_lineage: Root head does not match the committed run ledger",
        );
    }
    const limits = { ...record.baseLimits };
    const grantIds = new Set<string>();
    for (const grant of record.grants) {
        if (
            grantIds.has(grant.id) ||
            !record.runs[grant.runId] ||
            !record.runs[grant.parentRunId]
        ) {
            throw new Error(
                "corrupt_lineage: Allowance receipt is duplicated or has no committed parent/run",
            );
        }
        grantIds.add(grant.id);
        limits.maxAttempts = safeSum(
            limits.maxAttempts,
            grant.additionalAttempts,
        );
        limits.maxElapsedMs = safeSum(
            limits.maxElapsedMs,
            grant.additionalElapsedMs,
        );
    }
    if (
        digest(limits) !== digest(record.budget.limits) ||
        record.budget.attempts > limits.maxAttempts
    ) {
        throw new Error(
            "corrupt_lineage: Effective allowance disagrees with its grant receipts",
        );
    }
    for (const pointer of Object.values(record.runs)) {
        if (pointer.sequence > record.sequence)
            throw new Error(
                "corrupt_lineage: Run checkpoint is ahead of its root head",
            );
    }
}

async function loadSnapshot(
    directory: string,
    record: RootRecord,
    runId: string,
): Promise<StoredRun> {
    const pointer = record.runs[runId];
    if (!pointer)
        throw new Error(
            "missing_lineage: Run is not committed in its root ledger",
        );
    const state = await readSealed(
        directory,
        snapshotPath(runId, pointer.snapshotId),
        storedRunSchema,
        "checkpoint",
    );
    if (
        state.runId !== runId ||
        state.rootId !== record.rootId ||
        state.sequence !== pointer.sequence ||
        digest(state) !== pointer.sha256
    ) {
        throw new Error(
            "corrupt_checkpoint: Snapshot does not match the authoritative root pointer",
        );
    }
    if (state.runId === state.rootId) {
        if (state.parentRunId)
            throw new Error(
                "corrupt_lineage: The root run cannot have a parent",
            );
    } else if (
        !state.parentRunId ||
        !record.runs[state.parentRunId] ||
        record.runs[state.parentRunId]!.sequence >= state.sequence
    ) {
        throw new Error(
            "corrupt_lineage: Refresh has no earlier committed parent",
        );
    }
    if (
        state.binding.host !== state.config.host ||
        state.binding.org !== state.config.org
    ) {
        throw new Error(
            "corrupt_checkpoint: Binding and effective configuration disagree",
        );
    }
    return state;
}

async function loadRun(
    directory: string,
    runId: string,
): Promise<{ record: RootRecord; state: StoredRun }> {
    try {
        const ref = await readSealed(
            directory,
            refPath(runId),
            runRefSchema,
            "run_reference",
        );
        if (ref.runId !== runId)
            throw new Error(
                "corrupt_lineage: Run reference has the wrong identity",
            );
        const record = await readSealed(
            directory,
            headPath(ref.rootId),
            rootSchema,
            "lineage",
        );
        if (record.rootId !== ref.rootId)
            throw new Error(
                "corrupt_lineage: Root reference has the wrong identity",
            );
        validateRoot(record);
        const state = await loadSnapshot(directory, record, runId);
        const head =
            record.headRunId === runId
                ? state
                : await loadSnapshot(directory, record, record.headRunId);
        if (digest(head.budget) !== digest(record.budget))
            throw new Error(
                "corrupt_lineage: Head checkpoint does not match authoritative budget",
            );
        return { record, state };
    } catch (error) {
        if (isFsError(error, "ENOENT"))
            throw new Error(
                "missing_lineage: A required lineage file is missing; no allowance was created",
            );
        throw error;
    }
}

export async function readRun(
    root: string,
    reportsPath: string,
    runId: string,
): Promise<StoredRun> {
    validate(safeIdSchema, runId, "run_id");
    try {
        const directory = await reportsRoot(root, reportsPath, false);
        return (await loadRun(directory, runId)).state;
    } catch (error) {
        if (isFsError(error, "ENOENT"))
            throw new Error(
                "missing_lineage: Report root or authoritative lineage is missing; no allowance was created",
            );
        throw error;
    }
}

function validateOptions(options: OpenRunOptions): void {
    validate(z.enum(["new", "resume", "refresh"]), options.mode, "run_mode");
    validate(bindingSchema, options.binding, "binding");
    validate(configSchema, options.config, "config");
    validate(jsonObjectSchema, options.input, "input");
    validate(z.record(z.string(), jsonValueSchema), options.inputs, "inputs");
    validate(identitySchema, options.identity, "identity");
    if (
        options.binding.host !== options.config.host ||
        options.binding.org !== options.config.org
    ) {
        throw new Error(
            "binding_mismatch: Host and organization must agree with the effective configuration",
        );
    }
    if (
        options.identity.profile !== options.config.credential.name ||
        options.identity.credentialClass !==
            options.config.credential.credentialClass
    ) {
        throw new Error(
            "binding_mismatch: Identity profile and credential class must agree with the effective configuration",
        );
    }
    if (options.expectedSequence !== undefined)
        validate(
            counterSchema.refine((value) => value > 0),
            options.expectedSequence,
            "expected_sequence",
        );
    if (options.allowance)
        validate(allowanceSchema, options.allowance, "allowance");
    if (options.mode === "new") {
        if (
            options.runId ||
            options.expectedSequence !== undefined ||
            options.allowance
        ) {
            throw new Error(
                "invalid_new_run: New requests receive a generated identity and their configured initial allowance",
            );
        }
    } else validate(safeIdSchema, options.runId, "run_id");
}

const inputScopeKeys = [
    "scope",
    "host",
    "org",
    "organization",
    "enterprise",
    "repositories",
    "repository",
    "month",
    "months",
    "partitions",
    "partition",
];

function compatible(previous: StoredRun, options: OpenRunOptions): void {
    if (options.mode === "resume") {
        for (const key of [
            "binding",
            "config",
            "input",
            "inputs",
            "identity",
        ] as const) {
            if (digest(previous[key]) !== digest(options[key]))
                throw new Error(
                    `binding_mismatch: Resume changed ${key}; use an explicitly compatible refresh or a new request`,
                );
        }
        return;
    }
    for (const key of Object.keys(
        previous.binding,
    ) as (keyof StoredRun["binding"])[]) {
        if (
            key !== "configHash" &&
            key !== "inputHash" &&
            previous.binding[key] !== options.binding[key]
        ) {
            throw new Error(
                `binding_mismatch: Refresh cannot change ${key}; start a new independent request`,
            );
        }
    }
    if (
        digest(previous.identity) !== digest(options.identity) ||
        digest(previous.config.selection) !== digest(options.config.selection)
    ) {
        throw new Error(
            "binding_mismatch: Refresh cannot change principal or selected scope; start a new independent request",
        );
    }
    if (digest(previous.config.budgets) !== digest(options.config.budgets)) {
        throw new Error(
            "binding_mismatch: Budget increases require an explicit allowance receipt, not a changed configuration",
        );
    }
    for (const key of inputScopeKeys) {
        if (
            digest(previous.input[key] ?? null) !==
            digest(options.input[key] ?? null)
        ) {
            throw new Error(
                `binding_mismatch: Refresh cannot change input scope field ${key}; start a new independent request`,
            );
        }
    }
}

class DurableSession implements RunSession {
    private readonly directory: string;
    private readonly options: OpenRunOptions;
    private readonly lock: StorageLock;
    private record: RootRecord;
    private stored: StoredRun;
    private queue: Promise<void> = Promise.resolve();
    private closed = false;
    private failure: unknown;
    constructor(
        directory: string,
        options: OpenRunOptions,
        lock: StorageLock,
        record: RootRecord,
        stored: StoredRun,
    ) {
        this.directory = directory;
        this.options = options;
        this.lock = lock;
        this.record = record;
        this.stored = stored;
    }

    // State is a defensive snapshot; only explicit session methods persist changes.
    get state(): StoredRun {
        return structuredClone(this.stored);
    }

    private serial<T>(action: () => Promise<T>): Promise<T> {
        const work = this.queue.then(async () => {
            if (this.closed)
                throw new Error(
                    "session_closed: This lineage session is closed",
                );
            if (this.failure)
                throw new Error(
                    "session_failed: A prior persistence operation failed; close and explicitly resume the durable head",
                    { cause: this.failure },
                );
            return action();
        });
        this.queue = work.then(
            () => undefined,
            () => undefined,
        );
        return work;
    }

    private async commit(
        next: RootRecord,
        state: StoredRun,
        detach = false,
    ): Promise<void> {
        try {
            await this.lock.assertOwned();
            if (this.record.sequence > 0) {
                const current = await readSealed(
                    this.directory,
                    headPath(this.record.rootId),
                    rootSchema,
                    "lineage",
                );
                if (digest(current) !== digest(this.record))
                    throw new Error(
                        "stale_lineage: The authoritative head changed outside this session",
                    );
            }
            accrue(next, clockTime(this.options));
            if (detach) delete next.attachedAt;
            next.sequence = safeSum(this.record.sequence, 1);
            state.sequence = next.sequence;
            state.budget = structuredClone(next.budget);
            const safeState = validate(
                storedRunSchema,
                sanitize(state),
                "checkpoint",
            );
            const snapshotId = randomUUID();
            next.runs = {
                ...next.runs,
                [state.runId]: {
                    sequence: next.sequence,
                    snapshotId,
                    sha256: digest(safeState),
                },
            };
            next.headRunId = state.runId;
            validateRoot(next);
            await ensureDirectory(
                this.directory,
                path.join(runDirectory(state.runId), "checkpoints"),
            );
            await writeExclusive(
                this.directory,
                snapshotPath(state.runId, snapshotId),
                `${JSON.stringify(seal(safeState))}\n`,
            );
            await atomicWrite(
                this.directory,
                headPath(next.rootId),
                seal(validate(rootSchema, next, "lineage")),
            );
            this.record = next;
            this.stored = safeState;
        } catch (error) {
            this.failure = error;
            throw error;
        }
    }

    async initialize(next: RootRecord, state: StoredRun): Promise<void> {
        await this.commit(next, state);
    }

    snapshot(): BudgetSnapshot {
        const current = structuredClone(this.record);
        if (!this.closed) accrue(current, clockTime(this.options));
        return current.budget;
    }

    async reserve(): Promise<Reservation> {
        return this.serial(async () => {
            const next = structuredClone(this.record);
            const now = clockTime(this.options);
            accrue(next, now);
            let result: Reservation;
            if (
                next.budget.notBefore &&
                Date.parse(next.budget.notBefore) > Date.parse(now)
            ) {
                result = {
                    ok: false,
                    problem: {
                        kind: "provider-wait",
                        diagnostic: {
                            id: `provider-wait-${next.sequence + 1}`,
                            code: "provider_wait",
                            message:
                                "The durable provider deadline has not passed.",
                            retryable: true,
                            remediation:
                                "Resume no earlier than the persisted not-before time; no transport attempt was reserved.",
                            notBefore: next.budget.notBefore,
                        },
                    },
                };
            } else if (
                next.budget.attempts >= next.budget.limits.maxAttempts ||
                next.budget.elapsedMs >= next.budget.limits.maxElapsedMs
            ) {
                result = {
                    ok: false,
                    problem: {
                        kind: "exhausted",
                        diagnostic: {
                            id: `budget-exhausted-${next.sequence + 1}`,
                            code: "budget_exhausted",
                            message:
                                "The cumulative root execution allowance is exhausted.",
                            retryable: true,
                            remediation:
                                "An explicit additional allowance with a reason is required; refresh does not reset counters.",
                        },
                    },
                };
            } else {
                next.budget.attempts = safeSum(next.budget.attempts, 1);
                result = { ok: true, attempt: next.budget.attempts };
            }
            await this.commit(next, structuredClone(this.stored));
            if (
                result.ok &&
                this.snapshot().elapsedMs >=
                    this.record.budget.limits.maxElapsedMs
            ) {
                return {
                    ok: false,
                    problem: {
                        kind: "exhausted",
                        diagnostic: {
                            id: `budget-exhausted-${this.record.sequence}`,
                            code: "budget_exhausted",
                            message:
                                "The remaining elapsed allowance was consumed while durably reserving the attempt; no transport is permitted.",
                            retryable: true,
                            remediation:
                                "Explicitly grant additional elapsed allowance before resuming. The reservation remains consumed.",
                        },
                    },
                };
            }
            return result;
        });
    }

    async recordWait(ms: number): Promise<void> {
        validate(counterSchema, ms, "wait");
        return this.serial(async () => {
            const next = structuredClone(this.record);
            next.budget.waitMs = safeSum(next.budget.waitMs, ms);
            await this.commit(next, structuredClone(this.stored));
        });
    }

    async recordRetry(): Promise<void> {
        return this.serial(async () => {
            const next = structuredClone(this.record);
            if (next.budget.retries >= next.budget.attempts)
                throw new Error(
                    "invalid_retry: A retry must follow a reserved attempt",
                );
            next.budget.retries = safeSum(next.budget.retries, 1);
            await this.commit(next, structuredClone(this.stored));
        });
    }

    async deferUntil(iso: string): Promise<void> {
        validate(timestampSchema, iso, "deadline");
        return this.serial(async () => {
            const next = structuredClone(this.record);
            if (
                !next.budget.notBefore ||
                Date.parse(iso) > Date.parse(next.budget.notBefore)
            )
                next.budget.notBefore = iso;
            await this.commit(next, structuredClone(this.stored));
        });
    }

    async checkpoint(
        data: Parameters<RunSession["checkpoint"]>[0],
    ): Promise<void> {
        const checked = validate(checkpointSchema, data, "checkpoint_update");
        return this.serial(async () => {
            const state = structuredClone(this.stored);
            if (checked.cache !== undefined)
                state.cache = structuredClone(checked.cache);
            if (checked.evidence !== undefined)
                state.evidence = structuredClone(checked.evidence);
            if (checked.diagnostics !== undefined)
                state.diagnostics = structuredClone(checked.diagnostics);
            if (checked.work !== undefined)
                state.work = structuredClone(checked.work);
            if (checked.identity !== undefined) {
                const current = state.identity,
                    next = checked.identity;
                if (
                    next.profile !== current.profile ||
                    next.credentialClass !== current.credentialClass
                ) {
                    throw new Error(
                        "identity_binding_mismatch: Checkpoints cannot change the credential profile or class; start a new independent request",
                    );
                }
                if (digest(next.scope) !== digest(current.scope)) {
                    throw new Error(
                        "identity_binding_mismatch: Checkpoints cannot change the bound identity scope; start a new independent request",
                    );
                }
                if (
                    next.verified &&
                    (next.principal === null ||
                        next.principal.trim().length === 0)
                ) {
                    throw new Error(
                        "identity_binding_mismatch: A verified identity requires a nonempty principal",
                    );
                }
                if (
                    current.verified &&
                    (!next.verified || next.principal !== current.principal)
                ) {
                    throw new Error(
                        "identity_binding_mismatch: An already verified principal cannot be replaced or downgraded; start a new independent request",
                    );
                }
                state.identity = structuredClone(next);
            }
            await this.commit(structuredClone(this.record), state);
        });
    }

    async finish(
        status: Parameters<RunSession["finish"]>[0],
        generation?: string,
    ): Promise<void> {
        validate(statusSchema, status, "status");
        if (generation !== undefined)
            validate(safeIdSchema, generation, "generation");
        return this.serial(async () => {
            const state = structuredClone(this.stored);
            state.status = status;
            if (generation && !state.generations.includes(generation))
                state.generations.push(generation);
            await this.commit(structuredClone(this.record), state);
        });
    }

    async close(): Promise<void> {
        const work = this.queue.then(async () => {
            if (this.closed) return;
            let persistenceError = this.failure;
            try {
                if (!persistenceError)
                    await this.commit(
                        structuredClone(this.record),
                        structuredClone(this.stored),
                        true,
                    );
            } catch (error) {
                persistenceError = error;
            }
            this.closed = true;
            try {
                await this.lock.release();
            } catch (error) {
                if (persistenceError)
                    throw new AggregateError(
                        [persistenceError, error],
                        "close_failed: Persistence and lock release failed",
                    );
                throw error;
            }
            if (persistenceError)
                throw new Error(
                    "close_failed: Elapsed accounting could not be cleanly detached; the next resume will conservatively charge the unclosed interval",
                    { cause: persistenceError },
                );
        });
        this.queue = work.then(
            () => undefined,
            () => undefined,
        );
        return work;
    }
}

export async function openRun(options: OpenRunOptions): Promise<RunSession> {
    validateOptions(options);
    let directory: string;
    try {
        directory = await reportsRoot(
            options.root,
            options.reportsPath,
            options.mode === "new",
        );
    } catch (error) {
        if (options.mode !== "new" && isFsError(error, "ENOENT"))
            throw new Error(
                "missing_lineage: Report root or authoritative lineage is missing; no allowance was created",
            );
        throw error;
    }
    const now = clockTime(options);
    let previous: { record: RootRecord; state: StoredRun } | undefined;
    if (options.mode !== "new")
        previous = await loadRun(directory, options.runId!);
    const rootId = previous?.record.rootId ?? randomUUID();
    if (!previous) {
        await ensureDirectory(directory, path.join(".state", "roots", rootId));
        await ensureDirectory(directory, path.join(".state", "locks"));
    } else {
        await resolveSafePath(directory, path.join(".state", "locks"), {
            mustExist: true,
            directory: true,
        });
    }
    const lock = await acquireLock(
        directory,
        path.join(".state", "locks", rootId),
    );
    try {
        if (previous) {
            previous = await loadRun(directory, options.runId!);
            if (previous.record.headRunId !== options.runId) {
                throw new Error(
                    `stale_lineage: Run is no longer the root head; explicitly resume ${previous.record.headRunId}`,
                );
            }
            if (
                options.expectedSequence !== undefined &&
                options.expectedSequence !== previous.record.sequence
            ) {
                throw new Error(
                    `stale_lineage: Expected sequence ${options.expectedSequence}, current head is ${previous.record.sequence}`,
                );
            }
            compatible(previous.state, options);
        }
        const runId =
            options.mode === "resume"
                ? options.runId!
                : options.mode === "new"
                  ? rootId
                  : randomUUID();
        const budget: BudgetSnapshot = previous
            ? structuredClone(previous.record.budget)
            : {
                  attempts: 0,
                  elapsedMs: 0,
                  waitMs: 0,
                  retries: 0,
                  limits: structuredClone(options.config.budgets),
              };
        const initial: RootRecord = previous?.record ?? {
            schemaVersion: "1",
            rootId,
            headRunId: runId,
            sequence: 0,
            baseLimits: structuredClone(options.config.budgets),
            budget,
            grants: [],
            runs: {},
        };
        const next = structuredClone(initial);
        // An unclosed attachment is conservatively charged through recovery, including crash downtime.
        accrue(next, now);
        const state: StoredRun =
            options.mode === "resume"
                ? structuredClone(previous!.state)
                : {
                      schemaVersion: "1",
                      runId,
                      rootId,
                      ...(previous
                          ? { parentRunId: previous.state.runId }
                          : {}),
                      sequence: 1,
                      binding: structuredClone(options.binding),
                      config: structuredClone(options.config),
                      input: structuredClone(options.input),
                      inputs: structuredClone(options.inputs),
                      identity: structuredClone(options.identity),
                      startedAt: now,
                      budget,
                      cache: {},
                      evidence: [],
                      diagnostics: [],
                      work: [],
                      generations: [],
                  };
        if (options.allowance) {
            const allowance = validate(
                allowanceSchema,
                sanitize(options.allowance),
                "allowance",
            );
            const additionalAttempts = allowance.additionalAttempts ?? 0;
            const additionalElapsedMs = allowance.additionalElapsedMs ?? 0;
            next.budget.limits.maxAttempts = safeSum(
                next.budget.limits.maxAttempts,
                additionalAttempts,
            );
            next.budget.limits.maxElapsedMs = safeSum(
                next.budget.limits.maxElapsedMs,
                additionalElapsedMs,
            );
            next.grants.push({
                id: randomUUID(),
                runId,
                parentRunId: previous!.state.runId,
                at: now,
                additionalAttempts,
                additionalElapsedMs,
                reason: allowance.reason,
            });
        }
        if (lock.recovered.length)
            state.diagnostics.push({
                id: `lock-recovered-${randomUUID()}`,
                code: "dead_lock_recovered",
                message:
                    "Recovered a lock whose recorded local PID no longer exists; the unclosed elapsed interval was charged conservatively.",
                retryable: false,
                remediation: `Recovery receipt: ${lock.recovered.join(", ")}`,
            });
        if (options.mode !== "resume") {
            await ensureDirectory(directory, runDirectory(runId));
            await writeExclusive(
                directory,
                refPath(runId),
                `${JSON.stringify(seal({ schemaVersion: "1", runId, rootId }))}\n`,
            );
        }
        const session = new DurableSession(
            directory,
            options,
            lock,
            initial,
            state,
        );
        await session.initialize(next, state);
        return session;
    } catch (error) {
        try {
            await lock.release();
        } catch (releaseError) {
            throw new AggregateError(
                [error, releaseError],
                "open_failed: Run initialization and lock release failed",
            );
        }
        throw error;
    }
}
