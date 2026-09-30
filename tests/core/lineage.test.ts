import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { configSchema, type Identity } from "../../src/core/contracts.ts";
import { createClient } from "../../src/core/client.ts";
import { openRun, readRun } from "../../src/core/lineage.ts";
import { digest } from "../../src/core/redact.ts";
import { clientOptions, fakeContext, TestClock } from "../helpers.ts";
import {
    reopenOptions,
    runOptions,
    temporaryProject,
} from "./storage-fixtures.ts";

test("atomic reservations serialize, survive snapshots, and cannot be reset through mutable state", async (context) => {
    const root = await temporaryProject(context, "lineage-reserve");
    const options = runOptions(root, {
        config: configSchema.parse({
            org: "example-org",
            budgets: { maxAttempts: 3 },
        }),
    });
    const session = await openRun(options);
    const results = await Promise.all(
        Array.from({ length: 8 }, () => session.reserve()),
    );
    assert.deepEqual(
        results.filter((result) => result.ok).map((result) => result.attempt),
        [1, 2, 3],
    );
    assert.equal(results.filter((result) => !result.ok).length, 5);
    const detachedSnapshot = session.state;
    detachedSnapshot.budget.attempts = 0;
    detachedSnapshot.budget.limits.maxAttempts = 10000;
    assert.equal(session.snapshot().attempts, 3);
    assert.equal((await session.reserve()).ok, false);
    const runId = session.state.runId;
    await session.close();
    const stored = await readRun(root, "reports", runId);
    assert.equal(stored.budget.attempts, 3);
    const resumed = await openRun(reopenOptions(root, stored));
    assert.equal((await resumed.reserve()).ok, false);
    await resumed.close();
    if (process.platform !== "win32") {
        assert.equal(
            (await fs.stat(path.join(root, "reports", ".state"))).mode & 0o777,
            0o700,
        );
        assert.equal(
            (
                await fs.stat(
                    path.join(
                        root,
                        "reports",
                        ".state",
                        "roots",
                        runId,
                        "head.json",
                    ),
                )
            ).mode & 0o777,
            0o600,
        );
    }
});

test("elapsed is attached wall time, not summed request time or double-counted waits", async (context) => {
    const root = await temporaryProject(context, "lineage-elapsed");
    const clock = new TestClock();
    const session = await openRun(runOptions(root, { clock }));
    await session.reserve();
    await clock.sleep(100);
    await session.reserve();
    await clock.sleep(50);
    await session.recordWait(50);
    await session.recordRetry();
    assert.deepEqual(
        {
            elapsed: session.snapshot().elapsedMs,
            wait: session.snapshot().waitMs,
            retries: session.snapshot().retries,
        },
        { elapsed: 150, wait: 50, retries: 1 },
    );
    await clock.sleep(25);
    await session.checkpoint({
        work: [
            {
                id: "remaining",
                required: true,
                outcome: "waiting",
                reasonCode: "budget_wait",
                evidenceIds: [],
            },
        ],
    });
    assert.equal(session.state.budget.elapsedMs, 175);
    await clock.sleep(25);
    await session.finish("deferred", "g-1");
    await clock.sleep(20);
    await session.close();
    const stored = await readRun(root, "reports", session.state.runId);
    assert.equal(stored.budget.elapsedMs, 220);
    assert.equal(stored.work[0]?.outcome, "waiting");
    assert.deepEqual(stored.generations, ["g-1"]);
    await clock.sleep(10000);
    const resumed = await openRun(reopenOptions(root, stored, { clock }));
    assert.equal(resumed.snapshot().elapsedMs, 220);
    await resumed.close();
});

test("checkpointed GET/user identity survives reopen and cannot replace an already verified binding", async (context) => {
    const root = await temporaryProject(context, "lineage-verified-identity");
    const clock = new TestClock();
    const config = configSchema.parse({
        org: "example-org",
        credential: {
            name: "operator-assisted-local",
            credentialClass: "classic-pat",
        },
    });
    const declared: Identity = {
        profile: "operator-assisted-local",
        credentialClass: "classic-pat",
        principal: null,
        verified: false,
        scope: ["example-org"],
        scopeVerified: false,
        writeReach: "unknown",
        explanation: "Pending synthetic identity probe.",
    };
    const options = runOptions(root, { config, identity: declared, clock });
    const session = await openRun(options);
    const observations = fakeContext({}, config);
    const client = createClient(
        clientOptions({
            clock,
            budget: session,
            capabilities: ["identity.user"],
            addEvidence: (value) => observations.addEvidence(value),
            addDiagnostic: (value) => observations.addDiagnostic(value),
            checkpoint: async (cache) => {
                await session.checkpoint({
                    cache,
                    evidence: observations.evidence,
                    diagnostics: observations.diagnostics,
                });
            },
            transport: async (request) => {
                assert.equal(request.method, "GET");
                assert.equal(new URL(request.url).pathname, "/user");
                return {
                    status: 200,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        id: 42,
                        login: "verified-reader",
                        type: "User",
                    }),
                };
            },
        }),
    );
    const response = await client.collect("identity.user", {
        org: "example-org",
    });
    assert.equal(response.completeness, "complete");
    const payload = response.pages[0]?.data;
    assert.ok(
        payload && typeof payload === "object" && !Array.isArray(payload),
    );
    assert.ok(typeof payload.login === "string");
    const verified: Identity = {
        ...declared,
        principal: payload.login,
        verified: true,
        explanation: "Verified through an injected GET /user response.",
    };
    await assert.rejects(
        session.checkpoint({ identity: { ...declared, verified: true } }),
        /identity_binding_mismatch/,
    );
    const competing = await Promise.allSettled([
        session.checkpoint({ identity: verified }),
        session.checkpoint({
            identity: { ...verified, principal: "replacement-reader" },
        }),
    ]);
    assert.equal(competing[0]?.status, "fulfilled");
    assert.equal(competing[1]?.status, "rejected");
    const incompatible: Identity[] = [
        { ...verified, profile: "restricted-reader" },
        { ...verified, credentialClass: "fine-grained-pat" },
        { ...verified, principal: "another-reader" },
        { ...verified, verified: false },
        { ...verified, scope: ["another-org"] },
    ];
    for (const identity of incompatible)
        await assert.rejects(
            session.checkpoint({ identity }),
            /identity_binding_mismatch/,
        );
    assert.deepEqual(session.state.identity, verified);
    assert.deepEqual(session.state.binding, options.binding);
    assert.equal(session.snapshot().attempts, 1);
    const runId = session.state.runId;
    const observationTime = session.state.evidence[0]?.observedAt;
    assert.equal(observationTime, clock.now().toISOString());
    assert.deepEqual(
        (await readRun(root, "reports", runId)).identity,
        verified,
    );
    await session.close();
    const saved = await readRun(root, "reports", runId);
    const resumed = await openRun(
        reopenOptions(root, saved, { expectedSequence: saved.sequence, clock }),
    );
    assert.deepEqual(resumed.state.identity, verified);
    assert.equal(resumed.state.startedAt, saved.startedAt);
    assert.equal(resumed.state.evidence[0]?.observedAt, observationTime);
    assert.equal(resumed.snapshot().attempts, 1);
    await resumed.checkpoint({ identity: verified });
    await resumed.close();
    assert.deepEqual(
        (await readRun(root, "reports", runId)).identity,
        verified,
    );
    await assert.rejects(
        openRun(reopenOptions(root, saved, { identity: declared, clock })),
        /binding_mismatch/,
    );
});

test("exclusive root locks and expected sequence reject concurrent or stale resumes", async (context) => {
    const root = await temporaryProject(context, "lineage-locks");
    const session = await openRun(runOptions(root));
    const old = session.state;
    await assert.rejects(openRun(reopenOptions(root, old)), /lineage_locked/);
    await session.reserve();
    await session.close();
    await assert.rejects(
        openRun(reopenOptions(root, old, { expectedSequence: old.sequence })),
        /stale_lineage/,
    );
    const current = await readRun(root, "reports", old.runId);
    const attempts = await Promise.allSettled([
        openRun(
            reopenOptions(root, current, {
                expectedSequence: current.sequence,
            }),
        ),
        openRun(
            reopenOptions(root, current, {
                expectedSequence: current.sequence,
            }),
        ),
    ]);
    assert.equal(
        attempts.filter((result) => result.status === "fulfilled").length,
        1,
    );
    assert.equal(
        attempts.filter((result) => result.status === "rejected").length,
        1,
    );
    for (const result of attempts)
        if (result.status === "fulfilled") await result.value.close();
    const saved = await readRun(root, "reports", old.runId);
    const before = await fs.readFile(
        path.join(root, "reports", ".state", "roots", old.runId, "head.json"),
    );
    assert.equal(
        (await readRun(root, "reports", old.runId)).sequence,
        saved.sequence,
    );
    assert.deepEqual(
        await fs.readFile(
            path.join(
                root,
                "reports",
                ".state",
                "roots",
                old.runId,
                "head.json",
            ),
        ),
        before,
    );
});

test("refresh recollects under the same exhausted root and explicit grants retain receipts and parents", async (context) => {
    const root = await temporaryProject(context, "lineage-refresh");
    const clock = new TestClock();
    const session = await openRun(
        runOptions(root, {
            clock,
            config: configSchema.parse({
                org: "example-org",
                budgets: { maxAttempts: 1 },
            }),
        }),
    );
    await session.reserve();
    await session.checkpoint({
        cache: {
            saved: {
                operation: "repositories.list",
                pages: [],
                completeness: "complete",
                problems: [],
            },
        },
        evidence: [
            {
                id: "e-old",
                operation: "repositories.list",
                target: "example-org",
                observedAt: clock.now().toISOString(),
                source: "fixture",
                synthetic: true,
                data: [],
            },
        ],
        diagnostics: [
            {
                id: "d-old",
                code: "old",
                message: "Previous observation",
                retryable: false,
                remediation: "Refresh.",
            },
        ],
        work: [
            {
                id: "old",
                outcome: "valid",
                required: true,
                evidenceIds: ["e-old"],
            },
        ],
    });
    await session.close();
    const original = await readRun(root, "reports", session.state.runId);
    await clock.sleep(1000);
    const refreshed = await openRun(
        reopenOptions(root, original, { mode: "refresh", clock }),
    );
    assert.notEqual(refreshed.state.runId, original.runId);
    assert.equal(refreshed.state.rootId, original.rootId);
    assert.equal(refreshed.state.parentRunId, original.runId);
    assert.notEqual(refreshed.state.startedAt, original.startedAt);
    assert.deepEqual(
        [
            refreshed.state.cache,
            refreshed.state.evidence,
            refreshed.state.diagnostics,
            refreshed.state.work,
        ],
        [{}, [], [], []],
    );
    assert.equal((await refreshed.reserve()).ok, false);
    await refreshed.close();
    await assert.rejects(
        openRun(reopenOptions(root, original, { clock })),
        /stale_lineage/,
    );
    assert.equal(
        (await readRun(root, "reports", original.runId)).evidence[0]
            ?.observedAt,
        original.evidence[0]?.observedAt,
    );
    const current = await readRun(root, "reports", refreshed.state.runId);
    await assert.rejects(
        openRun(
            reopenOptions(root, current, {
                clock,
                allowance: { additionalAttempts: 1, reason: " " },
            }),
        ),
        /invalid_allowance/,
    );
    const granted = await openRun(
        reopenOptions(root, current, {
            clock,
            allowance: {
                additionalAttempts: 2,
                additionalElapsedMs: 500,
                reason: "Operator approved completion of the remaining scope.",
            },
        }),
    );
    assert.equal(granted.snapshot().attempts, 1);
    assert.equal(granted.snapshot().limits.maxAttempts, 3);
    assert.equal((await granted.reserve()).ok, true);
    await granted.close();
    const ledger = JSON.parse(
        await fs.readFile(
            path.join(
                root,
                "reports",
                ".state",
                "roots",
                original.rootId,
                "head.json",
            ),
            "utf8",
        ),
    );
    assert.equal(ledger.data.grants.length, 1);
    assert.equal(ledger.data.grants[0].parentRunId, current.runId);
    assert.equal(ledger.data.grants[0].additionalAttempts, 2);
});

test("provider deadline persists independently of mixed status and cannot be shortened on resume", async (context) => {
    const root = await temporaryProject(context, "lineage-deadline");
    const clock = new TestClock();
    const session = await openRun(
        runOptions(root, {
            clock,
            config: configSchema.parse({
                org: "example-org",
                budgets: { maxElapsedMs: 100 },
            }),
        }),
    );
    const deadline = new Date(clock.value + 60000).toISOString();
    await session.deferUntil(deadline);
    await session.deferUntil(new Date(clock.value + 1000).toISOString());
    await session.finish("partial");
    await session.close();
    const saved = await readRun(root, "reports", session.state.runId);
    assert.equal(saved.budget.notBefore, deadline);
    assert.equal(saved.status, "partial");
    const resumed = await openRun(reopenOptions(root, saved, { clock }));
    const reservation = await resumed.reserve();
    assert.equal(reservation.ok, false);
    if (!reservation.ok)
        assert.equal(reservation.problem.kind, "provider-wait");
    assert.equal(resumed.snapshot().attempts, 0);
    assert.equal(resumed.snapshot().waitMs, 0);
    assert.equal(resumed.snapshot().elapsedMs, 0);
    await resumed.close();
    await clock.sleep(60000);
    const after = await openRun(
        reopenOptions(root, await readRun(root, "reports", saved.runId), {
            clock,
        }),
    );
    assert.equal((await after.reserve()).ok, true);
    await after.close();
});

test("GraphQL body-only provider guidance survives durable close/resume without transport or oversized sleep", async (context) => {
    const root = await temporaryProject(context, "lineage-body-wait");
    const clock = new TestClock(),
        resetAt = new Date(clock.value + 60000).toISOString();
    const session = await openRun(
        runOptions(root, {
            clock,
            config: configSchema.parse({
                org: "example-org",
                budgets: { maxElapsedMs: 1000 },
            }),
        }),
    );
    let requests = 0;
    const client = createClient(
        clientOptions({
            budget: session,
            clock,
            capabilities: ["activity.issues"],
            transport: async () => {
                requests++;
                return {
                    status: 200,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        data: {
                            repository: null,
                            rateLimit: { remaining: 0, resetAt },
                        },
                        errors: [
                            {
                                type: "RATE_LIMITED",
                                message: "API rate limit exceeded",
                            },
                        ],
                    }),
                };
            },
        }),
    );
    const first = await client.collect("activity.issues", {
        org: "example-org",
        repo: "one",
    });
    assert.ok(
        first.problems.some((problem) => problem.kind === "provider-wait"),
    );
    await session.finish("deferred");
    await session.close();
    const stored = await readRun(root, "reports", session.state.runId);
    assert.equal(stored.budget.notBefore, resetAt);
    const resumed = await openRun(
        reopenOptions(root, stored, {
            clock,
            allowance: {
                additionalAttempts: 1,
                reason: "Finish the pending read after the provider deadline.",
            },
        }),
    );
    const nextClient = createClient(
        clientOptions({
            budget: resumed,
            clock,
            capabilities: ["activity.issues"],
            transport: async () => {
                assert.fail(
                    "The durable provider deadline must gate transport after resume",
                );
            },
        }),
    );
    const second = await nextClient.collect("activity.issues", {
        org: "example-org",
        repo: "one",
    });
    assert.ok(
        second.problems.some((problem) => problem.kind === "provider-wait"),
    );
    assert.equal(requests, 1);
    assert.equal(resumed.snapshot().attempts, 1);
    assert.equal(resumed.snapshot().waitMs, 0);
    assert.equal(resumed.snapshot().elapsedMs, 0);
    assert.equal(clock.now().toISOString(), stored.startedAt);
    await resumed.close();
});

test("elapsed exhaustion during reservation persistence never authorizes transport", async (context) => {
    const root = await temporaryProject(context, "lineage-reservation-time");
    const clock = new TestClock();
    const session = await openRun(
        runOptions(root, {
            clock,
            config: configSchema.parse({
                org: "example-org",
                budgets: { maxElapsedMs: 10 },
            }),
        }),
    );
    const rename = fs.rename;
    const delayed = mock.method(
        fs,
        "rename",
        async (...args: Parameters<typeof fs.rename>) => {
            const result = await rename(...args);
            if (String(args[1]).endsWith("/head.json")) clock.value += 10;
            return result;
        },
    );
    try {
        const reservation = await session.reserve();
        assert.equal(reservation.ok, false);
        if (!reservation.ok)
            assert.equal(reservation.problem.kind, "exhausted");
        assert.equal(session.snapshot().attempts, 1);
    } finally {
        delayed.mock.restore();
    }
    await session.close();
    assert.equal(
        (await readRun(root, "reports", session.state.runId)).budget.elapsedMs,
        10,
    );
});

test("failed checkpoint persistence is explicit and its orphan cannot replace the authoritative head", async (context) => {
    const root = await temporaryProject(context, "lineage-persistence-failure");
    const session = await openRun(runOptions(root));
    const saved = session.state;
    const rename = fs.rename;
    const fault = mock.method(
        fs,
        "rename",
        async (...args: Parameters<typeof fs.rename>) => {
            if (String(args[1]).endsWith("/head.json"))
                throw Object.assign(new Error("disk full before head commit"), {
                    code: "ENOSPC",
                });
            return rename(...args);
        },
    );
    try {
        await assert.rejects(session.reserve(), /disk full/);
    } finally {
        fault.mock.restore();
    }
    await assert.rejects(session.close(), /close_failed/);
    const current = await readRun(root, "reports", saved.runId);
    assert.equal(current.sequence, saved.sequence);
    assert.equal(current.budget.attempts, 0);
    const resumed = await openRun(reopenOptions(root, current));
    assert.equal((await resumed.reserve()).ok, true);
    await resumed.close();
});

test("resume validates every binding; refresh rejects principal and scope changes", async (context) => {
    const root = await temporaryProject(context, "lineage-binding");
    const session = await openRun(runOptions(root));
    await session.close();
    const saved = await readRun(root, "reports", session.state.runId);
    for (const changes of [
        { binding: { ...saved.binding, codeVersion: "next" } },
        { input: { changed: true } },
        { inputs: { source: "changed" } },
        { identity: { ...saved.identity, principal: "another" } },
        { config: { ...saved.config, retentionDays: 100 } },
    ])
        await assert.rejects(
            openRun(reopenOptions(root, saved, changes)),
            /binding_mismatch/,
        );
    await assert.rejects(
        openRun(
            reopenOptions(root, saved, {
                mode: "refresh",
                identity: { ...saved.identity, principal: "another" },
            }),
        ),
        /binding_mismatch/,
    );
    await assert.rejects(
        openRun(
            reopenOptions(root, saved, {
                mode: "refresh",
                config: {
                    ...saved.config,
                    selection: {
                        ...saved.config.selection,
                        repositories: ["example-org/another"],
                    },
                },
            }),
        ),
        /binding_mismatch/,
    );
    const config = { ...saved.config, retentionDays: 100 };
    const refreshed = await openRun(
        reopenOptions(root, saved, {
            mode: "refresh",
            config,
            input: { label: "fresh observation" },
            binding: {
                ...saved.binding,
                configHash: digest(config),
                inputHash: digest({ label: "fresh observation" }),
            },
        }),
    );
    assert.equal(refreshed.state.config.retentionDays, 100);
    await refreshed.close();
});

test("missing lineage and corrupt ledger/work snapshots never create fresh allowance", async (context) => {
    const root = await temporaryProject(context, "lineage-corruption");
    const first = await openRun(runOptions(root));
    await first.close();
    const saved = await readRun(root, "reports", first.state.runId);
    await assert.rejects(
        openRun(reopenOptions(root, saved, { runId: "missing" })),
        /missing_lineage/,
    );
    const headPath = path.join(
        root,
        "reports",
        ".state",
        "roots",
        saved.rootId,
        "head.json",
    );
    const originalHead = await fs.readFile(headPath, "utf8");
    const ledger = JSON.parse(originalHead);
    const checkpointPath = path.join(
        root,
        "reports",
        ".state",
        "runs",
        saved.runId,
        "checkpoints",
        `${ledger.data.runs[saved.runId].snapshotId}.json`,
    );
    const originalCheckpoint = await fs.readFile(checkpointPath, "utf8");
    const checkpoint = JSON.parse(originalCheckpoint);
    checkpoint.data.work = [
        { id: "bad", required: true, outcome: "invented", evidenceIds: [] },
    ];
    checkpoint.sha256 = digest(checkpoint.data);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));
    await assert.rejects(
        readRun(root, "reports", saved.runId),
        /invalid_checkpoint/,
    );
    await fs.writeFile(checkpointPath, originalCheckpoint);
    ledger.data.budget.attempts = 12;
    ledger.sha256 = digest(ledger.data);
    await fs.writeFile(headPath, JSON.stringify(ledger));
    await assert.rejects(
        openRun(reopenOptions(root, saved)),
        /corrupt_lineage/,
    );
    await fs.writeFile(headPath, originalHead);
    await fs.unlink(headPath);
    await assert.rejects(
        openRun(reopenOptions(root, saved)),
        /missing_lineage/,
    );
    await assert.rejects(fs.stat(headPath), /ENOENT/);
});

test("real process interruption after reservation consumes allowance and recovers only the dead owner", async (context) => {
    const root = await temporaryProject(context, "lineage-crash");
    const lineage = new URL("../../src/core/lineage.ts", import.meta.url).href;
    const fixtures = new URL("./storage-fixtures.ts", import.meta.url).href;
    const script = `
    import { openRun } from ${JSON.stringify(lineage)};
    import { runOptions } from ${JSON.stringify(fixtures)};
    const options = runOptions(process.argv[1]);
    options.config.budgets.maxAttempts = 1;
    const session = await openRun(options);
    await session.reserve();
    process.stdout.write(session.state.runId);
    process.exit(0);
  `;
    const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script, root],
        { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const runId = child.stdout;
    const saved = await readRun(root, "reports", runId);
    assert.equal(saved.budget.attempts, 1);
    const clock = new TestClock();
    await clock.sleep(200);
    const resumed = await openRun(reopenOptions(root, saved, { clock }));
    assert.equal(resumed.snapshot().attempts, 1);
    assert.equal(resumed.snapshot().elapsedMs, 200);
    assert.equal((await resumed.reserve()).ok, false);
    assert.ok(
        resumed.state.diagnostics.some(
            (item) => item.code === "dead_lock_recovered",
        ),
    );
    assert.ok(
        (await fs.readdir(path.join(root, "reports", ".state", "locks"))).some(
            (name) => name.includes(".recovered-"),
        ),
    );
    await resumed.close();
});
