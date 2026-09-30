import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { fakeGhEnvironment, installFakeGh } from "../fixtures/gh.ts";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const lockSchema = z.object({
    packages: z.record(
        z.string(),
        z.object({ version: z.string(), dev: z.boolean().optional() }),
    ),
});
const identitySchema = z.strictObject({
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    codeVersion: z.string().regex(/^\d+\.\d+\.\d+\+[a-f0-9]{12}$/),
});

export async function sourceCheckout(context: TestContext): Promise<string> {
    const base = join(projectRoot, ".test-tmp");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "source-checkout-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const lock = lockSchema.parse(
        JSON.parse(
            await readFile(join(projectRoot, "package-lock.json"), "utf8"),
        ),
    );
    const runtimePackages = Object.entries(lock.packages)
        .filter(
            ([name, entry]) => name.startsWith("node_modules/") && !entry.dev,
        )
        .map(([name]) => name)
        .sort();
    assert.ok(runtimePackages.length > 0);
    const paths = [
        "src",
        "package.json",
        "package-lock.json",
        "scripts",
        "schemas",
        ".github/agents",
        ".github/skills",
        ".github/copilot-instructions.md",
        ".vscode/settings.json",
        "README.md",
        "docs/third-party-notices.md",
        "config/admin-agent.example.json",
        "config/policies/repositories.example.json",
        "examples/owners.example.csv",
        "tests/fixtures/network-block.mjs",
        "tests/fixtures/gh.mjs",
        "tests/host-acceptance/intent-corpus.json",
        ...runtimePackages,
    ];
    for (const name of paths) {
        assert.ok(
            name
                .split("/")
                .every((part) => part && part !== "." && part !== ".."),
        );
        const destination = join(root, name);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(projectRoot, name), destination, {
            recursive: true,
            force: false,
            errorOnExist: true,
        });
    }
    await installFakeGh(root);
    return root;
}

export function runCheckout(
    root: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
    const networkBlocker = pathToFileURL(
        join(root, "tests/fixtures/network-block.mjs"),
    ).href;
    const result = spawnSync(
        process.execPath,
        ["--import", networkBlocker, ...args],
        {
            cwd: root,
            encoding: "utf8",
            timeout: 30000,
            shell: false,
            env: {
                ...process.env,
                NODE_PATH: "",
                NODE_OPTIONS: `--import=${networkBlocker}`,
                GITHUB_ADMIN_TOKEN: "",
                GITHUB_TOKEN: "",
                GH_TOKEN: "",
                GITHUB_ADMIN_HOST_ACCEPTANCE: "",
                GITHUB_ADMIN_LIVE_ACCEPTANCE: "",
                HTTP_PROXY: "http://127.0.0.1:1",
                HTTPS_PROXY: "http://127.0.0.1:1",
                ...fakeGhEnvironment(root),
                ...env,
            },
        },
    );
    if (result.error) throw result.error;
    return result;
}

export function checkoutIdentity(root: string): z.infer<typeof identitySchema> {
    const result = runCheckout(root, [
        "--input-type=module",
        "--eval",
        `
    import { getSourceIdentity } from './src/core/source-revision.ts';
    process.stdout.write(JSON.stringify(getSourceIdentity()));
  `,
    ]);
    assert.equal(result.status, 0, result.stderr);
    return identitySchema.parse(JSON.parse(result.stdout));
}
