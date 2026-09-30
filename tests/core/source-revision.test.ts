import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

async function sourceCheckout(context: TestContext) {
    const parent = fileURLToPath(new URL("../../.test-tmp/", import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "source-identity-"));
    context.after(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(root, "src", "core"), { recursive: true });
    const modulePath = path.join(root, "src", "core", "source-revision.ts");
    await fs.copyFile(
        new URL("../../src/core/source-revision.ts", import.meta.url),
        modulePath,
    );
    const manifest = {
        name: "source-identity-fixture",
        version: "1.2.3",
        type: "module",
    };
    await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify(manifest),
    );
    await fs.writeFile(
        path.join(root, "package-lock.json"),
        JSON.stringify({
            name: manifest.name,
            version: manifest.version,
            lockfileVersion: 3,
            packages: {
                "": { name: manifest.name, version: manifest.version },
            },
        }),
    );
    const moduleUrl = pathToFileURL(modulePath).href;
    const revision: typeof import("../../src/core/source-revision.ts") =
        await import(moduleUrl);
    return { root, moduleUrl, getSourceIdentity: revision.getSourceIdentity };
}

test("source identity is deterministic across calls, checkout roots, and directory creation order", async (context) => {
    const first = await sourceCheckout(context);
    const second = await sourceCheckout(context);
    for (const [checkout, names] of [
        [first, ["z.ts", "a.ts"]],
        [second, ["a.ts", "z.ts"]],
    ] as const) {
        for (const name of names)
            await fs.writeFile(
                path.join(checkout.root, "src", name),
                `export const name = '${name}';\n`,
            );
    }
    const identity = first.getSourceIdentity();
    assert.match(identity.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(
        identity.codeVersion,
        `1.2.3+${identity.sourceSha256.slice(0, 12)}`,
    );
    assert.deepEqual(first.getSourceIdentity(), identity);
    assert.deepEqual(second.getSourceIdentity(), identity);
});

test("source identity resolves its checkout from the module instead of the subprocess cwd", async (context) => {
    const checkout = await sourceCheckout(context);
    const identity = checkout.getSourceIdentity();
    const cwd = path.join(checkout.root, "workspace");
    await fs.mkdir(cwd);
    await fs.writeFile(
        path.join(cwd, "package.json"),
        JSON.stringify({ version: "9.9.9" }),
    );
    const script = `
    import { getSourceIdentity } from ${JSON.stringify(checkout.moduleUrl)};
    process.stdout.write(JSON.stringify(getSourceIdentity()));
  `;
    const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { cwd, encoding: "utf8", timeout: 30000 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), identity);
});

test("each source identity call re-reads source, manifest, and lockfile bytes without caching", async (context) => {
    const checkout = await sourceCheckout(context);
    const identity = checkout.getSourceIdentity();
    for (const file of [
        "src/core/source-revision.ts",
        "package.json",
        "package-lock.json",
    ]) {
        const filename = path.join(checkout.root, file);
        const original = await fs.readFile(filename);
        await fs.appendFile(filename, "\n");
        const changed = checkout.getSourceIdentity();
        assert.notEqual(changed.sourceSha256, identity.sourceSha256, file);
        assert.notEqual(changed.codeVersion, identity.codeVersion, file);
        await fs.writeFile(filename, original);
        assert.deepEqual(checkout.getSourceIdentity(), identity, file);
    }
    await fs.writeFile(
        path.join(checkout.root, "package.json"),
        JSON.stringify({ type: "module", version: "2.4.6-rc.1" }),
    );
    const changed = checkout.getSourceIdentity();
    assert.equal(
        changed.codeVersion,
        `2.4.6-rc.1+${changed.sourceSha256.slice(0, 12)}`,
    );
    assert.notEqual(changed.sourceSha256, identity.sourceSha256);
});

test("source identity covers nested files, binary contents, additions, removals, and renamed paths", async (context) => {
    const checkout = await sourceCheckout(context);
    const identity = checkout.getSourceIdentity();
    const directory = path.join(checkout.root, "src", "nested");
    await fs.mkdir(directory);
    const original = path.join(directory, "data.bin"),
        renamed = path.join(directory, "renamed.bin");
    await fs.writeFile(original, Buffer.from([0, 1, 2, 255]));
    const added = checkout.getSourceIdentity();
    assert.notEqual(added.sourceSha256, identity.sourceSha256);
    await fs.rename(original, renamed);
    assert.notEqual(
        checkout.getSourceIdentity().sourceSha256,
        added.sourceSha256,
    );
    await fs.rename(renamed, original);
    assert.deepEqual(checkout.getSourceIdentity(), added);
    await fs.appendFile(original, Buffer.from([0]));
    assert.notEqual(
        checkout.getSourceIdentity().sourceSha256,
        added.sourceSha256,
    );
    await fs.unlink(original);
    assert.deepEqual(checkout.getSourceIdentity(), identity);
});

test("source identity framing distinguishes embedded NUL/path bytes from separate files", async (context) => {
    const checkout = await sourceCheckout(context);
    const first = path.join(checkout.root, "src", "a.bin"),
        second = path.join(checkout.root, "src", "b.bin");
    await fs.writeFile(first, "A");
    await fs.writeFile(second, "B");
    const split = checkout.getSourceIdentity();
    await fs.appendFile(first, "\0src/b.bin\0B");
    await fs.unlink(second);
    assert.notEqual(
        checkout.getSourceIdentity().sourceSha256,
        split.sourceSha256,
    );
});

test("source identity excludes installed dependency bytes and workspace artifacts", async (context) => {
    const checkout = await sourceCheckout(context);
    const identity = checkout.getSourceIdentity();
    for (const directory of ["node_modules", "reports", "docs", ".test-tmp"]) {
        await fs.mkdir(path.join(checkout.root, directory));
        await fs.writeFile(
            path.join(checkout.root, directory, "fixture.json"),
            '{"changed":true}',
        );
    }
    assert.deepEqual(checkout.getSourceIdentity(), identity);
});

test("source identity fails closed when required checkout metadata or source files are missing", async (context) => {
    const checkout = await sourceCheckout(context);
    for (const file of ["package.json", "package-lock.json", "src"]) {
        const filename = path.join(checkout.root, file),
            moved = `${filename}.missing`;
        await fs.rename(filename, moved);
        assert.throws(checkout.getSourceIdentity, { code: "ENOENT" }, file);
        await fs.rename(moved, filename);
    }
});

test("source identity rejects malformed metadata and versions that cannot form report codeVersion", async (context) => {
    const checkout = await sourceCheckout(context);
    const filename = path.join(checkout.root, "package.json");
    const original = await fs.readFile(filename);
    const invalidVersions = [
        "",
        "source",
        "1.2",
        "01.2.3",
        "1.2.3-01",
        "1.2.3-alpha..1",
        "1.2.3+existing",
        "1.2.3\n",
        "1.2.3\r\n",
        `1.2.3-${"a".repeat(82)}`,
    ];
    for (const bytes of [
        "{",
        "null",
        "[]",
        "{}",
        '{"version":1}',
        ...invalidVersions.map((version) => JSON.stringify({ version })),
    ]) {
        await fs.writeFile(filename, bytes);
        assert.throws(
            checkout.getSourceIdentity,
            /invalid_source_metadata: package\.json/,
            bytes,
        );
    }
    const longestVersion = `1.2.3-${"a".repeat(81)}`;
    await fs.writeFile(filename, JSON.stringify({ version: longestVersion }));
    assert.equal(checkout.getSourceIdentity().codeVersion.length, 100);
    await fs.writeFile(filename, original);
    for (const bytes of [
        "{",
        "null",
        "[]",
        "{}",
        '{"lockfileVersion":"3"}',
        '{"lockfileVersion":0}',
        '{"lockfileVersion":1.5}',
    ]) {
        await fs.writeFile(
            path.join(checkout.root, "package-lock.json"),
            bytes,
        );
        assert.throws(
            checkout.getSourceIdentity,
            /invalid_source_metadata: package-lock\.json/,
            bytes,
        );
    }
});

test("contracts keep one runtime identity snapshot while the helper detects later checkout changes", async (context) => {
    const checkout = await sourceCheckout(context);
    const contractsPath = path.join(
        checkout.root,
        "src",
        "core",
        "contracts.ts",
    );
    await fs.copyFile(
        new URL("../../src/core/contracts.ts", import.meta.url),
        contractsPath,
    );
    const contractsUrl = pathToFileURL(contractsPath).href;
    const contracts: typeof import("../../src/core/contracts.ts") =
        await import(contractsUrl);
    const codeVersion = contracts.CODE_VERSION;
    assert.equal(codeVersion, checkout.getSourceIdentity().codeVersion);
    await fs.appendFile(path.join(checkout.root, "package-lock.json"), "\n");
    assert.notEqual(checkout.getSourceIdentity().codeVersion, codeVersion);
    assert.equal(contracts.CODE_VERSION, codeVersion);
    assert.equal((await import(contractsUrl)).CODE_VERSION, codeVersion);
});
