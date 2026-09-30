import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { publishResult } from "../../src/core/artifacts.ts";
import { readJsonInput, resolveSafePath } from "../../src/core/paths.ts";
import { resultEnvelope, temporaryProject } from "./storage-fixtures.ts";

test("contained paths reject traversal, foreign absolutes, special objects and symlinks", async (context) => {
    const root = await temporaryProject(context, "paths");
    await fs.mkdir(path.join(root, "inputs"));
    await fs.writeFile(path.join(root, "inputs", "data.json"), '{"ok":true}');
    assert.equal(
        await resolveSafePath(root, "./inputs/data.json", { mustExist: true }),
        path.join(root, "inputs", "data.json"),
    );
    assert.equal(await resolveSafePath(root, root, { directory: true }), root);
    assert.equal(
        await resolveSafePath(root, "missing/nested.json"),
        path.join(root, "missing", "nested.json"),
    );
    assert.equal(
        await resolveSafePath(root, "reports", { directory: true }),
        path.join(root, "reports"),
    );
    await assert.rejects(fs.stat(path.join(root, "reports")), /ENOENT/);
    for (const relative of [
        "../escape",
        "inputs/../data.json",
        "/etc/passwd",
        "C:\\secrets",
        "\\\\host\\share",
        "",
        "a\0b",
    ]) {
        await assert.rejects(resolveSafePath(root, relative), /unsafe_path/);
    }
    await assert.rejects(
        resolveSafePath(root, "inputs/data.json", { directory: true }),
        /directory/,
    );
    await assert.rejects(readJsonInput(root, "."), /file/);
    await assert.rejects(
        resolveSafePath(root, "missing/file", { mustExist: true }),
        /ENOENT/,
    );
    await fs.symlink(path.join(root, "inputs"), path.join(root, "linked"));
    await assert.rejects(readJsonInput(root, "linked/data.json"), /symlink/i);
    await fs.symlink(
        path.join(root, "inputs", "data.json"),
        path.join(root, "data.json"),
    );
    await assert.rejects(readJsonInput(root, "data.json"), /symlink/i);
    await fs.symlink(root, path.join(root, "alias"));
    await assert.rejects(
        resolveSafePath(path.join(root, "alias"), "inputs/data.json"),
        /symlink/i,
    );
});

test("JSON input is strict UTF-8 with duplicate-key, malformed-number and BOM rejection", async (context) => {
    const root = await temporaryProject(context, "json-input");
    await fs.writeFile(
        path.join(root, "valid.json"),
        '{"version":1,"values":[true,null,"exact"]}',
    );
    assert.deepEqual(await readJsonInput(root, "valid.json"), {
        version: 1,
        values: [true, null, "exact"],
    });
    for (const [index, value] of [
        '{"a":1,"a":2}',
        '{"n":1e400}',
        '{"n":9007199254740993}',
        '{"a":1,}',
        "//comment\n{}",
        "\uFEFF{}",
    ].entries()) {
        await fs.writeFile(path.join(root, `${index}.json`), value);
        await assert.rejects(
            readJsonInput(root, `${index}.json`),
            /invalid_json/,
        );
    }
    await fs.writeFile(
        path.join(root, "invalid-utf8.json"),
        Buffer.from([0xff, 0x7b, 0x7d]),
    );
    await assert.rejects(readJsonInput(root, "invalid-utf8.json"), /UTF-8/);
});

test("report ownership prevents workspace reuse, output collisions and symlink destinations", async (context) => {
    const root = await temporaryProject(context, "output-paths");
    const envelope = resultEnvelope();
    await assert.rejects(
        publishResult(root, ".", envelope),
        /unsafe_reports_path/,
    );
    await assert.rejects(
        publishResult(root, root, envelope),
        /unsafe_reports_path/,
    );
    for (const name of [
        "src",
        "config",
        "node_modules",
        ".git",
        "SRC",
        "CONFIG",
    ]) {
        await assert.rejects(
            publishResult(root, name, envelope),
            /unsafe_reports_path/,
        );
    }
    await fs.mkdir(path.join(root, "existing"));
    await fs.writeFile(path.join(root, "existing", "keep.txt"), "input");
    await assert.rejects(
        publishResult(root, "existing", envelope),
        /output_collision/,
    );
    assert.equal(
        await fs.readFile(path.join(root, "existing", "keep.txt"), "utf8"),
        "input",
    );
    await fs.writeFile(path.join(root, "file"), "input");
    await assert.rejects(publishResult(root, "file", envelope), /directory/);
    await fs.mkdir(path.join(root, "target"));
    await fs.symlink(path.join(root, "target"), path.join(root, "reports"));
    await assert.rejects(publishResult(root, "reports", envelope), /symlink/i);
});

test("managed reports and files have restrictive permissions", async (context) => {
    const root = await temporaryProject(context, "permissions");
    const published = await publishResult(root, "reports", resultEnvelope());
    if (process.platform !== "win32") {
        for (const directory of [
            path.join(root, "reports"),
            published.directory,
            path.join(published.directory, "evidence"),
        ]) {
            assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        }
        for (const filename of [
            published.manifestPath,
            path.join(published.directory, "result.json"),
            path.join(root, "reports", "test-run", "current.json"),
        ]) {
            assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
        }
    }
});
