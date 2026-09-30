import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "lossless-json";

export function isFsError(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

export async function resolveSafePath(
    root: string,
    relative: string,
    options: { mustExist?: boolean; directory?: boolean } = {},
): Promise<string> {
    if (
        !root ||
        !relative ||
        /[\0\r\n]/.test(root + relative) ||
        relative.includes("\\")
    ) {
        throw new Error(
            "unsafe_path: Expected a nonempty, portable project-relative path",
        );
    }
    const base = path.resolve(root);
    if (
        relative.split("/").includes("..") ||
        (path.win32.isAbsolute(relative) && !path.isAbsolute(relative))
    ) {
        throw new Error(
            "unsafe_path: Parent traversal and foreign absolute paths are not permitted",
        );
    }
    if (path.isAbsolute(relative) && path.resolve(relative) !== base) {
        throw new Error(
            "unsafe_path: Absolute paths other than the approved root are not permitted",
        );
    }
    const target = path.resolve(base, relative);
    const contained = path.relative(base, target);
    if (
        contained === ".." ||
        contained.startsWith(`..${path.sep}`) ||
        path.isAbsolute(contained)
    ) {
        throw new Error("unsafe_path: Path is outside the approved root");
    }
    const rootParts = base
        .slice(path.parse(base).root.length)
        .split(path.sep)
        .filter(Boolean);
    let current = path.parse(base).root;
    for (const component of rootParts) {
        current = path.join(current, component);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error(
                "unsafe_path: Approved root has a symlink or non-directory component",
            );
    }
    const parts = contained.split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]!);
        let stat;
        try {
            stat = await fs.lstat(current);
        } catch (error) {
            if (isFsError(error, "ENOENT") && !options.mustExist) return target;
            throw error;
        }
        if (stat.isSymbolicLink())
            throw new Error(
                "unsafe_path: Symlink components are not permitted",
            );
        const leaf = index === parts.length - 1;
        if ((!leaf || options.directory === true) && !stat.isDirectory())
            throw new Error("unsafe_path: Expected a directory");
        if (leaf && options.directory === false && !stat.isFile())
            throw new Error("unsafe_path: Expected a regular file");
        if (leaf && !stat.isFile() && !stat.isDirectory())
            throw new Error(
                "unsafe_path: Special filesystem objects are not permitted",
            );
    }
    if (parts.length === 0 && options.directory === false)
        throw new Error("unsafe_path: The approved root is not a file");
    return target;
}

export async function readSafeFile(
    root: string,
    relative: string,
): Promise<Buffer> {
    const filename = await resolveSafePath(root, relative, {
        mustExist: true,
        directory: false,
    });
    const handle = await fs.open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
        const stat = await handle.stat();
        if (!stat.isFile())
            throw new Error("unsafe_path: Expected a regular file");
        return await handle.readFile();
    } finally {
        await handle.close();
    }
}

export function parseJson(text: string): unknown {
    try {
        return parse(text, null, {
            parseNumber: (lexeme) => {
                const value = Number(lexeme);
                if (
                    !Number.isFinite(value) ||
                    (Number.isInteger(value) && !Number.isSafeInteger(value))
                ) {
                    throw new Error(
                        "Unsafe JSON number; encode exact large numeric values as strings",
                    );
                }
                return value;
            },
            onDuplicateKey: () => {
                throw new Error("Duplicate JSON object key");
            },
        });
    } catch {
        throw new Error(
            "invalid_json: Expected strict JSON with unique keys and finite, safe numeric values",
        );
    }
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
    let text: string;
    try {
        text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
        }).decode(bytes);
    } catch {
        throw new Error("invalid_json: Input is not valid UTF-8");
    }
    return parseJson(text);
}

export async function readJsonInput(
    root: string,
    relative: string,
): Promise<unknown> {
    return parseJsonBytes(await readSafeFile(root, relative));
}
