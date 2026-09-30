import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
    jsonObjectSchema,
    scenarioRowSchema,
    SUMMARY_BYTES,
} from "./contracts.ts";
import type {
    JsonValue,
    ResultEnvelope,
    ResultView,
    ScenarioRow,
    ViewOptions,
} from "./contracts.ts";
import { csvText, digest, redactText } from "./redact.ts";
import {
    isFsError,
    parseJsonBytes,
    readSafeFile,
    resolveSafePath,
} from "./paths.ts";
import { createView, numericFields, numericLexeme } from "./result-view.ts";
import {
    counterSchema,
    envelopeSchema,
    hashSchema,
    safeIdSchema,
    sanitize,
    statusSchema,
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
    syncDirectory,
    unseal,
    writeExclusive,
} from "./storage.ts";

const committedFiles = [
    "result.json",
    "summary.json",
    "summary.md",
    "evidence/evidence.json",
    "diagnostics.jsonl",
    "exports/rows.json",
    "exports/rows.csv",
] as const;
const fileSchema = z.strictObject({ sha256: hashSchema, bytes: counterSchema });
const manifestSchema = z.strictObject({
    schemaVersion: z.literal("1"),
    formatVersion: z.literal("1"),
    publication: z.literal("committed"),
    runId: safeIdSchema,
    rootId: safeIdSchema,
    parentRunId: safeIdSchema.optional(),
    generation: safeIdSchema,
    scenario: z.string().min(1).max(200),
    scenarioVersion: z.string().min(1).max(100),
    codeVersion: z.string().min(1).max(100),
    configHash: z.string().min(1).max(200),
    inputHash: z.string().min(1).max(200),
    scopeHash: hashSchema,
    identityHash: hashSchema,
    host: z.string().min(1).max(253),
    synthetic: z.boolean(),
    startedAt: timestampSchema,
    completedAt: timestampSchema,
    publishedAt: timestampSchema,
    defaultRows: z.number().int().min(1).max(1000),
    files: z.record(z.string(), fileSchema),
});
type Manifest = z.infer<typeof manifestSchema>;
const pointerSchema = z.strictObject({
    schemaVersion: z.literal("1"),
    runId: safeIdSchema,
    generation: safeIdSchema,
    manifestHash: hashSchema,
});
const runMarkerSchema = z.strictObject({
    schemaVersion: z.literal("1"),
    runId: safeIdSchema,
    rootId: safeIdSchema,
    bindingHash: hashSchema,
});
const publicationOptionsSchema = z.strictObject({
    defaultRows: z.number().int().min(1).max(1000).optional(),
    advancePointer: z.boolean().optional(),
});
const summarySchema = z.strictObject({
    schemaVersion: z.literal("1"),
    runId: safeIdSchema,
    generation: safeIdSchema,
    scenario: z.string().min(1).max(200),
    status: statusSchema,
    synthetic: z.boolean(),
    scope: jsonObjectSchema,
    time: z.strictObject({
        startedAt: timestampSchema,
        completedAt: timestampSchema,
    }),
    assurance: jsonObjectSchema,
    filters: jsonObjectSchema,
    shown: counterSchema,
    totalMatches: counterSchema,
    selection: z.string(),
    rows: z.array(scenarioRowSchema),
    allSourceTotals: jsonObjectSchema,
    reasons: z.array(z.string()),
    limitations: z.array(z.string()),
    nextActions: z.array(z.string()),
    artifacts: jsonObjectSchema,
    continuation: z.string().max(4096).optional(),
    abbreviations: z.array(z.string()),
});
const bytesHash = (bytes: string | Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function runMarker(envelope: ResultEnvelope): z.infer<typeof runMarkerSchema> {
    return {
        schemaVersion: "1",
        runId: envelope.runId,
        rootId: envelope.rootId,
        bindingHash: digest({
            parentRunId: envelope.parentRunId,
            scenario: envelope.scenario,
            scenarioVersion: envelope.scenarioVersion,
            schemaVersion: envelope.schemaVersion,
            codeVersion: envelope.codeVersion,
            host: envelope.host,
            configHash: envelope.configHash,
            inputHash: envelope.inputHash,
            synthetic: envelope.synthetic,
            startedAt: envelope.startedAt,
        }),
    };
}

async function prepareRunDirectory(
    directory: string,
    envelope: ResultEnvelope,
): Promise<void> {
    const runDirectory = await ensureDirectory(directory, envelope.runId);
    const markerPath = path.join(envelope.runId, ".run.json"),
        marker = runMarker(envelope);
    let existing: z.infer<typeof runMarkerSchema> | undefined;
    try {
        existing = await readSealed(
            directory,
            markerPath,
            runMarkerSchema,
            "artifact_run",
        );
    } catch (error) {
        if (!isFsError(error, "ENOENT")) throw error;
    }
    if (!existing) {
        if ((await fs.readdir(runDirectory)).length)
            throw new Error(
                "output_collision: Refusing to reuse an unmanaged run directory",
            );
        try {
            await writeExclusive(directory, markerPath, json(seal(marker)));
        } catch (error) {
            if (!isFsError(error, "EEXIST")) throw error;
        }
        existing = await readSealed(
            directory,
            markerPath,
            runMarkerSchema,
            "artifact_run",
        );
    }
    if (digest(existing) !== digest(marker))
        throw new Error(
            "output_collision: This run directory belongs to a different observation binding; use a new run",
        );
}

export function buildView(
    envelope: ResultEnvelope,
    options?: ViewOptions,
    defaultRows?: number,
): ResultView {
    return createView(envelope, options, defaultRows);
}

function csv(rows: ScenarioRow[]): string {
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
    const cell = (key: string, value: JsonValue | undefined): string => {
        if (value === undefined || value === null) return '""';
        if (typeof value === "number") return String(value);
        if (typeof value === "boolean") return String(value);
        const text = typeof value === "string" ? value : JSON.stringify(value);
        if (numericFields.has(key.toLowerCase()) && numericLexeme.test(text))
            return text;
        return csvText(text);
    };
    return `${keys.map(csvText).join(",")}\r\n${rows.map((row) => keys.map((key) => cell(key, row[key])).join(",")).join("\r\n")}${rows.length ? "\r\n" : ""}`;
}

async function listFiles(
    root: string,
    relative: string,
    prefix = "",
): Promise<string[]> {
    const directory = await resolveSafePath(root, relative, {
        mustExist: true,
        directory: true,
    });
    const files: string[] = [];
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory()))
            throw new Error(
                "unsafe_artifact: Generation contains a symlink or special object",
            );
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
            if (prefix || !["exports", "evidence"].includes(item.name))
                throw new Error(
                    "corrupt_manifest: Generation contains an uncommitted directory",
                );
            files.push(
                ...(await listFiles(
                    root,
                    path.join(relative, item.name),
                    name,
                )),
            );
        } else files.push(name);
    }
    return files.sort();
}

async function verifyGeneration(
    root: string,
    relative: string,
    runId: string,
    generation: string,
): Promise<{ envelope: ResultEnvelope; manifestHash: string }> {
    const manifestBytes = await readSafeFile(
        root,
        path.join(relative, "manifest.json"),
    );
    const manifest = unseal(
        parseJsonBytes(manifestBytes),
        manifestSchema,
        "manifest",
    );
    if (manifest.runId !== runId || manifest.generation !== generation)
        throw new Error(
            "corrupt_manifest: Generation identity does not match its directory",
        );
    if (
        digest(Object.keys(manifest.files).sort()) !==
        digest([...committedFiles].sort())
    ) {
        throw new Error(
            "corrupt_manifest: Manifest must commit exactly the prescribed artifact files",
        );
    }
    if (
        digest(await listFiles(root, relative)) !==
        digest([...committedFiles, "manifest.json"].sort())
    ) {
        throw new Error(
            "corrupt_manifest: Directory contents differ from the committed file list",
        );
    }
    const verified = new Map<string, Buffer>();
    for (const name of committedFiles) {
        const bytes = await readSafeFile(root, path.join(relative, name));
        const expected = manifest.files[name]!;
        if (
            bytes.byteLength !== expected.bytes ||
            bytesHash(bytes) !== expected.sha256
        )
            throw new Error(
                `corrupt_artifact: Hash or byte length mismatch for ${name}`,
            );
        verified.set(name, bytes);
    }
    const envelope = validate(
        envelopeSchema,
        parseJsonBytes(verified.get("result.json")!),
        "result",
    );
    for (const key of [
        "runId",
        "rootId",
        "parentRunId",
        "generation",
        "scenario",
        "scenarioVersion",
        "codeVersion",
        "host",
        "configHash",
        "inputHash",
        "synthetic",
        "startedAt",
        "completedAt",
    ] as const) {
        if (envelope[key] !== manifest[key])
            throw new Error(
                `corrupt_manifest: Result provenance disagrees on ${key}`,
            );
    }
    if (
        digest(envelope.scope) !== manifest.scopeHash ||
        digest(envelope.identity) !== manifest.identityHash
    ) {
        throw new Error(
            "corrupt_manifest: Result scope or identity does not match provenance hashes",
        );
    }
    const summaryBytes = verified.get("summary.json")!,
        markdownBytes = verified.get("summary.md")!;
    if (
        summaryBytes.byteLength > SUMMARY_BYTES ||
        markdownBytes.byteLength > SUMMARY_BYTES
    )
        throw new Error("corrupt_summary: Summary exceeds its byte budget");
    if (digest(envelope) !== digest(sanitize(envelope)))
        throw new Error(
            "unsafe_artifact: Result contains unredacted secret patterns",
        );
    const summary = validate(
        summarySchema,
        parseJsonBytes(summaryBytes),
        "summary",
    );
    if (
        summary.runId !== envelope.runId ||
        summary.generation !== envelope.generation ||
        summary.scenario !== envelope.scenario ||
        summary.status !== envelope.status ||
        summary.synthetic !== envelope.synthetic ||
        summary.time.startedAt !== envelope.startedAt ||
        summary.time.completedAt !== envelope.completedAt ||
        digest(summary.assurance) !== digest(envelope.assurance) ||
        summary.shown !== summary.rows.length ||
        summary.shown > manifest.defaultRows ||
        summary.totalMatches !== envelope.result.rows.length ||
        summary.shown > summary.totalMatches
    ) {
        throw new Error(
            "corrupt_summary: Stored summary disagrees with its generation provenance or row counts",
        );
    }
    // Historical summaries retain their committed rendering; a new view must not invalidate old generations.
    if (
        digest(parseJsonBytes(verified.get("evidence/evidence.json")!)) !==
            digest(envelope.evidence) ||
        digest(parseJsonBytes(verified.get("exports/rows.json")!)) !==
            digest(envelope.result.rows) ||
        verified.get("diagnostics.jsonl")!.toString("utf8") !==
            envelope.diagnostics
                .map((item) => `${JSON.stringify(item)}\n`)
                .join("")
    ) {
        throw new Error(
            "corrupt_artifact: Evidence, diagnostics or row exports disagree with the detailed result",
        );
    }
    return { envelope, manifestHash: bytesHash(manifestBytes) };
}

export async function readResult(
    root: string,
    reportsPath: string,
    runId: string,
    generation?: string,
): Promise<ResultEnvelope> {
    validate(safeIdSchema, runId, "run_id");
    if (generation !== undefined)
        validate(safeIdSchema, generation, "generation");
    const directory = await reportsRoot(root, reportsPath, false);
    const marker = await readSealed(
        directory,
        path.join(runId, ".run.json"),
        runMarkerSchema,
        "artifact_run",
    );
    if (marker.runId !== runId)
        throw new Error(
            "corrupt_artifact_run: Run ownership marker has a different identity",
        );
    let expectedManifestHash: string | undefined;
    if (generation === undefined) {
        const pointer = await readSealed(
            directory,
            path.join(runId, "current.json"),
            pointerSchema,
            "generation_pointer",
        );
        if (pointer.runId !== runId)
            throw new Error(
                "corrupt_pointer: Current generation belongs to a different run",
            );
        generation = pointer.generation;
        expectedManifestHash = pointer.manifestHash;
    }
    const value = await verifyGeneration(
        directory,
        path.join(runId, "generations", generation),
        runId,
        generation,
    );
    if (expectedManifestHash && expectedManifestHash !== value.manifestHash)
        throw new Error(
            "corrupt_pointer: Manifest no longer matches the current generation pointer",
        );
    if (digest(marker) !== digest(runMarker(value.envelope)))
        throw new Error(
            "corrupt_artifact_run: Generation does not match the immutable run observation binding",
        );
    return value.envelope;
}

export async function publishResult(
    root: string,
    reportsPath: string,
    input: ResultEnvelope,
    options: { defaultRows?: number; advancePointer?: boolean } = {},
): Promise<{ directory: string; manifestPath: string }> {
    const publicationOptions = validate(
        publicationOptionsSchema,
        options,
        "publication_options",
    );
    const envelope = validate(
        envelopeSchema,
        sanitize(validate(envelopeSchema, input, "result")),
        "result",
    );
    const defaultRows = publicationOptions.defaultRows ?? 25;
    const view = buildView(envelope, {}, defaultRows);
    const directory = await reportsRoot(root, reportsPath, true);
    await prepareRunDirectory(directory, envelope);
    const lock = await acquireLock(
        directory,
        path.join(envelope.runId, ".publish-lock"),
    );
    const staging = path.join(
        envelope.runId,
        `.staging-${envelope.generation}-${randomUUID()}`,
    );
    const generation = path.join(
        envelope.runId,
        "generations",
        envelope.generation,
    );
    let phase = "preparation";
    let outcome: { directory: string; manifestPath: string } | undefined;
    let failure: unknown;
    try {
        const finalDirectory = await resolveSafePath(directory, generation, {
            directory: true,
        });
        try {
            await fs.lstat(finalDirectory);
            throw new Error(
                "generation_exists: Immutable generations cannot be overwritten",
            );
        } catch (error) {
            if (!isFsError(error, "ENOENT")) throw error;
        }
        await ensureDirectory(
            directory,
            path.join(envelope.runId, "generations"),
        );
        await ensureDirectory(directory, path.join(staging, "evidence"));
        await ensureDirectory(directory, path.join(staging, "exports"));
        const files: Record<(typeof committedFiles)[number], string> = {
            "result.json": json(envelope),
            "summary.json": json(view),
            "summary.md": `# Run summary\n\n\`\`\`json\n${json(view)}\`\`\`\n`,
            "evidence/evidence.json": json(envelope.evidence),
            "diagnostics.jsonl": envelope.diagnostics
                .map((item) => `${JSON.stringify(item)}\n`)
                .join(""),
            "exports/rows.json": json(envelope.result.rows),
            "exports/rows.csv": csv(envelope.result.rows),
        };
        phase = "artifact-write";
        for (const name of committedFiles)
            await writeExclusive(
                directory,
                path.join(staging, name),
                files[name],
            );
        const manifest: Manifest = {
            schemaVersion: "1",
            formatVersion: "1",
            publication: "committed",
            runId: envelope.runId,
            rootId: envelope.rootId,
            ...(envelope.parentRunId
                ? { parentRunId: envelope.parentRunId }
                : {}),
            generation: envelope.generation,
            scenario: envelope.scenario,
            scenarioVersion: envelope.scenarioVersion,
            codeVersion: envelope.codeVersion,
            configHash: envelope.configHash,
            inputHash: envelope.inputHash,
            scopeHash: digest(envelope.scope),
            identityHash: digest(envelope.identity),
            host: envelope.host,
            synthetic: envelope.synthetic,
            startedAt: envelope.startedAt,
            completedAt: envelope.completedAt,
            publishedAt: new Date().toISOString(),
            defaultRows,
            files: Object.fromEntries(
                committedFiles.map((name) => [
                    name,
                    {
                        sha256: bytesHash(files[name]),
                        bytes: Buffer.byteLength(files[name], "utf8"),
                    },
                ]),
            ),
        };
        phase = "manifest-write";
        await writeExclusive(
            directory,
            path.join(staging, "manifest.json"),
            json(seal(manifest)),
        );
        phase = "staging-validation";
        const verified = await verifyGeneration(
            directory,
            staging,
            envelope.runId,
            envelope.generation,
        );
        phase = "generation-rename";
        await lock.assertOwned();
        await fs.rename(
            await resolveSafePath(directory, staging, {
                directory: true,
                mustExist: true,
            }),
            finalDirectory,
        );
        await syncDirectory(path.dirname(finalDirectory));
        phase = "pointer-selection";
        const currentPath = path.join(envelope.runId, "current.json");
        let advancePointer = publicationOptions.advancePointer ?? true;
        if (!advancePointer) {
            try {
                await resolveSafePath(directory, currentPath, {
                    mustExist: true,
                    directory: false,
                });
            } catch (error) {
                if (isFsError(error, "ENOENT")) advancePointer = true;
                else throw error;
            }
        }
        if (advancePointer) {
            phase = "pointer-write";
            await atomicWrite(
                directory,
                currentPath,
                seal({
                    schemaVersion: "1",
                    runId: envelope.runId,
                    generation: envelope.generation,
                    manifestHash: verified.manifestHash,
                }),
            );
        }
        outcome = {
            directory: finalDirectory,
            manifestPath: path.join(finalDirectory, "manifest.json"),
        };
    } catch (error) {
        failure = error;
        try {
            await ensureDirectory(
                directory,
                path.join(envelope.runId, "failures"),
            );
            await writeExclusive(
                directory,
                path.join(envelope.runId, "failures", `${randomUUID()}.json`),
                json({
                    schemaVersion: "1",
                    runId: envelope.runId,
                    generation: envelope.generation,
                    at: new Date().toISOString(),
                    phase,
                    status: "failed",
                    message: redactText(
                        error instanceof Error
                            ? error.message
                            : "Unknown publication failure",
                    ),
                    staging,
                    lastGoodGeneration:
                        "The existing current.json remains authoritative unless the pointer rename completed.",
                }),
            );
        } catch (receiptError) {
            failure = new AggregateError(
                [error, receiptError],
                "publication_failed: Publication and failure-receipt persistence both failed",
            );
        }
    }
    try {
        await lock.release();
    } catch (error) {
        failure = failure
            ? new AggregateError(
                  [failure, error],
                  "publication_failed: Publication and lock release failed",
              )
            : error;
    }
    if (failure) throw failure;
    if (!outcome)
        throw new Error(
            "publication_failed: No committed generation was produced",
        );
    return outcome;
}
