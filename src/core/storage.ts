import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { digest } from "./redact.ts";
import { isFsError, readJsonInput, resolveSafePath } from "./paths.ts";
import {
    hashSchema,
    safeIdSchema,
    timestampSchema,
    validate,
} from "./storage-schemas.ts";

export async function ensureDirectory(
    root: string,
    relative: string,
): Promise<string> {
    const target = await resolveSafePath(root, relative, { directory: true });
    const parts = path
        .relative(path.resolve(root), target)
        .split(path.sep)
        .filter(Boolean);
    let current = "";
    for (const component of parts) {
        current = path.join(current, component);
        const directory = await resolveSafePath(root, current, {
            directory: true,
        });
        try {
            await fs.mkdir(directory, { mode: 0o700 });
            await syncDirectory(path.dirname(directory));
        } catch (error) {
            if (!isFsError(error, "EEXIST")) throw error;
        }
        await resolveSafePath(root, current, {
            mustExist: true,
            directory: true,
        });
    }
    return target;
}

export async function syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(
        directory,
        constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function writeExclusive(
    root: string,
    relative: string,
    contents: string | Buffer,
): Promise<void> {
    const filename = await resolveSafePath(root, relative, {
        directory: false,
    });
    const handle = await fs.open(
        filename,
        constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
        0o600,
    );
    try {
        await handle.writeFile(contents);
        await handle.sync();
    } finally {
        await handle.close();
    }
    await syncDirectory(path.dirname(filename));
}

export async function atomicWrite(
    root: string,
    relative: string,
    value: unknown,
): Promise<void> {
    const filename = await resolveSafePath(root, relative, {
        directory: false,
    });
    const temporary = path.join(
        path.dirname(relative),
        `.${path.basename(relative)}-${randomUUID()}.tmp`,
    );
    const temporaryPath = await resolveSafePath(root, temporary, {
        directory: false,
    });
    try {
        await writeExclusive(root, temporary, `${JSON.stringify(value)}\n`);
        await resolveSafePath(root, relative, { directory: false });
        await fs.rename(temporaryPath, filename);
        await syncDirectory(path.dirname(filename));
    } catch (error) {
        try {
            await fs.unlink(temporaryPath);
        } catch (cleanup) {
            if (!isFsError(cleanup, "ENOENT"))
                throw new AggregateError(
                    [error, cleanup],
                    "storage_failure: Write and temporary-file cleanup failed",
                );
        }
        throw error;
    }
}

export function seal<T>(data: T): { data: T; sha256: string } {
    return { data, sha256: digest(data) };
}

export function unseal<T>(
    input: unknown,
    schema: z.ZodType<T>,
    context: string,
): T {
    const value = validate(
        z.strictObject({ data: z.unknown(), sha256: hashSchema }),
        input,
        context,
    );
    if (digest(value.data) !== value.sha256)
        throw new Error(`corrupt_${context}: Integrity digest does not match`);
    return validate(schema, value.data, context);
}

export async function readSealed<T>(
    root: string,
    relative: string,
    schema: z.ZodType<T>,
    context: string,
): Promise<T> {
    return unseal(await readJsonInput(root, relative), schema, context);
}

const markerSchema = z.strictObject({
    schemaVersion: z.literal("1"),
    format: z.literal("github-admin-agent-reports"),
});
const reserved = new Set([
    "src",
    "tests",
    "config",
    "scripts",
    "node_modules",
    ".git",
    ".github",
    "dist",
    ".test-dist",
]);

export async function reportsRoot(
    root: string,
    reportsPath: string,
    create: boolean,
): Promise<string> {
    const directory = await resolveSafePath(root, reportsPath, {
        directory: true,
        mustExist: !create,
    });
    const relative = path.relative(path.resolve(root), directory);
    if (!relative || reserved.has(relative.split(path.sep)[0]!.toLowerCase())) {
        throw new Error(
            "unsafe_reports_path: Reports must use a dedicated directory, not the workspace or an input/source directory",
        );
    }
    if (create) await ensureDirectory(root, relative);
    const marker = path.join(relative, ".admin-artifacts.json");
    let existing = false;
    try {
        await resolveSafePath(root, marker, {
            directory: false,
            mustExist: true,
        });
        existing = true;
    } catch (error) {
        if (!isFsError(error, "ENOENT")) throw error;
    }
    if (!existing) {
        if (!create)
            throw new Error(
                "missing_reports: This directory has no managed report ownership marker",
            );
        if ((await fs.readdir(directory)).length !== 0)
            throw new Error(
                "output_collision: Refusing to reuse a nonempty unmanaged report directory",
            );
        try {
            await writeExclusive(
                root,
                marker,
                '{"schemaVersion":"1","format":"github-admin-agent-reports"}\n',
            );
        } catch (error) {
            if (!isFsError(error, "EEXIST")) throw error;
        }
        await syncDirectory(directory);
    }
    validate(markerSchema, await readJsonInput(root, marker), "reports_marker");
    if (create) await fs.chmod(directory, 0o700);
    return directory;
}

const lockOwnerSchema = z.strictObject({
    schemaVersion: z.literal("1"),
    token: safeIdSchema,
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    createdAt: timestampSchema,
});
type LockOwner = z.infer<typeof lockOwnerSchema>;
export interface StorageLock {
    assertOwned(): Promise<void>;
    release(): Promise<void>;
    recovered: string[];
}

function dead(owner: LockOwner): boolean {
    if (owner.hostname !== hostname())
        throw new Error(
            "foreign_lock: Lock belongs to another host; recovery requires checking that host first",
        );
    try {
        process.kill(owner.pid, 0);
        return false;
    } catch (error) {
        if (isFsError(error, "ESRCH")) return true;
        if (isFsError(error, "EPERM")) return false;
        throw error;
    }
}

export async function acquireLock(
    root: string,
    relative: string,
): Promise<StorageLock> {
    const token = randomUUID();
    const owner: LockOwner = {
        schemaVersion: "1",
        token,
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
    };
    const ownerName = `owner-${token}.json`;
    const candidate = `${relative}.candidate-${token}`;
    const candidatePath = await ensureDirectory(root, candidate);
    await writeExclusive(
        root,
        path.join(candidate, ownerName),
        `${JSON.stringify(owner)}\n`,
    );
    await syncDirectory(candidatePath);
    const lockPath = await resolveSafePath(root, relative, { directory: true });
    const recovered: string[] = [];
    let acquired = false;
    try {
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                await fs.rename(candidatePath, lockPath);
                acquired = true;
                try {
                    await syncDirectory(path.dirname(lockPath));
                } catch (error) {
                    try {
                        await fs.unlink(path.join(lockPath, ownerName));
                        await fs.rmdir(lockPath);
                    } catch (releaseError) {
                        throw new AggregateError(
                            [error, releaseError],
                            "lock_failure: Lock acquisition and rollback failed",
                        );
                    }
                    throw error;
                }
                break;
            } catch (error) {
                if (
                    !isFsError(error, "EEXIST") &&
                    !isFsError(error, "ENOTEMPTY")
                )
                    throw error;
            }
            let entries: string[];
            try {
                await resolveSafePath(root, relative, {
                    directory: true,
                    mustExist: true,
                });
                entries = await fs.readdir(lockPath);
            } catch (error) {
                if (isFsError(error, "ENOENT")) continue;
                throw error;
            }
            if (entries.length === 0) continue;
            if (
                entries.length !== 1 ||
                !/^owner-[a-zA-Z0-9_-]+\.json$/.test(entries[0]!)
            ) {
                throw new Error(
                    "corrupt_lock: Unexpected lock contents; explicit local recovery is required",
                );
            }
            let previous: LockOwner;
            try {
                previous = validate(
                    lockOwnerSchema,
                    await readJsonInput(root, path.join(relative, entries[0]!)),
                    "lock",
                );
            } catch (error) {
                if (isFsError(error, "ENOENT")) continue;
                throw error;
            }
            if (entries[0] !== `owner-${previous.token}.json`)
                throw new Error(
                    "corrupt_lock: Owner token and filename disagree",
                );
            if (!dead(previous))
                throw new Error(
                    `lineage_locked: PID ${previous.pid} holds this root; do not remove an active lock`,
                );
            const receipt = `${relative}.recovered-${previous.token}.json`;
            try {
                await fs.rename(
                    path.join(lockPath, entries[0]!),
                    await resolveSafePath(root, receipt, { directory: false }),
                );
                await syncDirectory(path.dirname(lockPath));
                recovered.push(receipt);
            } catch (error) {
                if (isFsError(error, "ENOENT")) continue;
                throw error;
            }
            try {
                await fs.rmdir(lockPath);
            } catch (error) {
                if (
                    !isFsError(error, "ENOENT") &&
                    !isFsError(error, "ENOTEMPTY") &&
                    !isFsError(error, "EEXIST")
                )
                    throw error;
            }
        }
        if (!acquired)
            throw new Error(
                "lineage_locked: Concurrent lock recovery did not settle; retry the explicit operation",
            );
    } finally {
        if (!acquired) {
            await fs.unlink(path.join(candidatePath, ownerName));
            await fs.rmdir(candidatePath);
        }
    }
    let released = false;
    const assertOwned = async () => {
        if (released) throw new Error("lock_lost: Lock was already released");
        const saved = validate(
            lockOwnerSchema,
            await readJsonInput(root, path.join(relative, ownerName)),
            "lock",
        );
        if (saved.token !== token || saved.pid !== process.pid)
            throw new Error("lock_lost: This session no longer owns its lock");
    };
    return {
        recovered,
        assertOwned,
        async release() {
            if (released) return;
            await assertOwned();
            await fs.unlink(path.join(lockPath, ownerName));
            released = true;
            try {
                await fs.rmdir(lockPath);
            } catch (error) {
                if (
                    !isFsError(error, "ENOENT") &&
                    !isFsError(error, "ENOTEMPTY") &&
                    !isFsError(error, "EEXIST")
                )
                    throw error;
            }
            await syncDirectory(path.dirname(lockPath));
        },
    };
}
