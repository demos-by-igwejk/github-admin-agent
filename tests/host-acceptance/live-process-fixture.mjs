import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { getSourceIdentity } from "../../src/core/source-revision.ts";
import { scenarios } from "../../src/scenarios/index.ts";

const mode = process.env.GITHUB_ADMIN_TEST_LIVE_MODE;
assert.ok(
    [
        "matching",
        "base-version",
        "base-envelope",
        "wrong-envelope",
        "during-command",
        "between-commands",
    ].includes(mode),
);
const identity = getSourceIdentity();
const scenario = "repository-activity-inventory";
const views = new Map();
const digest = (text) => createHash("sha256").update(text).digest("hex");
const mutate = () =>
    fs.appendFileSync(
        "src/cli.ts",
        "\n// Deliberate unit-test source mutation.\n",
    );
const writeFile = fs.promises.writeFile;
fs.promises.writeFile = async (...args) => {
    const result = await writeFile(...args);
    if (
        mode === "between-commands" &&
        String(args[0]).endsWith("-version.stderr.txt")
    )
        mutate();
    return result;
};
const response = (stdout) => ({
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
});

// No subprocess or request is executed: this fixture supplies explicitly invented contract records.
childProcess.spawnSync = (executable, argv, options) => {
    assert.equal(executable, process.execPath);
    assert.equal(argv[0], "src/cli.ts");
    assert.equal(options.cwd, process.cwd());
    assert.equal(options.shell, false);
    fs.appendFileSync(
        "test-only-invocations.jsonl",
        `${JSON.stringify(argv)}\n`,
    );
    const command = argv[1];
    if (command === "--version") {
        assert.deepEqual(argv, ["src/cli.ts", "--version"]);
        if (mode === "during-command") mutate();
        return response(
            `${mode === "base-version" ? identity.codeVersion.split("+")[0] : identity.codeVersion}\n`,
        );
    }
    if (command === "scenarios") {
        assert.deepEqual(argv, ["src/cli.ts", "scenarios", "list"]);
        return response(JSON.stringify(scenarios.map((item) => item.manifest)));
    }
    if (command === "result") {
        const record = views.get(argv[2]);
        assert.ok(
            record,
            "Result verification must reference this test invocation",
        );
        assert.deepEqual(argv, [
            "src/cli.ts",
            "result",
            record.view.runId,
            "--reports",
            record.reports,
            "--generation",
            record.view.generation,
        ]);
        return response(JSON.stringify(record.view));
    }
    assert.ok(
        ["doctor", "inspect"].includes(command),
        "No unreviewed command may reach the subprocess boundary",
    );
    const { values, positionals } = parseArgs({
        args: argv.slice(2),
        strict: true,
        allowPositionals: true,
        options: {
            live: { type: "boolean" },
            repo: { type: "string", multiple: true },
            ...Object.fromEntries(
                [
                    "scenario",
                    "config",
                    "org",
                    "host",
                    "profile",
                    "credential-class",
                    "reports",
                    "max-requests",
                    "max-elapsed-ms",
                ].map((name) => [name, { type: "string" }]),
            ),
        },
    });
    assert.deepEqual(positionals, command === "doctor" ? [] : [scenario]);
    assert.equal(values.scenario, command === "doctor" ? scenario : undefined);
    assert.equal(values.config, "test-only-config.json");
    assert.equal(values.org, "example-org");
    assert.equal(values.host, "github.com");
    assert.equal(values.live, true);
    assert.equal(values.profile, "operator-assisted-local");
    assert.equal(values["credential-class"], "classic-pat");
    assert.deepEqual(values.repo, ["example-org/api"]);
    assert.equal(values["max-requests"], command === "doctor" ? "40" : "39");
    assert.equal(
        values["max-elapsed-ms"],
        command === "doctor" ? "120000" : "119999",
    );
    assert.match(
        values.reports,
        /^reports\/live-acceptance\/[a-z0-9-]+\/runs$/,
    );

    const runId = `test-only-${command}`;
    const generation = "test-generation";
    const relative = `${runId}/generations/${generation}`;
    const directory = path.join(values.reports, relative);
    fs.mkdirSync(directory, { recursive: true });
    const codeVersion =
        mode === "base-envelope"
            ? identity.codeVersion.split("+")[0]
            : mode === "wrong-envelope"
              ? `${identity.codeVersion.slice(0, -1)}${identity.codeVersion.endsWith("0") ? "1" : "0"}`
              : identity.codeVersion;
    const envelope = {
        testOnly: "Invented unit-test record, not live API evidence.",
        synthetic: false,
        host: "github.com",
        scope: { org: "example-org" },
        scenario,
        codeVersion,
        runId,
        generation,
        status: "completed",
        exitCode: 0,
        reasons: [],
        identity: {
            profile: "operator-assisted-local",
            credentialClass: "classic-pat",
            writeReach: "unknown",
            scopeVerified: false,
        },
        assurance: { population: "unverified", finality: "not-applicable" },
        result: { coverage: { discovery: "complete" } },
        budget: { attempts: 1, elapsedMs: 1 },
        evidence: [
            {
                id: "test-only-evidence",
                source: "https://api.github.com/orgs/example-org/repos",
                operation: "repositories.list",
                target: "example-org",
                observedAt: "2026-09-15T12:00:00.000Z",
                synthetic: false,
            },
        ],
    };
    const text = JSON.stringify(envelope);
    fs.writeFileSync(path.join(directory, "result.json"), text);
    fs.writeFileSync(
        path.join(directory, "manifest.json"),
        JSON.stringify({
            data: {
                publication: "committed",
                runId,
                generation,
                files: {
                    "result.json": {
                        sha256: digest(text),
                        bytes: Buffer.byteLength(text),
                    },
                },
            },
        }),
    );
    const view = {
        runId,
        generation,
        synthetic: false,
        scenario,
        status: "completed",
        artifacts: {
            result: `${relative}/result.json`,
            manifest: `${relative}/manifest.json`,
        },
    };
    views.set(runId, { view, reports: values.reports });
    return response(JSON.stringify(view));
};
syncBuiltinESMExports();
