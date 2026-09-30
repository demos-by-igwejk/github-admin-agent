import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
    checkoutIdentity,
    runCheckout,
    sourceCheckout,
} from "../cli/source-checkout.ts";

const capturePath = "reports/live-acceptance/captures";
const scenario = "repository-activity-inventory";
const reportSchema = z.object({
    status: z.string(),
    errorCode: z.string().nullable(),
    liveAcceptance: z.literal("pending-independent-review"),
    fullReleaseCertification: z.literal("pending"),
    versions: z.object({
        code: z.string(),
        sourceSha256: z.string(),
        bundleSha256: z.never().optional(),
    }),
    commands: z.array(
        z.object({ label: z.string(), argv: z.array(z.string()) }),
    ),
    allowance: z.object({
        remainingAttempts: z.number(),
        remainingElapsedMs: z.number(),
    }),
});

test("live harness source identity and subprocess contracts are exercised only with offline test doubles", async (context) => {
    const root = await sourceCheckout(context);
    const initialized = runCheckout(root, [
        "src/cli.ts",
        "demo",
        "--scenario",
        scenario,
    ]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const identity = checkoutIdentity(root);
    await mkdir(join(root, capturePath), { recursive: true });
    await writeFile(
        join(root, "test-only-config.json"),
        JSON.stringify({ org: "example-org" }),
    );
    const evidence =
        "Invented unit-test grant record. Not a real grant review or live API acceptance.";
    const evidencePath = `${capturePath}/test-only-grants.txt`;
    await writeFile(join(root, evidencePath), evidence);
    await writeFile(
        join(root, capturePath, "test-only-grants.json"),
        JSON.stringify({
            schemaVersion: "1",
            host: "github.com",
            org: "example-org",
            credentialClass: "classic-pat",
            accountRole: "test-only",
            declaredGrants: ["test-only"],
            declaredWriteReach: "unknown",
            basis: "operator-declared",
            reviewedAt: "2026-09-15T12:00:00.000Z",
            reviewer: "unit-test fixture",
            evidence: [
                {
                    path: evidencePath,
                    sha256: createHash("sha256").update(evidence).digest("hex"),
                },
            ],
        }),
    );
    const preload = join(
        root,
        "tests/host-acceptance/live-process-fixture.mjs",
    );
    await cp(new URL("./live-process-fixture.mjs", import.meta.url), preload);
    const invoke = (mode: string, script = "scripts/live-acceptance.mjs") =>
        runCheckout(
            root,
            [
                "--import",
                pathToFileURL(preload).href,
                script,
                "--live",
                "--org",
                "example-org",
                "--scope",
                "organization",
                "--scenario",
                scenario,
                "--repo",
                "example-org/api",
                "--config",
                "test-only-config.json",
                "--profile",
                "operator-assisted-local",
                "--credential-class",
                "classic-pat",
                "--grant-record",
                `${capturePath}/test-only-grants.json`,
            ],
            {
                GITHUB_ADMIN_LIVE_ACCEPTANCE: "1",
                GITHUB_ADMIN_TEST_LIVE_MODE: mode,
            },
        );
    const readReport = async (stdout: string) => {
        const output = z
            .object({ report: z.string() })
            .parse(JSON.parse(stdout));
        return reportSchema.parse(
            JSON.parse(await readFile(join(root, output.report), "utf8")),
        );
    };

    await context.test(
        "the executing checkout and source identity root must match",
        () => {
            const result = invoke(
                "matching",
                fileURLToPath(
                    new URL(
                        "../../scripts/live-acceptance.mjs",
                        import.meta.url,
                    ),
                ),
            );
            assert.equal(result.status, 1);
            assert.match(result.stderr, /acceptance_source_checkout_required/);
            assert.equal(result.stdout, "");
        },
    );

    await context.test(
        "matching full source versions reach the scoped doctor, inspect, and result checks",
        async () => {
            const result = invoke("matching");
            assert.equal(result.status, 0, result.stderr || result.stdout);
            const report = await readReport(result.stdout);
            assert.equal(report.status, "observations-recorded");
            assert.equal(report.errorCode, null);
            assert.equal(report.versions.code, identity.codeVersion);
            assert.equal(report.versions.sourceSha256, identity.sourceSha256);
            assert.deepEqual(
                report.commands.map((command) => command.label),
                [
                    "version",
                    "catalog",
                    "doctor",
                    "doctor-verify",
                    "inspect",
                    "inspect-verify",
                ],
            );
            assert.ok(
                report.commands.every(
                    (command) => command.argv[0] === "src/cli.ts",
                ),
            );
            assert.deepEqual(report.allowance, {
                remainingAttempts: 38,
                remainingElapsedMs: 119998,
            });
        },
    );

    await context.test(
        "bare or different revision versions fail instead of comparing only the package base",
        async () => {
            for (const mode of [
                "base-version",
                "base-envelope",
                "wrong-envelope",
            ]) {
                const result = invoke(mode);
                assert.equal(result.status, 1);
                const report = await readReport(result.stdout);
                assert.equal(report.status, "failed");
                assert.equal(
                    report.errorCode,
                    mode === "base-version"
                        ? "source_version_mismatch"
                        : "envelope_scope_or_version_mismatch",
                );
                assert.ok(
                    !report.commands.some(
                        (command) => command.label === "inspect",
                    ),
                );
            }
        },
    );

    for (const mode of ["during-command", "between-commands"]) {
        await context.test(
            `source changes ${mode} stop before another subprocess and never publish acceptance`,
            async () => {
                const sourcePath = join(root, "src/cli.ts");
                const original = await readFile(sourcePath, "utf8");
                const before = new Set(
                    await readdir(join(root, "reports/live-acceptance")),
                );
                await writeFile(join(root, "test-only-invocations.jsonl"), "");
                try {
                    const result = invoke(mode);
                    assert.equal(result.status, 1);
                    assert.match(
                        result.stderr,
                        /source_changed_during_acceptance/,
                    );
                    assert.equal(result.stdout, "");
                    const invocations = (
                        await readFile(
                            join(root, "test-only-invocations.jsonl"),
                            "utf8",
                        )
                    )
                        .trim()
                        .split("\n")
                        .map((line) => JSON.parse(line));
                    assert.deepEqual(invocations, [
                        ["src/cli.ts", "--version"],
                    ]);
                    const created = (
                        await readdir(join(root, "reports/live-acceptance"))
                    ).filter((name) => !before.has(name));
                    assert.equal(created.length, 1);
                    const files = await readdir(
                        join(root, "reports/live-acceptance", created[0]!),
                    );
                    assert.deepEqual(
                        files.sort(),
                        mode === "during-command"
                            ? []
                            : [
                                  "01-version.stderr.txt",
                                  "01-version.stdout.txt",
                              ],
                    );
                } finally {
                    await writeFile(sourcePath, original);
                }
            },
        );
    }
});
