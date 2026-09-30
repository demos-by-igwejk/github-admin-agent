import { test } from "node:test";
import assert from "node:assert/strict";
import {
    cp,
    mkdir,
    readFile,
    readdir,
    realpath,
    stat,
    writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { resultEnvelopeSchema } from "../../src/core/envelope.ts";
import { getSourceIdentity } from "../../src/core/source-revision.ts";
import {
    checkoutIdentity,
    runCheckout,
    sourceCheckout,
} from "./source-checkout.ts";

const dependencySchema = z.object({
    version: z.string(),
    license: z.literal("MIT"),
    dependencies: z.record(z.string(), z.string()).optional(),
});
const viewSchema = z.object({
    status: z.string(),
    synthetic: z.boolean(),
    runId: z.string(),
    generation: z.string(),
    artifacts: z.object({ result: z.string() }),
});

test("AC21: a production-only checkout loads its native runtime locally and preserves CLI behavior without a bundle", async (context) => {
    const root = await sourceCheckout(context);
    const identity = checkoutIdentity(root);
    assert.deepEqual(
        identity,
        getSourceIdentity(),
        "The full source tree, manifest, and lockfile must survive the checkout copy",
    );
    const isolatedImports = (args: string[]) =>
        runCheckout(root, [
            "--permission",
            `--allow-fs-read=${root}`,
            `--allow-fs-write=${root}`,
            ...args,
        ]);
    for (const name of [
        "dist",
        ".test-dist",
        ".build",
        "node_modules/typescript",
        "node_modules/esbuild",
        "node_modules/@types",
    ]) {
        await assert.rejects(stat(join(root, name)), { code: "ENOENT" });
    }
    assert.deepEqual((await readdir(join(root, "node_modules"))).sort(), [
        "lossless-json",
        "zod",
    ]);
    for (const name of [
        "package.json",
        "package-lock.json",
        ".github/agents/github-admin.agent.md",
        "config/admin-agent.example.json",
        "config/policies/repositories.example.json",
        "examples/owners.example.csv",
    ])
        assert.equal(
            await readFile(join(root, name), "utf8"),
            await readFile(resolve(name), "utf8"),
        );

    const probe = isolatedImports([
        "--input-type=module",
        "--eval",
        `
    import assert from 'node:assert/strict';
    import { readFileSync, realpathSync } from 'node:fs';
    import { createRequire } from 'node:module';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const origins = [];
    for (const name of Object.keys(manifest.dependencies)) {
      await import(name);
      origins.push({ name, resolved: realpathSync(fileURLToPath(import.meta.resolve(name))) });
    }
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (!name.startsWith('node_modules/') || entry.dev) continue;
      const filename = path.resolve(name, 'package.json');
      const installed = JSON.parse(readFileSync(filename, 'utf8'));
      assert.equal(installed.version, entry.version);
      const require = createRequire(filename);
      for (const dependency of Object.keys(installed.dependencies ?? {})) {
        origins.push({ name: dependency, resolved: realpathSync(require.resolve(dependency)) });
      }
    }
    for (const name of ['typescript', 'esbuild']) {
      await assert.rejects(import(name), error => ['ERR_ACCESS_DENIED', 'ERR_MODULE_NOT_FOUND'].includes(error.code));
    }
    process.stdout.write(JSON.stringify(origins));
  `,
    ]);
    assert.equal(probe.status, 0, probe.stderr);
    const origins = z
        .array(z.object({ name: z.string(), resolved: z.string() }))
        .parse(JSON.parse(probe.stdout));
    assert.deepEqual(origins.map((origin) => origin.name).sort(), [
        "lossless-json",
        "zod",
    ]);
    const dependencyRoot = await realpath(join(root, "node_modules"));
    for (const origin of origins) {
        const local = relative(dependencyRoot, origin.resolved);
        assert.ok(
            local && !local.startsWith("..") && !isAbsolute(local),
            `Dependency escaped the checkout: ${origin.name}`,
        );
    }
    const donorRead = isolatedImports([
        "--input-type=module",
        "--eval",
        `
    import { readFileSync } from 'node:fs';
    readFileSync(${JSON.stringify(resolve("package.json"))});
  `,
    ]);
    assert.notEqual(donorRead.status, 0);
    assert.match(donorRead.stderr, /ERR_ACCESS_DENIED/);
    for (const [name, license] of [
        ["zod", "LICENSE"],
        ["lossless-json", "LICENSE.md"],
    ] as const) {
        const installed = dependencySchema.parse(
            JSON.parse(
                await readFile(
                    join(root, "node_modules", name, "package.json"),
                    "utf8",
                ),
            ),
        );
        assert.equal(installed.version, name === "zod" ? "4.6.5" : "4.3.1");
        assert.equal(
            await readFile(join(root, "node_modules", name, license), "utf8"),
            await readFile(resolve("node_modules", name, license), "utf8"),
        );
    }

    const version = isolatedImports(["src/cli.ts", "--version"]);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, `${identity.codeVersion}\n`);
    const catalog = isolatedImports(["src/cli.ts", "scenarios", "list"]);
    assert.equal(catalog.status, 0, catalog.stderr);
    assert.deepEqual(
        z
            .array(z.object({ id: z.string() }))
            .parse(JSON.parse(catalog.stdout))
            .map((item) => item.id)
            .sort(),
        [
            "repository-activity-inventory",
            "repository-billing-report",
            "repository-settings-audit",
        ],
    );
    // Runtime imports are proven above with donor reads denied. Storage's real ancestry checks require normal metadata access.
    for (const scenario of [
        "repository-activity-inventory",
        "repository-billing-report",
        "repository-settings-audit",
    ]) {
        const run = runCheckout(root, [
            "src/cli.ts",
            "demo",
            "--scenario",
            scenario,
        ]);
        assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
        assert.ok(Buffer.byteLength(run.stdout) <= 65536);
        const output = viewSchema.parse(JSON.parse(run.stdout));
        assert.equal(output.status, "completed");
        assert.equal(output.synthetic, true);
        const envelope = resultEnvelopeSchema.parse(
            JSON.parse(
                await readFile(
                    join(root, "reports", output.artifacts.result),
                    "utf8",
                ),
            ),
        );
        assert.equal(envelope.scenario, scenario);
        assert.equal(envelope.codeVersion, identity.codeVersion);
        if (scenario === "repository-billing-report") {
            assert.ok(
                envelope.result.rows.some(
                    (row) =>
                        row.repository === "example-org/retired" &&
                        row.netAmount === "0.0005",
                ),
            );
        }
        const replay = runCheckout(root, [
            "src/cli.ts",
            "result",
            output.runId,
            "--view",
            "summary",
        ]);
        assert.equal(replay.status, 0, replay.stderr);
        assert.equal(
            viewSchema.parse(JSON.parse(replay.stdout)).generation,
            output.generation,
        );
    }
    const invalid = runCheckout(root, [
        "src/cli.ts",
        "apply",
        "repository-settings-audit",
    ]);
    assert.equal(invalid.status, 1);
    assert.deepEqual(JSON.parse(invalid.stdout).reasons, [
        "unsupported_operation",
    ]);

    const schemaFile = join(root, "schemas/configuration.schema.json");
    const originalSchema = await readFile(schemaFile, "utf8");
    const schemas = isolatedImports(["scripts/schemas.mjs", "--check"]);
    assert.equal(schemas.status, 0, schemas.stderr);
    await writeFile(schemaFile, "{}\n");
    const drift = isolatedImports(["scripts/schemas.mjs", "--check"]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /schema_drift/);
    const regenerated = isolatedImports(["scripts/schemas.mjs"]);
    assert.equal(regenerated.status, 0, regenerated.stderr);
    assert.equal(await readFile(schemaFile, "utf8"), originalSchema);
    const rechecked = isolatedImports(["scripts/schemas.mjs", "--check"]);
    assert.equal(rechecked.status, 0, rechecked.stderr);
    for (const name of ["dist", ".test-dist", ".build"])
        await assert.rejects(stat(join(root, name)), { code: "ENOENT" });
});

test("native Node refuses the source CLI when placed beneath node_modules", async (context) => {
    const root = await sourceCheckout(context);
    const installed = join(root, "node_modules/github-admin-agent");
    await mkdir(installed);
    for (const name of ["src", "package.json", "package-lock.json"]) {
        await cp(join(root, name), join(installed, name), { recursive: true });
    }
    const result = runCheckout(root, [
        "node_modules/github-admin-agent/src/cli.ts",
        "--version",
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
});
