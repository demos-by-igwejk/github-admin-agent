import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { SUMMARY_BYTES } from "../../src/core/contracts.ts";
import type { JsonObject, ViewOptions } from "../../src/core/contracts.ts";
import {
    buildView,
    publishResult,
    readResult,
} from "../../src/core/artifacts.ts";
import { digest, redact } from "../../src/core/redact.ts";
import { resultEnvelope, temporaryProject } from "./storage-fixtures.ts";

test("immutable generations commit exact files and verify every hash on every read", async (context) => {
    const root = await temporaryProject(context, "artifacts");
    const envelope = resultEnvelope();
    const first = await publishResult(root, "reports", envelope, {
        defaultRows: 10,
    });
    assert.deepEqual(
        await readResult(root, "reports", envelope.runId),
        envelope,
    );
    const manifest = JSON.parse(await fs.readFile(first.manifestPath, "utf8"));
    assert.equal(manifest.data.synthetic, true);
    assert.equal(manifest.data.configHash, envelope.configHash);
    assert.deepEqual(Object.keys(manifest.data.files).sort(), [
        "diagnostics.jsonl",
        "evidence/evidence.json",
        "exports/rows.csv",
        "exports/rows.json",
        "result.json",
        "summary.json",
        "summary.md",
    ]);
    assert.equal(manifest.sha256, digest(manifest.data));
    const summary = JSON.parse(
        await fs.readFile(path.join(first.directory, "summary.json"), "utf8"),
    );
    assert.equal(summary.shown, 10);
    assert.equal(summary.evidence, undefined);
    assert.equal(summary.diagnostics, undefined);
    assert.equal(summary.artifacts.diagnosticsCount, 1);
    assert.ok(
        (
            await fs.readFile(path.join(first.directory, "summary.md"), "utf8")
        ).includes(JSON.stringify(summary, null, 2)),
    );
    await assert.rejects(
        publishResult(root, "reports", envelope),
        /generation_exists/,
    );
    assert.equal(
        (await readResult(root, "reports", envelope.runId)).generation,
        "g-1",
    );
    const second = { ...envelope, generation: "g-2" };
    await publishResult(root, "reports", second);
    assert.equal(
        (await readResult(root, "reports", envelope.runId)).generation,
        "g-2",
    );
    assert.equal(
        (await readResult(root, "reports", envelope.runId, "g-1")).generation,
        "g-1",
    );
    for (const file of [
        "summary.json",
        "summary.md",
        "diagnostics.jsonl",
        "exports/rows.csv",
        "evidence/evidence.json",
    ]) {
        const target = path.join(first.directory, file);
        const original = await fs.readFile(target);
        await fs.appendFile(target, "\n");
        await assert.rejects(
            readResult(root, "reports", envelope.runId, "g-1"),
            /corrupt_artifact/,
        );
        await fs.writeFile(target, original);
    }
    await fs.writeFile(path.join(first.directory, "unexpected.json"), "{}");
    await assert.rejects(
        readResult(root, "reports", envelope.runId, "g-1"),
        /corrupt_manifest/,
    );
});

test("invalid IDs, hashes, directory symlinks, foreign pointers and status mismatches fail explicitly", async (context) => {
    const root = await temporaryProject(context, "artifact-integrity");
    const envelope = resultEnvelope();
    for (const value of [
        "../escape",
        "/absolute",
        ".",
        "_hidden",
        "a".repeat(129),
    ]) {
        await assert.rejects(
            publishResult(root, "reports", { ...envelope, generation: value }),
            /invalid_result/,
        );
        await assert.rejects(
            readResult(root, "reports", value),
            /invalid_run_id/,
        );
        await assert.rejects(
            readResult(root, "reports", envelope.runId, value),
            /invalid_generation/,
        );
    }
    await assert.rejects(
        publishResult(root, "reports", { ...envelope, exitCode: 2 }),
        /invalid_result/,
    );
    const published = await publishResult(root, "reports", envelope);
    const manifestPath = published.manifestPath;
    const original = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(original);
    manifest.data.files["../../input.json"] =
        manifest.data.files["result.json"];
    manifest.sha256 = digest(manifest.data);
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
        readResult(root, "reports", envelope.runId),
        /corrupt_manifest/,
    );
    await fs.writeFile(manifestPath, original);
    const file = path.join(published.directory, "exports", "rows.json");
    const data = await fs.readFile(file);
    await fs.unlink(file);
    await fs.symlink(path.join(published.directory, "result.json"), file);
    await assert.rejects(
        readResult(root, "reports", envelope.runId),
        /symlink/,
    );
    await fs.unlink(file);
    await fs.writeFile(file, data);
    const pointerPath = path.join(
        root,
        "reports",
        envelope.runId,
        "current.json",
    );
    const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
    pointer.data.runId = "another-run";
    pointer.sha256 = digest(pointer.data);
    await fs.writeFile(pointerPath, JSON.stringify(pointer));
    await assert.rejects(
        readResult(root, "reports", envelope.runId),
        /corrupt_pointer/,
    );
});

test("envelope validation preserves cumulative grants above initial configuration caps", async (context) => {
    const root = await temporaryProject(context, "artifact-granted-budget");
    const envelope = resultEnvelope();
    envelope.budget.attempts = 100001;
    envelope.budget.elapsedMs = 86400001;
    envelope.budget.limits.maxAttempts = 100002;
    envelope.budget.limits.maxElapsedMs = 86400002;
    await publishResult(root, "reports", envelope);
    assert.deepEqual(
        (await readResult(root, "reports", envelope.runId)).budget,
        envelope.budget,
    );
});

test("valid work needs retained evidence; unknown work and row references cannot be published", async (context) => {
    const root = await temporaryProject(context, "artifact-evidence-ledger");
    const envelope = resultEnvelope();
    for (const malformed of [
        {
            ...envelope,
            result: {
                ...envelope.result,
                work: [
                    {
                        id: "empty",
                        required: true,
                        outcome: "valid" as const,
                        evidenceIds: [],
                    },
                ],
            },
        },
        { ...envelope, evidence: [] },
        { ...envelope, evidence: [...envelope.evidence, ...envelope.evidence] },
        {
            ...envelope,
            result: {
                ...envelope.result,
                work: [...envelope.result.work, ...envelope.result.work],
            },
        },
        {
            ...envelope,
            result: {
                ...envelope.result,
                rows: [{ id: "missing", evidenceIds: ["unavailable"] }],
            },
        },
    ]) {
        await assert.rejects(
            publishResult(root, "reports", malformed),
            /invalid_result/,
        );
    }
    envelope.evidence[0]!.data = [];
    await publishResult(root, "reports", envelope);
    assert.deepEqual(
        (await readResult(root, "reports", envelope.runId)).evidence[0]?.data,
        [],
    );
});

test("run-directory ownership rejects collisions while later generations can improve observed coverage", async (context) => {
    const root = await temporaryProject(context, "run-directory-ownership");
    const envelope = resultEnvelope();
    await publishResult(root, "reports", envelope);
    await fs.mkdir(path.join(root, "reports", "foreign-run"));
    await fs.writeFile(
        path.join(root, "reports", "foreign-run", "current.json"),
        "unrelated input",
    );
    await assert.rejects(
        publishResult(root, "reports", { ...envelope, runId: "foreign-run" }),
        /output_collision/,
    );
    assert.equal(
        await fs.readFile(
            path.join(root, "reports", "foreign-run", "current.json"),
            "utf8",
        ),
        "unrelated input",
    );
    await assert.rejects(
        publishResult(root, "reports", {
            ...envelope,
            generation: "g-wrong",
            inputHash: "different",
        }),
        /output_collision/,
    );
    const later = {
        ...envelope,
        generation: "g-later",
        scope: { ...envelope.scope, coverage: { assessed: 100 } },
    };
    await publishResult(root, "reports", later);
    assert.equal(
        (await readResult(root, "reports", envelope.runId)).generation,
        "g-later",
    );
});

test("failure receipts can publish without advancing or rewriting the last-good current pointer", async (context) => {
    const root = await temporaryProject(context, "failure-receipt-pointer");
    const envelope = resultEnvelope();
    await publishResult(root, "reports", envelope);
    const currentPath = path.join(
        root,
        "reports",
        envelope.runId,
        "current.json",
    );
    const currentBytes = await fs.readFile(currentPath);
    const failure = {
        ...envelope,
        generation: "g-failure",
        status: "failed" as const,
        exitCode: 1,
        reasons: ["fatal_receipt"],
    };
    const rename = fs.rename;
    let pointerWrites = 0;
    const guard = mock.method(
        fs,
        "rename",
        async (...args: Parameters<typeof fs.rename>) => {
            if (String(args[1]) === currentPath) {
                pointerWrites++;
                throw new Error("Last-good pointer must not be rewritten");
            }
            return rename(...args);
        },
    );
    try {
        const receipt = await publishResult(root, "reports", failure, {
            advancePointer: false,
            defaultRows: 10,
        });
        assert.ok(receipt.directory.endsWith("/generations/g-failure"));
    } finally {
        guard.mock.restore();
    }
    assert.equal(pointerWrites, 0);
    assert.deepEqual(await fs.readFile(currentPath), currentBytes);
    assert.deepEqual(
        await readResult(root, "reports", envelope.runId),
        envelope,
    );
    assert.deepEqual(
        await readResult(root, "reports", envelope.runId, failure.generation),
        failure,
    );
    const recovery = { ...envelope, generation: "g-recovered" };
    await publishResult(root, "reports", recovery);
    assert.equal(
        (await readResult(root, "reports", envelope.runId)).generation,
        recovery.generation,
    );
    assert.deepEqual(
        await readResult(root, "reports", envelope.runId, envelope.generation),
        envelope,
    );
});

test("an initial failure receipt remains discoverable when no current pointer exists", async (context) => {
    const root = await temporaryProject(context, "initial-failure-pointer");
    const envelope = {
        ...resultEnvelope(),
        generation: "initial-failure",
        status: "failed" as const,
        exitCode: 1,
        reasons: ["initial_failure"],
    };
    await publishResult(root, "reports", envelope, { advancePointer: false });
    assert.deepEqual(
        await readResult(root, "reports", envelope.runId),
        envelope,
    );
    const currentPath = path.join(
        root,
        "reports",
        envelope.runId,
        "current.json",
    );
    const currentBytes = await fs.readFile(currentPath);
    const second = { ...envelope, generation: "second-failure" };
    await publishResult(root, "reports", second, { advancePointer: false });
    assert.deepEqual(await fs.readFile(currentPath), currentBytes);
    assert.deepEqual(
        await readResult(root, "reports", envelope.runId, second.generation),
        second,
    );
});

test("staging, manifest, validation, generation and pointer failures preserve the last good generation", async (context) => {
    const root = await temporaryProject(context, "publication-failures");
    const envelope = resultEnvelope();
    await publishResult(root, "reports", envelope);
    const boundaries = [
        "artifact-write",
        "manifest-write",
        "staging-validation",
        "generation-rename",
        "pointer-write",
    ] as const;
    for (const [index, boundary] of boundaries.entries()) {
        let injected = false;
        const open = fs.open,
            rename = fs.rename;
        const fail = () => {
            injected = true;
            const error = new Error(`injected_${boundary}`);
            Object.assign(error, { code: "ENOSPC" });
            throw error;
        };
        const openMock = mock.method(
            fs,
            "open",
            async (...args: Parameters<typeof fs.open>) => {
                const name = String(args[0]),
                    flags = args[1];
                if (!injected && name.includes(".staging-")) {
                    if (
                        boundary === "artifact-write" &&
                        name.endsWith("/evidence/evidence.json") &&
                        flags !== (constants.O_RDONLY | constants.O_NOFOLLOW)
                    )
                        fail();
                    if (
                        boundary === "manifest-write" &&
                        name.endsWith("/manifest.json") &&
                        flags !== (constants.O_RDONLY | constants.O_NOFOLLOW)
                    )
                        fail();
                    if (
                        boundary === "staging-validation" &&
                        name.endsWith("/summary.json") &&
                        flags === (constants.O_RDONLY | constants.O_NOFOLLOW)
                    )
                        fail();
                }
                return open(...args);
            },
        );
        const renameMock = mock.method(
            fs,
            "rename",
            async (...args: Parameters<typeof fs.rename>) => {
                if (
                    !injected &&
                    boundary === "generation-rename" &&
                    String(args[0]).includes(".staging-")
                )
                    fail();
                if (
                    !injected &&
                    boundary === "pointer-write" &&
                    String(args[0]).includes(".current.json-")
                )
                    fail();
                return rename(...args);
            },
        );
        const generation = `failed-${index}`;
        try {
            await assert.rejects(
                publishResult(root, "reports", { ...envelope, generation }),
                new RegExp(`injected_${boundary}`),
            );
        } finally {
            openMock.mock.restore();
            renameMock.mock.restore();
        }
        assert.equal(injected, true, boundary);
        assert.equal(
            (await readResult(root, "reports", envelope.runId)).generation,
            "g-1",
        );
        if (boundary === "pointer-write")
            assert.equal(
                (await readResult(root, "reports", envelope.runId, generation))
                    .generation,
                generation,
            );
    }
    const receipts = await fs.readdir(
        path.join(root, "reports", envelope.runId, "failures"),
    );
    assert.equal(receipts.length, boundaries.length);
    const successful = await publishResult(root, "reports", {
        ...envelope,
        generation: "recovered",
    });
    assert.equal(
        (await readResult(root, "reports", envelope.runId)).generation,
        "recovered",
    );
    assert.ok(successful.directory.endsWith("/generations/recovered"));
});

test("a disk-full failure that also prevents its receipt is surfaced, never success-shaped", async (context) => {
    const root = await temporaryProject(context, "publication-disk-full");
    const envelope = resultEnvelope();
    await publishResult(root, "reports", envelope);
    const open = fs.open;
    const fault = mock.method(
        fs,
        "open",
        async (...args: Parameters<typeof fs.open>) => {
            const name = String(args[0]);
            if (
                (name.includes(".staging-") && name.endsWith("/result.json")) ||
                name.includes("/failures/")
            ) {
                throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
            }
            return open(...args);
        },
    );
    try {
        await assert.rejects(
            publishResult(root, "reports", {
                ...envelope,
                generation: "disk-full",
            }),
            /failure-receipt/,
        );
    } finally {
        fault.mock.restore();
    }
    assert.equal(
        (await readResult(root, "reports", envelope.runId)).generation,
        "g-1",
    );
});

test("failure after an atomic pointer rename leaves a coherent old or new generation, never mixed files", async (context) => {
    const root = await temporaryProject(context, "publication-after-pointer");
    const envelope = resultEnvelope();
    await publishResult(root, "reports", envelope);
    const rename = fs.rename;
    const fault = mock.method(
        fs,
        "rename",
        async (...args: Parameters<typeof fs.rename>) => {
            await rename(...args);
            if (String(args[0]).includes(".current.json-"))
                throw new Error("interrupted after pointer rename");
        },
    );
    try {
        await assert.rejects(
            publishResult(root, "reports", {
                ...envelope,
                generation: "g-new",
            }),
            /interrupted after pointer/,
        );
    } finally {
        fault.mock.restore();
    }
    assert.equal(
        (await readResult(root, "reports", envelope.runId)).generation,
        "g-new",
    );
    assert.deepEqual(
        await readResult(root, "reports", envelope.runId, "g-1"),
        envelope,
    );
});

test("selection precedes paging, sorts deterministically and never relabels all-source totals", () => {
    const envelope = resultEnvelope(60);
    const selected = buildView(
        envelope,
        { repository: "example-org/repo-0058" },
        10,
    );
    assert.equal(selected.selection, "shown 1 of 1 requested");
    assert.equal(selected.rows[0]?.repository, "example-org/repo-0058");
    assert.equal(selected.allSourceTotals.rows, 60);
    assert.equal(
        buildView(envelope, { repository: "EXAMPLE-ORG/repo-0058" }).shown,
        0,
    );
    assert.equal(buildView(envelope, { reason: "observe" }).shown, 0);
    assert.equal(buildView(envelope, { sku: "Linux" }).shown, 0);
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
        const page = buildView(envelope, {
            sku: "linux",
            reason: "observed",
            limit: 7,
            ...(cursor ? { cursor } : {}),
        });
        assert.equal(page.totalMatches, 30);
        assert.equal(page.filters.sku, "linux");
        collected.push(...page.rows.map((row) => row.id));
        cursor = page.continuation;
    } while (cursor);
    assert.equal(collected.length, 30);
    assert.equal(new Set(collected).size, 30);
    assert.deepEqual(collected, [...collected].sort());
    const reordered = {
        ...envelope,
        result: {
            ...envelope.result,
            rows: [...envelope.result.rows].reverse(),
        },
    };
    assert.deepEqual(buildView(envelope).rows, buildView(reordered).rows);
});

test("default summaries prioritize configured repositories outside the first global ten rows", async (context) => {
    const root = await temporaryProject(context, "configured-repository-view");
    const envelope = resultEnvelope(80);
    envelope.scope.selection = {
        repositories: ["EXAMPLE-ORG/REPO-0079", "example-org/repo-0078"],
        properties: {},
    };
    const original = digest(envelope);
    const view = buildView(envelope, {}, 10);
    assert.deepEqual(
        view.rows.slice(0, 3).map((row) => row.id),
        ["row-0078", "row-0079", "row-0000"],
    );
    assert.equal(view.shown, 10);
    assert.equal(view.totalMatches, 80);
    assert.equal(view.allSourceTotals.rows, 80);
    assert.match(view.selection, /2 of 2 configured-scope matches/);
    assert.equal(digest(envelope), original);
    const filtered = buildView(
        envelope,
        { sku: "windows", reason: "observed" },
        10,
    );
    assert.equal(filtered.rows[0]?.id, "row-0079");
    assert.ok(
        filtered.rows.every(
            (row) => row.sku === "windows" && row.reason === "observed",
        ),
    );
    const outside = buildView(
        envelope,
        { repository: "example-org/repo-0000" },
        10,
    );
    assert.equal(outside.rows[0]?.id, "row-0000");
    assert.equal(outside.totalMatches, 1);
    assert.equal(
        buildView(envelope, { repository: "EXAMPLE-ORG/REPO-0079" })
            .totalMatches,
        0,
    );
    const published = await publishResult(root, "reports", envelope, {
        defaultRows: 10,
    });
    const storedSummary = JSON.parse(
        await fs.readFile(
            path.join(published.directory, "summary.json"),
            "utf8",
        ),
    );
    assert.deepEqual(
        storedSummary.rows.slice(0, 2).map((row: { id: string }) => row.id),
        ["row-0078", "row-0079"],
    );
    assert.equal(
        (await readResult(root, "reports", envelope.runId, envelope.generation))
            .evidence[0]?.observedAt,
        envelope.evidence[0]?.observedAt,
    );
});

test("property-selected included rows are prioritized only when property selection is configured", () => {
    const envelope = resultEnvelope(60);
    for (const row of envelope.result.rows)
        row.bucket = ["row-0056", "row-0058"].includes(row.id)
            ? "included"
            : "excluded";
    envelope.scope.selection = {
        repositories: [],
        properties: { team: "platform" },
    };
    const selected = buildView(envelope, {}, 10);
    assert.deepEqual(
        selected.rows.slice(0, 3).map((row) => row.id),
        ["row-0056", "row-0058", "row-0000"],
    );
    assert.match(selected.selection, /2 of 2 configured-scope matches/);
    assert.equal(selected.allSourceTotals.rows, 60);
    envelope.scope.selection = { repositories: [], properties: {} };
    assert.equal(buildView(envelope, {}, 10).rows[0]?.id, "row-0000");
});

test("configured-scope paging retains every row and rejects cursors from a changed selection", () => {
    const envelope = resultEnvelope(80);
    const repositories = Array.from(
        { length: 20 },
        (_, index) => `example-org/repo-${String(index + 40).padStart(4, "0")}`,
    );
    envelope.scope.selection = { repositories, properties: {} };
    const first = buildView(envelope, { limit: 7 });
    assert.deepEqual(
        first.rows.map((row) => row.id),
        Array.from({ length: 7 }, (_, index) => `row-00${index + 40}`),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
        const page = buildView(envelope, {
            limit: 7,
            ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.rows.map((row) => row.id));
        cursor = page.continuation;
    } while (cursor);
    assert.equal(seen.length, 80);
    assert.equal(new Set(seen).size, 80);
    assert.deepEqual(
        seen.slice(0, 20),
        repositories.map((repository) => `row-${repository.slice(-4)}`),
    );
    assert.deepEqual(
        seen.slice(20),
        envelope.result.rows
            .filter((row) => !repositories.includes(row.repository ?? ""))
            .map((row) => row.id)
            .sort(),
    );
    const changedSelections: JsonObject[] = [
        { repositories: repositories.slice(1), properties: {} },
        { repositories, properties: { team: "different" } },
    ];
    for (const selection of changedSelections) {
        assert.throws(
            () =>
                buildView(
                    { ...envelope, scope: { ...envelope.scope, selection } },
                    { limit: 7, cursor: first.continuation },
                ),
            /stale_cursor/,
        );
    }
});

test("new view ordering does not rewrite or invalidate coherently committed historical summaries", async (context) => {
    const root = await temporaryProject(context, "historical-summary");
    const envelope = resultEnvelope(30);
    envelope.scope.selection = {
        repositories: ["example-org/repo-0029"],
        properties: {},
    };
    const historical = buildView(
        { ...envelope, scope: { org: "example-org" } },
        {},
        10,
    );
    historical.scope = envelope.scope;
    const publication = await publishResult(root, "reports", envelope, {
        defaultRows: 10,
    });
    const manifest = JSON.parse(
        await fs.readFile(publication.manifestPath, "utf8"),
    );
    const summaryText = `${JSON.stringify(historical, null, 2)}\n`;
    for (const [name, contents] of [
        ["summary.json", summaryText],
        [
            "summary.md",
            `# Historical summary\n\n\`\`\`json\n${summaryText}\`\`\`\n`,
        ],
    ] as const) {
        await fs.writeFile(path.join(publication.directory, name), contents);
        manifest.data.files[name] = {
            bytes: Buffer.byteLength(contents),
            sha256: createHash("sha256").update(contents).digest("hex"),
        };
    }
    manifest.sha256 = digest(manifest.data);
    const manifestText = JSON.stringify(manifest);
    await fs.writeFile(publication.manifestPath, manifestText);
    const pointerPath = path.join(
        root,
        "reports",
        envelope.runId,
        "current.json",
    );
    const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
    pointer.data.manifestHash = createHash("sha256")
        .update(manifestText)
        .digest("hex");
    pointer.sha256 = digest(pointer.data);
    await fs.writeFile(pointerPath, JSON.stringify(pointer));
    const saved = await readResult(root, "reports", envelope.runId);
    assert.equal(saved.startedAt, envelope.startedAt);
    assert.equal(
        saved.evidence[0]?.observedAt,
        envelope.evidence[0]?.observedAt,
    );
    assert.equal(buildView(saved, {}, 10).rows[0]?.id, "row-0029");
    assert.equal(
        JSON.parse(
            await fs.readFile(
                path.join(publication.directory, "summary.json"),
                "utf8",
            ),
        ).rows[0].id,
        "row-0000",
    );
});

test("opaque cursors are bound to exact filters, limit, view, run, generation and data", () => {
    const envelope = resultEnvelope(70);
    const first = buildView(envelope, {
        sku: "linux",
        limit: 10,
        view: "rows",
    });
    assert.ok(first.continuation);
    const options: ViewOptions = {
        sku: "linux",
        limit: 10,
        view: "rows",
        cursor: first.continuation,
    };
    for (const changed of [
        { sku: "windows" },
        { limit: 11 },
        { view: "summary" as const },
        { repository: "example-org/repo-0058" },
    ]) {
        assert.throws(
            () => buildView(envelope, { ...options, ...changed }),
            /stale_cursor/,
        );
    }
    assert.throws(
        () => buildView({ ...envelope, runId: "another" }, options),
        /stale_cursor/,
    );
    assert.throws(
        () => buildView({ ...envelope, generation: "new-generation" }, options),
        /stale_cursor/,
    );
    assert.throws(
        () =>
            buildView(
                {
                    ...envelope,
                    result: {
                        ...envelope.result,
                        rows: envelope.result.rows.slice(1),
                    },
                },
                options,
            ),
        /stale_cursor/,
    );
    assert.throws(
        () =>
            buildView(envelope, {
                ...options,
                cursor: `${first.continuation}!`,
            }),
        /invalid_cursor/,
    );
    const decoded = JSON.parse(
        Buffer.from(first.continuation, "base64url").toString("utf8"),
    );
    decoded.offset += 1;
    assert.throws(
        () =>
            buildView(envelope, {
                ...options,
                cursor: Buffer.from(JSON.stringify(decoded)).toString(
                    "base64url",
                ),
            }),
        /invalid_cursor/,
    );
    for (const limit of [0, -1, 1001, 0.5])
        assert.throws(
            () => buildView(envelope, { limit }),
            /invalid_view_options/,
        );
    assert.throws(() => buildView(envelope, {}, 0), /invalid_default_rows/);
});

test("long rows and huge metadata stay under 64 KiB in UTF-8 without losing filtered rows", () => {
    const envelope = resultEnvelope(50);
    const long = "\u{1F600}".repeat(30000);
    for (const row of envelope.result.rows) row.description = long;
    envelope.scope = {
        org: "example-org",
        selection: {
            repositories: Array.from({ length: 10000 }, (_, index) =>
                index < 50
                    ? `example-org/repo-${String(index).padStart(4, "0")}`
                    : `example-org/repository-${index}-${"x".repeat(80)}`,
            ),
            properties: {},
        },
    };
    const totals: JsonObject = {};
    for (let index = 0; index < 100000; index++)
        totals[`group-${index}`] = {
            amount: "-0.123456789",
            quantity: "10.999",
        };
    envelope.result.totals = { groups: totals, amount: "-0.125" };
    envelope.reasons = Array.from(
        { length: 10000 },
        (_, index) => `unassessed-${index}`,
    );
    envelope.result.coverage.unassessed = Array.from(
        { length: 10000 },
        (_, index) => `example-org/unassessed-${index}`,
    );
    envelope.result.limitations = Array.from(
        { length: 10000 },
        (_, index) => `${index}: ${long.slice(0, 400)}`,
    );
    envelope.nextActions = Array.from(
        { length: 10000 },
        (_, index) => `Inspect action ${index} in the detailed result.`,
    );
    envelope.diagnostics = Array.from({ length: 10000 }, (_, index) => ({
        id: `d-${index}`,
        code: "unassessed",
        message: long.slice(0, 200),
        retryable: false,
        remediation: "Inspect the complete diagnostic artifact.",
    }));
    const view = buildView(envelope, { reason: "observed" }, 50);
    assert.equal(view.shown, 50);
    assert.equal(view.totalMatches, 50);
    assert.match(
        view.selection,
        /^shown 50 of 50 requested; 50 of 50 configured-scope matches/,
    );
    assert.equal(view.continuation, undefined);
    assert.ok(
        Buffer.byteLength(JSON.stringify(view, null, 2), "utf8") <=
            SUMMARY_BYTES,
    );
    assert.equal(view.artifacts.diagnosticsCount, 10000);
    assert.ok(view.abbreviations.length >= 2);
    assert.ok(
        JSON.stringify(view.allSourceTotals).includes(
            "result.json#/result/totals",
        ),
    );
    assert.equal(envelope.result.rows[0]?.description, long);
    assert.equal(envelope.result.totals.groups, totals);
});

test("byte-limited continuation still enumerates all matches and numeric strings are not silently shortened", () => {
    const envelope = resultEnvelope(700);
    for (const row of envelope.result.rows) {
        row.description = "large".repeat(400);
        row.amount = "9".repeat(70000);
    }
    const seen = new Set<string>();
    let cursor: string | undefined,
        pages = 0;
    do {
        const view = buildView(envelope, {
            limit: 1000,
            ...(cursor ? { cursor } : {}),
        });
        assert.ok(
            Buffer.byteLength(JSON.stringify(view, null, 2), "utf8") <=
                SUMMARY_BYTES,
        );
        assert.ok(view.shown > 0);
        assert.ok(view.abbreviations.length > 0);
        for (const row of view.rows) {
            assert.ok(!seen.has(row.id));
            seen.add(row.id);
            if (typeof row.amount === "string")
                assert.equal(row.amount, "9".repeat(70000));
            else
                assert.ok(
                    row.$viewDetail ||
                        (row.amount && typeof row.amount === "object"),
                );
        }
        cursor = view.continuation;
        pages++;
        assert.ok(pages < 20);
    } while (cursor);
    assert.equal(seen.size, 700);
});

test("redaction precedes every hash/export and CSV formulas do not corrupt exact signed quantities", async (context) => {
    const root = await temporaryProject(context, "artifact-redaction");
    const envelope = resultEnvelope(2);
    const secret = `ghp_${"a".repeat(30)}`;
    envelope.evidence[0]!.data = {
        token: secret,
        message: `Error while using ${secret}`,
        authorization: "private",
    };
    envelope.diagnostics[0]!.message = `Bearer ${"b".repeat(20)} ${secret}`;
    envelope.result.rows[0] = {
        id: "formula",
        repository: '=HYPERLINK("x")',
        sku: "\t=1+1",
        reason: "+cmd",
        evidenceIds: ["e1"],
        amount: "-0.125000",
        quantity: "-20.50",
        pricePerUnit: "-0.000000125",
        currency: null,
        label: "-2",
        description: secret,
    };
    envelope.result.rows[1] = {
        id: "numeric",
        evidenceIds: ["e1"],
        amount: "-1+2",
        quantity: "12.001",
        pricePerUnit: null,
        nested: { token: secret },
    };
    const publication = await publishResult(root, "reports", envelope);
    const read = await readResult(root, "reports", envelope.runId);
    assert.equal(read.result.rows[0]?.amount, "-0.125000");
    assert.equal(read.result.rows[0]?.quantity, "-20.50");
    assert.equal(read.result.rows[0]?.pricePerUnit, "-0.000000125");
    assert.equal(read.result.rows[0]?.currency, null);
    assert.equal(read.result.rows[1]?.pricePerUnit, null);
    const exported = await fs.readFile(
        path.join(publication.directory, "exports", "rows.csv"),
        "utf8",
    );
    assert.ok(exported.includes(',"\'-2",'));
    assert.ok(exported.includes("-0.125000"));
    assert.ok(exported.includes("-20.50"));
    assert.ok(!exported.includes("'-0.125000"));
    assert.ok(exported.includes("-0.000000125"));
    assert.ok(!exported.includes("'-0.000000125"));
    assert.ok(exported.includes('"\'-1+2"'));
    assert.ok(exported.includes("\"'=HYPERLINK"));
    for (const name of [
        "result.json",
        "summary.json",
        "summary.md",
        "evidence/evidence.json",
        "diagnostics.jsonl",
        "exports/rows.json",
        "exports/rows.csv",
        "manifest.json",
    ]) {
        const value = await fs.readFile(
            path.join(publication.directory, name),
            "utf8",
        );
        assert.ok(!value.includes(secret), name);
        assert.ok(!value.includes(`Bearer ${"b".repeat(20)}`), name);
    }
    assert.deepEqual(
        read.evidence[0]!.data,
        redact(envelope.evidence[0]!.data),
    );
    assert.equal(read.assurance.population, "unverified");
    assert.equal(read.assurance.finality, "unknown");
});
