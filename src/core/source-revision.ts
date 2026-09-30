import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(directory: string): string[] {
    return readdirSync(join(projectRoot, directory), {
        withFileTypes: true,
    }).flatMap((entry) => {
        const file = `${directory}/${entry.name}`;
        return entry.isDirectory() ? sourceFiles(file) : [file];
    });
}

function parseMetadata(file: string, bytes: Buffer): unknown {
    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
        if (error instanceof SyntaxError)
            throw new Error(
                `invalid_source_metadata: ${file} must contain valid JSON`,
                { cause: error },
            );
        throw error;
    }
}

export function getSourceIdentity(): {
    sourceSha256: string;
    codeVersion: string;
} {
    const packageBytes = readFileSync(join(projectRoot, "package.json"));
    const manifest = parseMetadata("package.json", packageBytes);
    if (
        !manifest ||
        typeof manifest !== "object" ||
        !("version" in manifest) ||
        typeof manifest.version !== "string"
    ) {
        throw new Error(
            "invalid_source_metadata: package.json must declare a version",
        );
    }
    const version = manifest.version;
    const semver =
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
            version,
        );
    if (
        !semver ||
        semver[0] !== version ||
        semver[4]?.split(".").some((part) => /^0\d+$/.test(part)) ||
        version.length + 13 > 100
    ) {
        throw new Error(
            "invalid_source_metadata: package.json version must be SemVer without build metadata and fit the report codeVersion",
        );
    }
    const lockBytes = readFileSync(join(projectRoot, "package-lock.json"));
    const lock = parseMetadata("package-lock.json", lockBytes);
    if (
        !lock ||
        typeof lock !== "object" ||
        !("lockfileVersion" in lock) ||
        typeof lock.lockfileVersion !== "number" ||
        !Number.isSafeInteger(lock.lockfileVersion) ||
        lock.lockfileVersion < 1
    ) {
        throw new Error(
            "invalid_source_metadata: package-lock.json must declare a positive integer lockfileVersion",
        );
    }
    const hash = createHash("sha256");
    for (const file of [
        ...sourceFiles("src").sort(),
        "package.json",
        "package-lock.json",
    ]) {
        const bytes =
            file === "package.json"
                ? packageBytes
                : file === "package-lock.json"
                  ? lockBytes
                  : readFileSync(join(projectRoot, file));
        // Paths cannot contain NUL; byte lengths keep arbitrary file contents unambiguous.
        hash.update(file)
            .update("\0")
            .update(`${bytes.length}\0`)
            .update(bytes);
    }
    const sourceSha256 = hash.digest("hex");
    return {
        sourceSha256,
        codeVersion: `${version}+${sourceSha256.slice(0, 12)}`,
    };
}
