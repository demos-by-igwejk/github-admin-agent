import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function files(root) {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map((entry) =>
            entry.isDirectory()
                ? files(join(root, entry.name))
                : entry.isFile() && entry.name.endsWith(".test.ts")
                  ? [join(root, entry.name)]
                  : [],
        ),
    );
    return nested.flat().sort();
}

const root = fileURLToPath(new URL("..", import.meta.url));
const tests = await files(join(root, "tests"));
if (tests.length === 0) throw new Error("No native TypeScript tests found");
const networkBlocker = new URL(
    "../tests/fixtures/network-block.mjs",
    import.meta.url,
).href;
const result = spawnSync(
    process.execPath,
    ["--import", networkBlocker, "--test", ...tests],
    { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
