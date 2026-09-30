import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
    checkoutIdentity,
    runCheckout,
    sourceCheckout,
} from "../cli/source-checkout.ts";

const scenarioIds = [
    "repository-activity-inventory",
    "repository-billing-report",
    "repository-settings-audit",
];
const corpusSchema = z.object({
    schemaVersion: z.literal("2"),
    version: z.literal("3.0.0"),
    surfaces: z.array(z.enum(["copilot-cli", "vscode", "copilot-app"])),
    cases: z.array(
        z.object({
            id: z.string(),
            prompt: z.string(),
            category: z.enum([
                "normal",
                "ambiguous",
                "unsupported",
                "approval-denial",
            ]),
            expected: z.object({
                intent: z.enum(["execute", "clarify", "refuse", "denied"]),
                scenario: z.string().optional(),
                argv: z.array(z.string()).optional(),
                status: z.string().optional(),
                exitCode: z.number().optional(),
                exactValues: z
                    .array(
                        z.object({
                            repository: z.string().nullable(),
                            sku: z.string(),
                            field: z.string(),
                            value: z.string(),
                        }),
                    )
                    .optional(),
            }),
        }),
    ),
});
interface Reference {
    path: string;
    sha256: string;
    format?: "text" | "png" | "jpeg";
}
interface Command {
    argv: string[];
    approval: "approved" | "denied";
    approvalSource?: "manual" | "exact-help-rule";
    executed: boolean;
    approvalReceipt: Reference;
    executionReceipt?: Reference;
    stdoutReceipt?: Reference;
    exitCode?: number;
}
const digest = (value: string | Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
const capturePath = "reports/host-acceptance/captures";
const batchPath = `${capturePath}/test-only-batch.json`;
const reportSchema = z.object({
    schemaVersion: z.literal("2"),
    status: z.string(),
    hostAcceptance: z.literal("pending-independent-review"),
    target: z.object({
        surface: z.enum(["copilot-cli", "vscode", "copilot-app"]),
        harness: z.enum(["copilot-cli", "local", "copilot"]),
        platform: z.enum(["linux", "darwin"]),
        workspaceMode: z.enum(["local-repository", "local-worktree"]),
    }),
    imageReceiptsRequiringReview: z.array(z.string()),
    reportedSafetyViolations: z.number(),
    rounds: z.array(
        z.object({
            codeVersion: z.string(),
            sourceSha256: z.string(),
            adapterSha256: z.string(),
            surface: z.enum(["copilot-cli", "vscode", "copilot-app"]),
            harness: z.enum(["copilot-cli", "local", "copilot"]),
            cases: z.array(
                z.object({
                    id: z.string(),
                    errors: z.array(z.string()),
                    safety: z.array(z.string()),
                }),
            ),
        }),
    ),
});

async function fixtures(context: TestContext) {
    const root = await sourceCheckout(context);
    const initialized = runCheckout(root, [
        "src/cli.ts",
        "demo",
        "--scenario",
        scenarioIds[0]!,
    ]);
    assert.equal(initialized.status, 0, initialized.stderr);
    await mkdir(join(root, capturePath), { recursive: true });
    const corpusText = await readFile(
        join(root, "tests/host-acceptance/intent-corpus.json"),
        "utf8",
    );
    const corpus = corpusSchema.parse(JSON.parse(corpusText));
    const identity = checkoutIdentity(root);
    const hostIdentity = runCheckout(root, [
        "scripts/host-acceptance.mjs",
        "--identity",
    ]);
    assert.equal(hostIdentity.status, 0, hostIdentity.stderr);
    const { adapterSha256 } = z.object({
        adapterSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).parse(JSON.parse(hostIdentity.stdout));
    const capture = async (
        name: string,
        content: string,
    ): Promise<Reference> => {
        const filename = `${capturePath}/${name}`;
        await writeFile(join(root, filename), content);
        return { path: filename, sha256: digest(content) };
    };
    const note =
        "INVENTED UNIT-TEST DATA. Not a real Copilot session, approval, denial, or acceptance receipt.";
    const metadata = await capture(
        "test-only-metadata.txt",
        [
            note,
            "copilot --agent github-admin",
            "test-copilot",
            "test-vscode",
            "test-extension",
            "test-app",
            "test-runtime",
            process.version,
            "test-model",
            "normal",
            "Local",
            "Copilot",
            "Folder",
            "Manual permissions",
            "Interactive",
            ".github/agents/github-admin.agent.md",
            ".github/copilot-instructions.md",
            ...scenarioIds.map((id) => `.github/skills/${id}/SKILL.md`),
        ].join("\n"),
    );
    const rounds = [];
    for (const number of [1, 2]) {
        const cases = [];
        for (const item of corpus.cases) {
            const runId = `test-round${number}-${item.id}`;
            const transcript = await capture(
                `round${number}-${item.id}.transcript.txt`,
                `${note}\n${runId}\n${item.prompt}\n`,
            );
            const exact = item.expected.exactValues ?? [];
            const response = await capture(
                `round${number}-${item.id}.response.txt`,
                [
                    note,
                    ...exact.map(
                        (value) =>
                            `${value.repository ?? "unattributed"}|${value.sku}|${value.field}=${value.value}`,
                    ),
                ].join("\n"),
            );
            const commands: Command[] = [];
            if (item.category === "normal") {
                assert.ok(
                    item.expected.argv &&
                        item.expected.scenario &&
                        item.expected.status &&
                        item.expected.exitCode !== undefined,
                );
                const rows = new Map<string, Record<string, string | null>>();
                for (const value of exact) {
                    const key = JSON.stringify([value.repository, value.sku]);
                    const row = rows.get(key) ?? {
                        repository: value.repository,
                        sku: value.sku,
                    };
                    row[value.field] = value.value;
                    rows.set(key, row);
                }
                const stdout = await capture(
                    `round${number}-${item.id}.stdout.json`,
                    JSON.stringify({
                        testOnly: note,
                        runId,
                        synthetic: true,
                        scenario: item.expected.scenario,
                        status: item.expected.status,
                        assurance: {
                            population: "unverified",
                            finality:
                                item.expected.scenario ===
                                "repository-billing-report"
                                    ? "unknown"
                                    : "not-applicable",
                        },
                        rows: [...rows.values()],
                    }),
                );
                commands.push({
                    argv: [...item.expected.argv],
                    approval: "approved",
                    executed: true,
                    approvalReceipt: metadata,
                    executionReceipt: metadata,
                    stdoutReceipt: stdout,
                    exitCode: item.expected.exitCode,
                });
            } else if (item.category === "approval-denial") {
                assert.ok(item.expected.argv);
                commands.push({
                    argv: [...item.expected.argv],
                    approval: "denied",
                    executed: false,
                    approvalReceipt: metadata,
                });
            }
            cases.push({
                id: item.id,
                observedIntent: item.expected.intent,
                promptReceipt: transcript,
                transcriptReceipt: transcript,
                responseReceipt: response,
                toolAuditReceipt: metadata,
                ...(item.expected.scenario ? { skillLoadReceipt: metadata } : {}),
                commands,
            });
        }
        rounds.push({
            id: `test-round${number}`,
            startedAt: "2026-09-15T12:00:00.000Z",
            completedAt: "2026-09-15T12:01:00.000Z",
            surface: "copilot-cli",
            harness: "copilot-cli",
            platform: "linux",
            workspace: { mode: "local-repository", receipt: metadata },
            launch: {
                kind: "terminal",
                argv: ["copilot", "--agent", "github-admin"],
                receipt: metadata,
            },
            client: { value: "test-copilot", receipt: metadata },
            node: { value: process.version, receipt: metadata },
            model: {
                value: "test-model",
                basis: "declared",
                receipt: metadata,
            },
            ...identity,
            adapterSha256,
            discoveryReceipt: metadata,
            approvalMode: { value: "normal", receipt: metadata },
            cases,
        });
    }
    return {
        root,
        identity,
        adapterSha256,
        batch: {
            schemaVersion: "2",
            corpusVersion: corpus.version,
            corpusSha256: digest(corpusText),
            reviewer: note,
            rounds,
        },
    };
}

async function validate(root: string, batch: unknown, preload?: string) {
    await writeFile(join(root, batchPath), JSON.stringify(batch));
    return runCheckout(
        root,
        [
            ...(preload ? ["--import", pathToFileURL(preload).href] : []),
            "scripts/host-acceptance.mjs",
            "--opt-in",
            "--receipts",
            batchPath,
        ],
        { GITHUB_ADMIN_HOST_ACCEPTANCE: "1" },
    );
}

async function report(root: string, stdout: string) {
    const output = z.object({ report: z.string() }).parse(JSON.parse(stdout));
    return reportSchema.parse(
        JSON.parse(await readFile(join(root, output.report), "utf8")),
    );
}

test("test-only host receipt fixtures verify source binding and narrow execution without claiming host acceptance", async (context) => {
    const fixture = await fixtures(context);
    const { root, batch, identity, adapterSha256 } = fixture;

    await context.test("importing receipts requires both explicit opt-ins", () => {
        for (const [args, env] of [
            [
                ["scripts/host-acceptance.mjs", "--receipts", batchPath],
                { GITHUB_ADMIN_HOST_ACCEPTANCE: "1" },
            ],
            [
                ["scripts/host-acceptance.mjs", "--opt-in", "--receipts", batchPath],
                { GITHUB_ADMIN_HOST_ACCEPTANCE: "" },
            ],
        ] as const) {
            const result = runCheckout(root, [...args], env);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /host_acceptance_opt_in_required/);
            assert.equal(result.stdout, "");
        }
    });

    await context.test(
        "each GUI surface and VS Code harness retains its actual target and a pending gate",
        async () => {
            for (const target of [
                "vscode-local", "vscode-copilot", "copilot-app", "copilot-app-worktree",
            ] as const) {
                const input = {
                    ...batch,
                    rounds: batch.rounds.map((round) => {
                        const receipt = round.launch.receipt;
                        if (target === "copilot-app" || target === "copilot-app-worktree")
                            return {
                                ...round,
                                surface: "copilot-app",
                                client: { value: "test-app", receipt },
                                copilotRuntime: { value: "test-runtime", receipt },
                                workspace: {
                                    mode: target === "copilot-app-worktree" ? "local-worktree" : "local-repository",
                                    receipt,
                                },
                                launch: {
                                    kind: "ui",
                                    agent: "github-admin",
                                    location: target === "copilot-app-worktree" ? "local-worktree" : "local-repository",
                                    mode: "Interactive",
                                    receipt,
                                },
                            };
                        return {
                            ...round,
                            surface: "vscode",
                            harness: target === "vscode-local" ? "local" : "copilot",
                            client: { value: "test-vscode", receipt },
                            extension: { value: "test-extension", receipt },
                            launch: {
                                kind: "ui",
                                sessionTarget: target === "vscode-local" ? "Local" : "Copilot",
                                agent: "github-admin",
                                isolation: "Folder",
                                permissions: "Manual permissions",
                                receipt,
                            },
                        };
                    }),
                };
                const result = await validate(root, input);
                assert.equal(result.status, 0, result.stderr || result.stdout);
                const output = await report(root, result.stdout);
                assert.equal(output.status, "receipts-validated");
                assert.equal(output.target.surface, target.startsWith("vscode") ? "vscode" : "copilot-app");
                assert.equal(output.target.harness, target === "vscode-local" ? "local" : target === "vscode-copilot" ? "copilot" : "copilot-cli");
                assert.equal(output.target.workspaceMode, target === "copilot-app-worktree" ? "local-worktree" : "local-repository");
                assert.ok(output.rounds.every((round) =>
                    round.surface === output.target.surface &&
                    round.harness === output.target.harness &&
                    round.sourceSha256 === identity.sourceSha256 &&
                    round.adapterSha256 === adapterSha256));
            }
        },
    );

    await context.test(
        "one round on each client, platform, or workspace cannot satisfy a repeated-target study",
        async () => {
            const otherSurface = {
                ...batch,
                rounds: batch.rounds.map((round, index) => index === 0 ? round : ({
                    ...round,
                    surface: "copilot-app",
                    client: { value: "test-app", receipt: round.client.receipt },
                    launch: {
                        kind: "ui",
                        agent: "github-admin",
                        location: "local-repository",
                        mode: "Interactive",
                        receipt: round.launch.receipt,
                    },
                })),
            };
            const otherPlatform = structuredClone(batch);
            otherPlatform.rounds[1]!.platform = "darwin";
            const otherWorkspace = structuredClone(batch);
            otherWorkspace.rounds[1]!.workspace.mode = "local-worktree";
            const otherVersion = structuredClone(batch);
            otherVersion.rounds[1]!.client.value = "different-client-version";
            for (const input of [otherSurface, otherPlatform, otherWorkspace, otherVersion]) {
                const result = await validate(root, input);
                assert.equal(result.status, 1);
                assert.match(result.stderr, /mixed_host_targets_not_allowed/);
                assert.equal(result.stdout, "");
            }
            const oneRound = await validate(root, { ...batch, rounds: [batch.rounds[0]] });
            assert.equal(oneRound.status, 1);
            assert.match(oneRound.stderr, /host_receipt_schema_invalid/);
        },
    );

    await context.test(
        "old receipt schemas, unsupported platforms, and auto-approved or cloud GUI selections fail closed",
        async () => {
            for (const input of [
                { ...batch, schemaVersion: "1" },
                { ...batch, rounds: batch.rounds.map((round) => ({ ...round, platform: "win32" })) },
                {
                    ...batch,
                    rounds: batch.rounds.map((round) => ({
                        ...round,
                        surface: "vscode",
                        harness: "copilot",
                        extension: round.client,
                        launch: {
                            kind: "ui",
                            sessionTarget: "Copilot",
                            agent: "github-admin",
                            isolation: "New Worktree",
                            permissions: "Allow all",
                            receipt: round.launch.receipt,
                        },
                    })),
                },
                {
                    ...batch,
                    rounds: batch.rounds.map((round) => ({
                        ...round,
                        surface: "copilot-app",
                        launch: {
                            kind: "ui",
                            agent: "github-admin",
                            location: "cloud-sandbox",
                            mode: "Autopilot",
                            receipt: round.launch.receipt,
                        },
                    })),
                },
            ]) {
                const result = await validate(root, input);
                assert.equal(result.status, 1);
                assert.match(result.stderr, /host_receipt_schema_invalid/);
                assert.equal(result.stdout, "");
            }
        },
    );

    await context.test(
        "image metadata is integrity-checked, explicitly unreviewed, and never substituted for transcript or stdout text",
        async () => {
            const bytes = Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
                "base64",
            );
            const path = `${capturePath}/test-only-image.png`;
            await writeFile(join(root, path), bytes);
            const image: Reference = { path, sha256: digest(bytes), format: "png" };
            const input = structuredClone(batch);
            input.rounds[0]!.launch.receipt = image;
            input.rounds[0]!.discoveryReceipt = image;
            input.rounds[0]!.cases[0]!.commands[0]!.approvalReceipt = image;
            const result = await validate(root, input);
            assert.equal(result.status, 0, result.stderr || result.stdout);
            const output = await report(root, result.stdout);
            assert.deepEqual(output.imageReceiptsRequiringReview, [path]);
            const badTranscript = structuredClone(input);
            badTranscript.rounds[0]!.cases[0]!.transcriptReceipt = image;
            const rejected = await validate(root, badTranscript);
            assert.equal(rejected.status, 1);
            assert.match(rejected.stderr, /text_receipt_required/);
            const badFormat = await validate(root, {
                ...batch,
                rounds: batch.rounds.map((round) => ({
                    ...round,
                    discoveryReceipt: { ...image, format: "jpeg" },
                })),
            });
            assert.equal(badFormat.status, 1);
            assert.match(badFormat.stderr, /image_receipt_format_invalid/);
            const badStdout = structuredClone(input);
            badStdout.rounds[0]!.cases[0]!.commands[0]!.stdoutReceipt = image;
            const rejectedStdout = await validate(root, badStdout);
            assert.equal(rejectedStdout.status, 1);
            assert.match(rejectedStdout.stderr, /text_receipt_required/);
        },
    );

    await context.test(
        "routing helpers are not collection, and the exact help rule cannot approve a demo",
        async () => {
            const input = structuredClone(batch);
            const demo = input.rounds[0]!.cases[0]!.commands[0]!;
            const catalog = { ...demo, argv: ["node", "src/cli.ts", "scenarios", "list"] };
            const help: Command = {
                ...demo,
                argv: ["node", "src/cli.ts", "inspect", scenarioIds[0]!, "--help"],
                approvalSource: "exact-help-rule",
            };
            for (const id of ["ambiguous-cleanup", "unsupported-archive"]) {
                const item = input.rounds[0]!.cases.find((candidate) => candidate.id === id);
                assert.ok(item);
                item.commands.push(catalog, help);
            }
            const result = await validate(root, input);
            assert.equal(result.status, 0, result.stderr || result.stdout);
            const output = await report(root, result.stdout);
            assert.equal(output.reportedSafetyViolations, 0);
            const invalid = structuredClone(input);
            invalid.rounds[0]!.cases[0]!.commands[0]!.approvalSource = "exact-help-rule";
            const rejected = await validate(root, invalid);
            assert.equal(rejected.status, 1);
            const errors = await report(root, rejected.stdout);
            assert.ok(errors.rounds[0]!.cases[0]!.safety.includes("invalid_approval_source"));
        },
    );

    await context.test(
        "scenario execution needs captured skill loading and denial prohibits later command attempts",
        async () => {
            const missingSkill = structuredClone(batch);
            delete missingSkill.rounds[0]!.cases[0]!.skillLoadReceipt;
            const missing = await validate(root, missingSkill);
            assert.equal(missing.status, 1);
            assert.match(missing.stderr, /scenario_skill_receipt_missing/);
            const input = structuredClone(batch);
            const item = input.rounds[0]!.cases.find((candidate) => candidate.id === "denied-activity");
            assert.ok(item?.commands[0]);
            item.commands.push({ ...item.commands[0] });
            const retry = await validate(root, input);
            assert.equal(retry.status, 1);
            const output = await report(root, retry.stdout);
            assert.ok(output.rounds[0]!.cases.find((candidate) =>
                candidate.id === item.id)?.safety.includes("command_attempted_after_denial"));
        },
    );

    await context.test("receipt content and annotations containing possible tokens are rejected", async () => {
        const result = await validate(root, {
            ...batch,
            reviewer: `ghp_${"a".repeat(30)}`,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /receipt_contains_possible_secret_redact_before_import/);
        assert.equal(result.stdout, "");
    });

    await context.test(
        "the validator cannot bind one checkout while reading receipts from another",
        async () => {
            const result = runCheckout(
                root,
                [
                    fileURLToPath(
                        new URL(
                            "../../scripts/host-acceptance.mjs",
                            import.meta.url,
                        ),
                    ),
                    "--opt-in",
                    "--receipts",
                    batchPath,
                ],
                { GITHUB_ADMIN_HOST_ACCEPTANCE: "1" },
            );
            assert.equal(result.status, 1);
            assert.match(result.stderr, /acceptance_source_checkout_required/);
            assert.equal(result.stdout, "");
        },
    );

    await context.test(
        "the reviewed source command, reordered flags, and recorded-run helpers remain valid",
        async () => {
            const input = structuredClone(batch);
            const first = input.rounds[0]!.cases[0]!;
            const demo = first.commands[0]!;
            demo.argv = [
                "node",
                "src/cli.ts",
                "--scenario",
                scenarioIds[0]!,
                "demo",
                "--outcome",
                "completed",
            ];
            first.commands.unshift({
                ...demo,
                argv: ["node", "src/cli.ts", "scenarios", "list"],
            });
            first.commands.push(
                { ...demo, argv: ["node", "src/cli.ts", "--version"] },
                {
                    ...demo,
                    argv: [
                        "node",
                        "src/cli.ts",
                        "result",
                        `test-round1-${first.id}`,
                        "--view",
                        "rows",
                        "--limit",
                        "10",
                    ],
                },
            );
            const result = await validate(root, input);
            assert.equal(result.status, 0, result.stderr || result.stdout);
            const output = await report(root, result.stdout);
            assert.equal(output.status, "receipts-validated");
            assert.equal(output.target.surface, "copilot-cli");
            assert.equal(output.reportedSafetyViolations, 0);
            for (const round of output.rounds) {
                assert.equal(round.codeVersion, identity.codeVersion);
                assert.equal(round.sourceSha256, identity.sourceSha256);
                assert.equal(round.adapterSha256, adapterSha256);
            }
        },
    );

    await context.test(
        "old bundle receipts and mixed old/new records are rejected by the strict schema",
        async () => {
            for (const keepSource of [false, true]) {
                const input = {
                    ...batch,
                    rounds: batch.rounds.map(({ sourceSha256, ...round }) => ({
                        ...round,
                        ...(keepSource ? { sourceSha256 } : {}),
                        bundleSha256: sourceSha256,
                    })),
                };
                const result = await validate(root, input);
                assert.equal(result.status, 1);
                assert.match(result.stderr, /host_receipt_schema_invalid/);
                assert.equal(result.stdout, "");
            }
        },
    );

    await context.test(
        "the exact revision, full digest, and reviewed corpus are mandatory",
        async () => {
            const bareVersion = structuredClone(batch);
            bareVersion.rounds[0]!.codeVersion =
                identity.codeVersion.split("+")[0]!;
            const wrongSource = structuredClone(batch);
            wrongSource.rounds[0]!.sourceSha256 = "0".repeat(64);
            const wrongAdapter = structuredClone(batch);
            wrongAdapter.rounds[0]!.adapterSha256 = "0".repeat(64);
            for (const [input, expected] of [
                [bareVersion, "code_binding_mismatch"],
                [wrongSource, "code_binding_mismatch"],
                [wrongAdapter, "adapter_binding_mismatch"],
                [
                    { ...batch, corpusVersion: "1.0.0" },
                    "corpus_binding_mismatch",
                ],
                [
                    { ...batch, corpusSha256: "0".repeat(64) },
                    "corpus_binding_mismatch",
                ],
            ] as const) {
                const result = await validate(root, input);
                assert.equal(result.status, 1);
                assert.ok(result.stderr.includes(expected), result.stderr);
                assert.equal(result.stdout, "");
            }
        },
    );

    await context.test(
        "other TS, wrappers, interpreters, shell chains, live collection, and unrecorded results stay forbidden",
        async () => {
            const rejected = [
                ["node", "src/unreviewed.ts"],
                ["node", "scripts/unreviewed.mjs"],
                ["node", "--eval", 'process.stdout.write("not authorized")'],
                [
                    "node",
                    "--import",
                    "scripts/unreviewed.mjs",
                    "src/cli.ts",
                    "--version",
                ],
                [
                    "node",
                    "--input-type=module",
                    "--eval",
                    'import("./src/cli.ts")',
                ],
                ["tsx", "src/cli.ts", "--version"],
                ["npx", "tsx", "src/cli.ts", "--version"],
                ["git", "status"],
                ["curl", "https://api.github.com"],
                ["sh", "-c", "node src/cli.ts --version"],
                [
                    "env",
                    "NODE_OPTIONS=--import=scripts/unreviewed.mjs",
                    "node",
                    "src/cli.ts",
                    "--version",
                ],
                ["node", "dist/cli.js", "--version"],
                [
                    "node",
                    "src/cli.ts",
                    "scenarios",
                    "list",
                    "&&",
                    "node",
                    "src/unreviewed.ts",
                ],
                ["node", "src/cli.ts", "--version", ";", "git", "status"],
                [
                    "node",
                    "src/cli.ts",
                    "demo",
                    "--scenario",
                    scenarioIds[0]!,
                    "--live",
                ],
                [
                    "node",
                    "src/cli.ts",
                    "result",
                    "not-recorded",
                    "--view",
                    "rows",
                ],
                [
                    "node",
                    "src/cli.ts",
                    "result",
                    "RECORDED_RUN",
                    "--view",
                    "rows",
                    "--config",
                    "other.json",
                ],
                [
                    "node",
                    "src/cli.ts",
                    "result",
                    "RECORDED_RUN",
                    "--view",
                    "rows",
                    ";",
                    "node",
                    "src/unreviewed.ts",
                ],
            ];
            const input = structuredClone(batch);
            const normal = input.rounds[0]!.cases.filter(
                (item) => item.observedIntent === "execute",
            );
            for (const [index, argv] of rejected.entries()) {
                const item = normal[index];
                assert.ok(item?.commands[0]);
                const command =
                    argv[2] === "demo"
                        ? [...item.commands[0].argv, "--live"]
                        : argv.map((value) =>
                              value === "RECORDED_RUN"
                                  ? `test-round1-${item.id}`
                                  : value,
                          );
                item.commands.push({ ...item.commands[0], argv: command });
            }
            const result = await validate(root, input);
            assert.equal(result.status, 1);
            const output = await report(root, result.stdout);
            assert.equal(output.status, "receipt-errors");
            assert.equal(output.reportedSafetyViolations, rejected.length);
            for (const item of normal.slice(0, rejected.length)) {
                const evaluated = output.rounds[0]!.cases.find(
                    (candidate) => candidate.id === item.id,
                );
                assert.ok(
                    evaluated?.safety.includes("unreviewed_command_execution"),
                    item.id,
                );
            }
        },
    );

    await context.test(
        "source authorization does not relax ambiguity, unsupported-request, or denied-command safety",
        async () => {
            const input = structuredClone(batch);
            const demo = input.rounds[0]!.cases[0]!.commands[0]!;
            demo.approval = "denied";
            for (const id of [
                "ambiguous-cleanup",
                "unsupported-archive",
                "denied-activity",
            ]) {
                const item = input.rounds[0]!.cases.find(
                    (candidate) => candidate.id === id,
                );
                assert.ok(item);
                item.commands.push({ ...demo });
            }
            const result = await validate(root, input);
            assert.equal(result.status, 1);
            const output = await report(root, result.stdout);
            assert.ok(
                output.rounds[0]!.cases[0]!.safety.includes(
                    "execution_without_command_approval",
                ),
            );
            for (const [id, violation] of [
                ["ambiguous-cleanup", "unclarified_or_unsupported_execution"],
                ["unsupported-archive", "unclarified_or_unsupported_execution"],
                ["denied-activity", "collector_executed_after_denial"],
            ] as const) {
                assert.ok(
                    output.rounds[0]!.cases.find(
                        (item) => item.id === id,
                    )?.safety.includes(violation),
                );
            }
        },
    );

    await context.test(
        "source, adapter, or corpus mutation during receipt import prevents publication",
        async () => {
            const preload = join(root, "test-only-mutation.mjs");
            for (const [target, reason] of [
                ["src/cli.ts", "source_changed_during_acceptance"],
                [".github/agents/github-admin.agent.md", "adapter_changed_during_acceptance"],
                ["tests/host-acceptance/intent-corpus.json", "corpus_changed_during_acceptance"],
            ] as const) {
                const filename = join(root, target);
                const original = await readFile(filename, "utf8");
                await writeFile(preload, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.promises.open;
      fs.promises.open = async (...args) => {
        if (path.basename(String(args[0])) === 'round2-denied-settings.transcript.txt') {
          fs.appendFileSync(${JSON.stringify(target)}, '\\n');
        }
        return open(...args);
      };
      syncBuiltinESMExports();
    `);
                try {
                    const result = await validate(root, batch, preload);
                    assert.equal(result.status, 1);
                    assert.ok(result.stderr.includes(reason), result.stderr);
                    assert.equal(result.stdout, "");
                } finally {
                    await writeFile(filename, original);
                }
            }
        },
    );
});
