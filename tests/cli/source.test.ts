import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getSourceIdentity } from "../../src/core/source-revision.ts";
import { buildView, publishResult } from "../../src/core/artifacts.ts";
import { resultEnvelope } from "../core/storage-fixtures.ts";
import {
    fakeGhEnvironment,
    ghInvocations,
    installFakeGh,
} from "../fixtures/gh.ts";

const cli = resolve("src/cli.ts");
const networkBlocker = pathToFileURL(
    resolve("tests/fixtures/network-block.mjs"),
).href;
async function workspace(): Promise<string> {
    const directory = join(process.cwd(), ".test-tmp");
    await mkdir(directory, { recursive: true });
    const root = await mkdtemp(join(directory, "cli-"));
    await installFakeGh(root);
    return root;
}
function invoke(
    root: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
): {
    status: number | null;
    output: Record<string, unknown>;
    stdout: string;
    stderr: string;
} {
    const result = spawnSync(
        process.execPath,
        ["--import", networkBlocker, cli, ...args],
        {
            cwd: root,
            encoding: "utf8",
            timeout: 30000,
            env: {
                ...process.env,
                GITHUB_ADMIN_TOKEN: "",
                GITHUB_TOKEN: "",
                GH_TOKEN: "",
                HTTPS_PROXY: "http://127.0.0.1:1",
                HTTP_PROXY: "http://127.0.0.1:1",
                ...fakeGhEnvironment(root),
                ...env,
            },
        },
    );
    if (result.error) throw result.error;
    return {
        status: result.status,
        output: JSON.parse(result.stdout) as Record<string, unknown>,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}
const ids = [
    "repository-activity-inventory",
    "repository-billing-report",
    "repository-settings-audit",
];

test("native source catalog exposes only the three implemented read-only scenarios", async () => {
    const root = await workspace();
    try {
        const result = invoke(root, ["scenarios", "list"]);
        assert.equal(result.status, 0);
        const catalog: unknown = result.output;
        assert.ok(Array.isArray(catalog));
        assert.deepEqual(
            catalog.map((item) => item.id).sort(),
            [...ids].sort(),
        );
        for (const item of catalog) assert.deepEqual(item.modes, ["inspect"]);
        assert.deepEqual(await ghInvocations(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const scenario of ids) {
    for (const [outcome, expected] of [
        ["completed", 0],
        ["partial", 2],
        ["failed", 1],
        ["deferred", 3],
        ["cancelled", 130],
    ] as const) {
        test(`native source ${scenario} synthetic ${outcome}: correct exit and bounded persisted evidence`, async () => {
            const root = await workspace();
            try {
                const result = invoke(root, [
                    "demo",
                    "--scenario",
                    scenario,
                    "--outcome",
                    outcome,
                ]);
                assert.equal(
                    result.status,
                    expected,
                    result.stderr || result.stdout,
                );
                assert.equal(result.output.status, outcome);
                assert.equal(result.output.synthetic, true);
                assert.ok(Buffer.byteLength(result.stdout) <= 65536);
                assert.equal(typeof result.output.runId, "string");
                const replay = invoke(root, [
                    "result",
                    String(result.output.runId),
                    "--view",
                    "summary",
                ]);
                assert.equal(replay.status, 0);
                assert.equal(
                    replay.output.generation,
                    result.output.generation,
                );
                assert.equal(replay.output.status, outcome);
                assert.deepEqual(await ghInvocations(root), []);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
}

test("mutations, unsupported hosts, unapproved live collection and unknown options fail before collection", async () => {
    const root = await workspace();
    try {
        for (const args of [
            ["apply", ids[0]!],
            ["inspect", ids[0]!],
            ["inspect", "offboarding", "--live", "--org", "example-org"],
            ["demo", "--scenario", ids[0]!, "--host", "tenant.ghe.com"],
            ["demo", "--scenario", ids[0]!, "--invented"],
        ])
            assert.equal(invoke(root, args).status, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("two independent synthetic organization configurations retain their targets and policy inputs", async () => {
    const root = await workspace();
    try {
        for (const [org, estate] of [
            ["example-one", "alpha"],
            ["example-two", "beta"],
        ] as const) {
            await writeFile(
                join(root, `${org}.json`),
                JSON.stringify({
                    schemaVersion: "1",
                    org,
                    reportsPath: `reports-${org}`,
                    policyPath: `${org}-policy.json`,
                    ownersPath: `${org}-owners.csv`,
                }),
            );
            await writeFile(
                join(root, `${org}-policy.json`),
                JSON.stringify({
                    schemaVersion: "1",
                    name: org,
                    rules: [
                        {
                            id: "visibility",
                            setting: "visibility",
                            expected:
                                org === "example-one" ? "private" : "public",
                        },
                    ],
                }),
            );
            await writeFile(
                join(root, `${org}-owners.csv`),
                `repository,owner\n${org}/${estate === "alpha" ? "api" : "mobile"},Example Team\n`,
            );
            for (const scenario of ids) {
                const result = invoke(root, [
                    "demo",
                    "--scenario",
                    scenario,
                    "--config",
                    `${org}.json`,
                    "--estate",
                    estate,
                ]);
                assert.equal(result.status, 0, result.stderr);
                assert.ok(result.stdout.includes(org));
                assert.ok(!result.stdout.includes('"example-org/'));
            }
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("native TypeScript entry point reports the exact current source identity without gh authentication", async () => {
    const identity = getSourceIdentity();
    const root = await workspace();
    try {
        const result = spawnSync(
            process.execPath,
            ["--import", networkBlocker, cli, "--version"],
            {
                cwd: root,
                encoding: "utf8",
                env: { ...process.env, ...fakeGhEnvironment(root) },
            },
        );
        if (result.error) throw result.error;
        assert.equal(result.status, 0);
        assert.match(result.stdout, /^\d+\.\d+\.\d+\+[a-f0-9]{12}\n$/);
        assert.equal(result.stdout, `${identity.codeVersion}\n`);
        assert.deepEqual(await ghInvocations(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("native source resume retries recoverable work, refresh is explicit, and the root allowance is never reset", async () => {
    const root = await workspace();
    try {
        const partial = invoke(root, [
            "demo",
            "--scenario",
            ids[0]!,
            "--outcome",
            "partial",
        ]);
        assert.equal(partial.status, 2, partial.stderr);
        const runId = String(partial.output.runId);
        const resumed = invoke(root, ["resume", runId]);
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(resumed.output.runId, runId);
        assert.notEqual(resumed.output.generation, partial.output.generation);
        assert.deepEqual(
            resumed.output.time &&
                (resumed.output.time as { startedAt: string }).startedAt,
            partial.output.time &&
                (partial.output.time as { startedAt: string }).startedAt,
        );
        const noDecision = invoke(root, ["refresh", runId]);
        assert.equal(noDecision.status, 1);
        const refreshed = invoke(root, ["refresh", runId, "--fresh"]);
        assert.equal(refreshed.status, 0, refreshed.stderr);
        assert.notEqual(refreshed.output.runId, runId);

        const single = invoke(root, [
            "demo",
            "--scenario",
            ids[0]!,
            "--max-requests",
            "1",
        ]);
        assert.equal(single.status, 0, single.stderr);
        const stopped = invoke(root, [
            "refresh",
            String(single.output.runId),
            "--fresh",
        ]);
        assert.equal(stopped.status, 3, stopped.stderr);
        const granted = invoke(root, [
            "resume",
            String(stopped.output.runId),
            "--additional-requests",
            "1",
            "--allowance-reason",
            "Explicit synthetic retry allowance",
        ]);
        assert.equal(granted.status, 0, granted.stderr);
        const oldGeneration = invoke(root, [
            "result",
            runId,
            "--generation",
            String(partial.output.generation),
        ]);
        assert.equal(oldGeneration.status, 0);
        assert.equal(oldGeneration.output.status, "partial");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("irrelevant options and contradictory settings baselines are rejected explicitly", async () => {
    const root = await workspace();
    try {
        assert.equal(
            invoke(root, [
                "demo",
                "--scenario",
                ids[0]!,
                "--cursor",
                "invented",
            ]).status,
            1,
        );
        assert.equal(
            invoke(root, [
                "doctor",
                "--org",
                "example-org",
                "--scenario",
                "not-implemented",
            ]).status,
            1,
        );
        await writeFile(
            join(root, "baseline.json"),
            JSON.stringify({
                schemaVersion: "1",
                name: "contradictory",
                rules: [
                    { id: "one", setting: "archived", expected: true },
                    { id: "two", setting: "archived", expected: false },
                ],
            }),
        );
        assert.equal(
            invoke(root, [
                "demo",
                "--scenario",
                ids[2]!,
                "--policy",
                "baseline.json",
            ]).status,
            1,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("recovery and result commands honor the automatically discovered config output root", async () => {
    const root = await workspace();
    try {
        await mkdir(join(root, "config"));
        await writeFile(
            join(root, "config", "admin-agent.json"),
            JSON.stringify({
                org: "example-org",
                reportsPath: "local-artifacts",
            }),
        );
        const initial = invoke(root, ["demo", "--scenario", ids[0]!]);
        assert.equal(initial.status, 0, initial.stderr);
        const runId = String(initial.output.runId);
        const view = invoke(root, ["result", runId]);
        assert.equal(view.status, 0, view.stderr);
        const resumed = invoke(root, ["resume", runId]);
        assert.equal(resumed.status, 0, resumed.stderr);
        const refreshed = invoke(root, ["refresh", runId, "--fresh"]);
        assert.equal(refreshed.status, 0, refreshed.stderr);
        const unknown = invoke(root, ["demo", "--not-a-real-option"]);
        assert.deepEqual(unknown.output.reasons, ["invalid_option"]);
        const oversized = invoke(root, [
            "demo",
            "--scenario",
            "x".repeat(70000),
        ]);
        assert.equal(oversized.status, 1);
        assert.ok(Buffer.byteLength(oversized.stdout) <= 65536);
        assert.match(String(oversized.output.message), /abbreviated error/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("auth-plan and local doctor are credential-free, readable local commands for every supported scenario", async () => {
    const root = await workspace();
    try {
        for (const id of ids) {
            const plan = invoke(root, ["auth-plan", id, "--org", "example-org"]);
            assert.equal(plan.status, 0, plan.stderr);
            assert.equal(plan.output.status, "planned");
            assert.equal(plan.output.scenario, id);
            assert.equal(plan.output.secretRead, false);
            assert.equal(plan.output.authorizationVerified, false);
            assert.match(plan.stdout, /^\{\n {4}"schemaVersion":/);
            assert.ok(Buffer.byteLength(plan.stdout) <= 65536);
        }
        const doctor = invoke(root, ["doctor", "--org", "example-org"]);
        assert.equal(doctor.status, 0, doctor.stderr);
        assert.equal(doctor.output.status, "completed");
        for (const args of [
            ["auth-plan"],
            ["auth-plan", "not-implemented", "--org", "example-org"],
            ["auth-plan", ids[0]!, "--org", "example-org", "--live"],
            ["auth-plan", ids[0]!, "--org", "example-org", "--no-inventory"],
            ["auth-plan", ids[0]!, "--org", "example-org", "--repo", "other-org/api"],
        ])
            assert.equal(invoke(root, args).status, 1);
        assert.deepEqual(await ghInvocations(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("legacy credential flags/configuration and unauthorized live requests fail before touching gh", async () => {
    const root = await workspace();
    try {
        const legacyFlag = invoke(root, [
            "inspect",
            ids[0]!,
            "--token-env",
            "GITHUB_ADMIN_TOKEN",
        ]);
        assert.deepEqual(legacyFlag.output.reasons, ["legacy_credential_source"]);
        await writeFile(join(root, "legacy.json"), JSON.stringify({
            org: "example-org",
            credential: { tokenEnv: "GITHUB_ADMIN_TOKEN" },
        }));
        const legacyConfig = invoke(root, ["doctor", "--config", "legacy.json"]);
        assert.deepEqual(legacyConfig.output.reasons, ["legacy_credential_source"]);
        for (const [args, reason] of [
            [
                ["inspect", ids[0]!, "--org", "example-org", "--live", "--credential-class", "oauth"],
                "unverified_credential_reach",
            ],
            [
                ["inspect", ids[0]!, "--org", "example-org", "--live", "--profile", "operator-assisted-local"],
                "credential_class_required",
            ],
        ] as const) {
            const result = invoke(root, [...args]);
            assert.equal(result.status, 1);
            assert.deepEqual(result.output.reasons, [reason]);
        }
        assert.deepEqual(await ghInvocations(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an auth plan previews a large declared selection without changing or losing its full scope", async () => {
    const root = await workspace();
    try {
        await writeFile(join(root, "large-selection.json"), JSON.stringify({
            org: "example-org",
            selection: {
                repositories: Array.from(
                    { length: 10000 },
                    (_, index) => `example-org/repository-${index}`,
                ),
            },
        }));
        const result = invoke(root, [
            "auth-plan",
            ids[0]!,
            "--config",
            "large-selection.json",
        ]);
        assert.equal(result.status, 0, result.stderr);
        const scope = result.output.scope;
        assert.ok(scope && typeof scope === "object" && "repositoryCount" in scope);
        assert.equal(scope.repositoryCount, 10000);
        assert.ok("repositoryListComplete" in scope);
        assert.equal(scope.repositoryListComplete, false);
        assert.ok("repositories" in scope && Array.isArray(scope.repositories));
        assert.equal(scope.repositories.length, 25);
        assert.ok(Buffer.byteLength(result.stdout) <= 65536);
        assert.deepEqual(await ghInvocations(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a live authentication failure is actionable and never prints subprocess output or falls back to another token", async () => {
    const root = await workspace();
    try {
        const result = invoke(
            root,
            [
                "inspect",
                ids[0]!,
                "--org",
                "example-org",
                "--live",
                "--profile",
                "operator-assisted-local",
                "--credential-class",
                "oauth",
            ],
            { GITHUB_ADMIN_TEST_GH_MODE: "failure" },
        );
        assert.equal(result.status, 1);
        assert.deepEqual(result.output.reasons, ["gh_auth_failed"]);
        assert.doesNotMatch(
            result.stdout + result.stderr,
            /private-auth-failure|synthetic-gh-credential/,
        );
        assert.equal((await ghInvocations(root)).length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("cancelling private authentication returns the cancellation exit code and no credential", async () => {
    const root = await workspace();
    const child = spawn(
        process.execPath,
        [
            "--import",
            networkBlocker,
            cli,
            "inspect",
            ids[0]!,
            "--org",
            "example-org",
            "--live",
            "--profile",
            "operator-assisted-local",
            "--credential-class",
            "oauth",
        ],
        {
            cwd: root,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                ...fakeGhEnvironment(root),
                GH_TOKEN: "",
                GITHUB_TOKEN: "",
                GITHUB_ADMIN_TEST_GH_MODE: "hang",
            },
        },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !(await ghInvocations(root)).length)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal((await ghInvocations(root)).length, 1);
        child.kill("SIGTERM");
        assert.equal(await closed, 130, stderr || stdout);
        assert.equal(JSON.parse(stdout).status, "cancelled");
        assert.deepEqual(JSON.parse(stdout).reasons, ["operator_cancelled"]);
        assert.doesNotMatch(stdout + stderr, /synthetic-gh-credential/);
    } finally {
        if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        await closed;
        await rm(root, { recursive: true, force: true });
    }
});

test("readable four-space output uses compact JSON only when the complete result view would exceed 64 KiB", async () => {
    const root = await workspace();
    try {
        const envelope = resultEnvelope(500);
        for (const row of envelope.result.rows)
            row.detail = Array.from({ length: 10 }, (_, index) => ({
                index,
                description: "x".repeat(300),
            }));
        const expected = buildView(envelope, { view: "rows", limit: 500 });
        assert.ok(
            Buffer.byteLength(JSON.stringify(expected, null, 4)) > 65536,
            "Regression fixture must actually exceed the pretty-printed stdout limit",
        );
        assert.ok(Buffer.byteLength(JSON.stringify(expected)) <= 65536);
        await publishResult(root, "reports", envelope);
        const result = invoke(root, [
            "result",
            envelope.runId,
            "--view",
            "rows",
            "--limit",
            "500",
        ]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, JSON.stringify(expected));
        assert.deepEqual(result.output, expected);
        assert.ok(Buffer.byteLength(result.stdout) <= 65536);
        assert.deepEqual(await ghInvocations(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
