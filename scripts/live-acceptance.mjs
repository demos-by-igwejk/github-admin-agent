import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { getSourceIdentity } from "../src/core/source-revision.ts";

const apiVersion = "2026-03-10";
const captureRoot = "reports/live-acceptance/captures/";
const scenarioIds = [
    "repository-activity-inventory",
    "repository-billing-report",
    "repository-settings-audit",
];
const signals = [
    "push",
    "commits",
    "issues",
    "pull_requests",
    "discussions",
    "actions",
];
const credentialClasses = [
    "oauth",
    "classic-pat",
    "fine-grained-pat",
    "app-installation",
    "app-user",
];
const text = z.string().trim().min(1).max(500);
const reference = z.strictObject({
    path: text,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const grantsSchema = z.strictObject({
    schemaVersion: z.literal("1"),
    host: z.literal("github.com"),
    org: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    credentialClass: z.enum(credentialClasses),
    accountRole: text,
    declaredGrants: z.array(text).min(1).max(100),
    declaredWriteReach: z.enum(["read-only", "broader", "unknown"]),
    basis: z.enum(["operator-declared", "externally-reviewed"]),
    reviewedAt: z.iso.datetime(),
    reviewer: text,
    evidence: z.array(reference).min(1).max(20),
});

function requireCondition(value, message) {
    if (!value) throw new Error(message);
}
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function relativeName(value, prefix) {
    requireCondition(
        typeof value === "string" &&
            !path.isAbsolute(value) &&
            !/[\\\0\r\n]/.test(value),
        "acceptance_path_invalid",
    );
    requireCondition(
        value.split("/").every((part) => part && part !== "." && part !== ".."),
        "acceptance_path_invalid",
    );
    requireCondition(
        !prefix || value.startsWith(prefix),
        "acceptance_path_outside_approved_directory",
    );
    return value;
}
async function readLocal(root, name, maximum = 1024 * 1024) {
    const full = path.resolve(root, relativeName(name));
    requireCondition(
        (await realpath(full)) === full,
        "acceptance_symlink_not_allowed",
    );
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        requireCondition(
            stat.isFile() && stat.size <= maximum,
            "acceptance_file_size_or_type_invalid",
        );
        const bytes = await handle.readFile();
        requireCondition(bytes.length <= maximum, "acceptance_file_too_large");
        return bytes;
    } finally {
        await handle.close();
    }
}
function decode(bytes) {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function rejectSecrets(content) {
    requireCondition(
        !/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}|Authorization:\s*(?:Bearer|token)\s+\S{8,}/i.test(
            content,
        ),
        "possible_secret_in_receipt_not_persisted",
    );
}
async function directory(root, name) {
    let current = root;
    for (const part of relativeName(name).split("/")) {
        current = path.join(current, part);
        try {
            await mkdir(current, { mode: 0o700 });
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
        }
        const stat = await lstat(current);
        requireCondition(
            stat.isDirectory() && !stat.isSymbolicLink(),
            "acceptance_output_directory_unsafe",
        );
    }
    return current;
}
function positiveInteger(value, fallback, maximum) {
    if (value === undefined) return fallback;
    requireCondition(
        /^[1-9]\d*$/.test(value) &&
            Number.isSafeInteger(Number(value)) &&
            Number(value) <= maximum,
        "acceptance_budget_invalid",
    );
    return Number(value);
}
function failureCode(error) {
    if (error instanceof z.ZodError) return "live_acceptance_schema_invalid";
    return error instanceof Error
        ? error.message.split(":")[0]
        : "live_acceptance_failed";
}

async function main() {
    const { values } = parseArgs({
        strict: true,
        allowPositionals: false,
        options: {
            help: { type: "boolean" },
            live: { type: "boolean" },
            org: { type: "string" },
            scope: { type: "string" },
            scenario: { type: "string" },
            config: { type: "string" },
            profile: { type: "string" },
            "credential-class": { type: "string" },
            "grant-record": { type: "string" },
            repo: { type: "string", multiple: true },
            signal: { type: "string", multiple: true },
            month: { type: "string" },
            "no-inventory": { type: "boolean" },
            "max-requests": { type: "string" },
            "max-elapsed-ms": { type: "string" },
        },
    });
    if (values.help) {
        process.stdout.write(
            "Opt-in live doctor plus scoped inspect; no fixture fallback and no token-write test.\nRequired: GITHUB_ADMIN_LIVE_ACCEPTANCE=1 node scripts/live-acceptance.mjs --live --org ORG --scope organization --scenario ID --repo ORG/REPO --config PATH --profile operator-assisted-local --credential-class CLASS --grant-record reports/live-acceptance/captures/grants.json\nBilling also requires --month YYYY-MM. See docs/acceptance.md before authorizing.\n",
        );
        return;
    }
    requireCondition(
        values.live && process.env.GITHUB_ADMIN_LIVE_ACCEPTANCE === "1",
        "live_acceptance_opt_in_required",
    );
    requireCondition(
        values.profile === "operator-assisted-local",
        "explicit_operator_assisted_profile_required",
    );
    requireCondition(
        values.scope === "organization",
        "explicit_organization_source_scope_required",
    );
    requireCondition(
        scenarioIds.includes(values.scenario),
        "unsupported_acceptance_scenario",
    );
    requireCondition(
        credentialClasses.includes(values["credential-class"]),
        "endpoint_credential_class_required",
    );
    requireCondition(
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(values.org ?? ""),
        "explicit_organization_required",
    );
    const repositories = values.repo ?? [];
    requireCondition(
        repositories.length >= 1 &&
            repositories.length <= 5 &&
            new Set(repositories.map((repo) => repo.toLowerCase())).size ===
                repositories.length,
        "one_to_five_unique_repositories_required",
    );
    requireCondition(
        repositories.every(
            (repo) =>
                /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/.test(
                    repo,
                ) &&
                repo.split("/")[0].toLowerCase() === values.org.toLowerCase(),
        ),
        "acceptance_repository_scope_mismatch",
    );
    requireCondition(
        !values.signal ||
            (values.signal.length <= signals.length &&
                new Set(values.signal).size === values.signal.length &&
                values.signal.every((signal) => signals.includes(signal))),
        "acceptance_signal_invalid",
    );
    const billing = values.scenario === "repository-billing-report";
    requireCondition(
        billing || (!values.month && !values["no-inventory"]),
        "billing_options_on_nonbilling_acceptance",
    );
    if (billing) {
        requireCondition(
            /^\d{4}-(0[1-9]|1[0-2])$/.test(values.month ?? ""),
            "explicit_completed_utc_month_required",
        );
        requireCondition(
            values.month < new Date().toISOString().slice(0, 7),
            "completed_utc_month_required",
        );
    }
    relativeName(values.config);
    relativeName(values["grant-record"], captureRoot);
    const maximumAttempts = positiveInteger(values["max-requests"], 40, 100);
    const maximumElapsedMs = positiveInteger(
        values["max-elapsed-ms"],
        120000,
        900000,
    );
    const root = await realpath(process.cwd());
    requireCondition(
        root === (await realpath(new URL("..", import.meta.url))),
        "acceptance_source_checkout_required",
    );
    requireCondition(
        ["linux", "darwin"].includes(process.platform) &&
            /^(24|26)\./.test(process.versions.node),
        "unsupported_acceptance_runtime",
    );
    const reportsMarker = JSON.parse(
        decode(await readLocal(root, "reports/.admin-artifacts.json", 1024)),
    );
    requireCondition(
        reportsMarker.format === "github-admin-agent-reports",
        "initialize_managed_reports_before_acceptance",
    );
    const configBytes = await readLocal(root, values.config);
    const config = JSON.parse(decode(configBytes));
    requireCondition(
        config.host === undefined || config.host === "github.com",
        "unsupported_deployment",
    );
    requireCondition(
        config.org?.toLowerCase() === values.org.toLowerCase(),
        "config_organization_mismatch",
    );
    requireCondition(
        config.credential?.tokenEnv === undefined,
        "legacy_credential_source",
    );
    requireCondition(
        config.credential?.source === undefined ||
            config.credential.source === "gh-cli",
        "sole_gh_cli_source_required",
    );
    const grantBytes = await readLocal(root, values["grant-record"]);
    rejectSecrets(decode(grantBytes));
    const grants = grantsSchema.parse(JSON.parse(decode(grantBytes)));
    requireCondition(
        grants.org.toLowerCase() === values.org.toLowerCase() &&
            grants.credentialClass === values["credential-class"],
        "grant_record_scope_mismatch",
    );
    for (const evidence of grants.evidence) {
        relativeName(evidence.path, captureRoot);
        const bytes = await readLocal(root, evidence.path);
        rejectSecrets(decode(bytes));
        requireCondition(
            sha256(bytes) === evidence.sha256,
            "grant_evidence_integrity_mismatch",
        );
    }
    const sourceIdentity = getSourceIdentity();
    const id = `${Date.now()}-${randomUUID()}`;
    const relativeDirectory = `reports/live-acceptance/${id}`;
    const outputDirectory = await directory(root, relativeDirectory);
    const reportsPath = `${relativeDirectory}/runs`;
    const startedAt = new Date().toISOString();
    const receipts = [];
    const observations = [];
    let commandNumber = 0;
    let requestedOperations = [];
    let status = "failed";
    let errorCode = null;
    let remainingAttempts = maximumAttempts;
    let remainingElapsedMs = maximumElapsedMs;

    const invoke = async (label, args, timeoutMs) => {
        requireCondition(
            getSourceIdentity().sourceSha256 === sourceIdentity.sourceSha256,
            "source_changed_during_acceptance",
        );
        const began = new Date().toISOString();
        const result = spawnSync(process.execPath, ["src/cli.ts", ...args], {
            cwd: root,
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            shell: false,
        });
        requireCondition(
            getSourceIdentity().sourceSha256 === sourceIdentity.sourceSha256,
            "source_changed_during_acceptance",
        );
        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? "";
        rejectSecrets(stdout);
        rejectSecrets(stderr);
        const stem = `${String(++commandNumber).padStart(2, "0")}-${label}`;
        await writeFile(
            path.join(outputDirectory, `${stem}.stdout.txt`),
            stdout,
            {
                flag: "wx",
                mode: 0o600,
            },
        );
        await writeFile(
            path.join(outputDirectory, `${stem}.stderr.txt`),
            stderr,
            {
                flag: "wx",
                mode: 0o600,
            },
        );
        const receipt = {
            label,
            executable: process.execPath,
            argv: ["src/cli.ts", ...args],
            startedAt: began,
            completedAt: new Date().toISOString(),
            exitCode: result.status,
            signal: result.signal,
            processError: result.error?.code ?? null,
            stdout: {
                path: `${relativeDirectory}/${stem}.stdout.txt`,
                sha256: sha256(stdout),
                bytes: Buffer.byteLength(stdout),
            },
            stderr: {
                path: `${relativeDirectory}/${stem}.stderr.txt`,
                sha256: sha256(stderr),
                bytes: Buffer.byteLength(stderr),
            },
        };
        receipts.push(receipt);
        if (result.error)
            throw new Error(
                `collector_process_${result.error.code ?? "failed"}`,
            );
        requireCondition(
            result.signal === null && result.status !== null,
            "collector_process_interrupted",
        );
        return { receipt, stdout };
    };
    const inspectArtifacts = async (label, captured) => {
        requireCondition(
            Buffer.byteLength(captured.stdout) <= 64 * 1024,
            "collector_view_exceeds_byte_limit",
        );
        const view = JSON.parse(captured.stdout);
        requireCondition(
            view.synthetic === false && view.scenario === values.scenario,
            "live_result_provenance_mismatch",
        );
        requireCondition(
            /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(view.runId ?? "") &&
                /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(view.generation ?? ""),
            "live_result_identity_invalid",
        );
        const check = await invoke(
            `${label}-verify`,
            [
                "result",
                view.runId,
                "--reports",
                reportsPath,
                "--generation",
                view.generation,
            ],
            30000,
        );
        requireCondition(
            check.receipt.exitCode === 0,
            "published_generation_verification_failed",
        );
        const verified = JSON.parse(check.stdout);
        requireCondition(
            verified.runId === view.runId &&
                verified.generation === view.generation,
            "verified_generation_mismatch",
        );
        const generationDirectory = `${view.runId}/generations/${view.generation}`;
        requireCondition(
            view.artifacts?.result === `${generationDirectory}/result.json` &&
                view.artifacts?.manifest ===
                    `${generationDirectory}/manifest.json`,
            "unexpected_artifact_reference",
        );
        const resultPath = `${reportsPath}/${view.artifacts.result}`;
        const manifestPath = `${reportsPath}/${view.artifacts.manifest}`;
        const manifestBytes = await readLocal(root, manifestPath);
        const manifest = JSON.parse(decode(manifestBytes)).data;
        const resultBytes = await readLocal(root, resultPath, 64 * 1024 * 1024);
        requireCondition(
            manifest?.publication === "committed" &&
                manifest.runId === view.runId &&
                manifest.generation === view.generation,
            "manifest_identity_mismatch",
        );
        requireCondition(
            manifest.files?.["result.json"]?.sha256 === sha256(resultBytes) &&
                manifest.files["result.json"].bytes === resultBytes.length,
            "result_manifest_integrity_mismatch",
        );
        const envelope = JSON.parse(decode(resultBytes));
        requireCondition(
            envelope.synthetic === false &&
                envelope.host === "github.com" &&
                envelope.scope?.org?.toLowerCase() ===
                    values.org.toLowerCase() &&
                envelope.scenario === values.scenario &&
                envelope.codeVersion === sourceIdentity.codeVersion,
            "envelope_scope_or_version_mismatch",
        );
        requireCondition(
            envelope.identity?.profile === "operator-assisted-local" &&
                envelope.identity.credentialClass ===
                    values["credential-class"],
            "envelope_credential_declaration_mismatch",
        );
        requireCondition(
            envelope.identity.writeReach === "unknown" &&
                envelope.identity.scopeVerified === false,
            "unexpected_grant_assurance_promotion",
        );
        requireCondition(
            ["unverified", "not-applicable"].includes(
                envelope.assurance?.population,
            ) &&
                envelope.assurance?.finality ===
                    (billing ? "unknown" : "not-applicable"),
            "unexpected_source_assurance_promotion",
        );
        requireCondition(
            envelope.exitCode === captured.receipt.exitCode &&
                envelope.status === view.status,
            "status_exit_mismatch",
        );
        const endpoints = [];
        for (const evidence of envelope.evidence) {
            if (!evidence.source.startsWith("https:")) continue;
            const url = new URL(evidence.source);
            requireCondition(
                url.origin === "https://api.github.com" &&
                    !url.username &&
                    !url.password,
                "unexpected_observed_origin",
            );
            requireCondition(
                evidence.synthetic === false,
                "synthetic_evidence_in_live_result",
            );
            endpoints.push({
                operation: evidence.operation,
                endpoint: evidence.source,
                target: evidence.target,
                observedAt: evidence.observedAt,
                evidenceId: evidence.id,
            });
        }
        requireCondition(
            endpoints.length > 0,
            "no_observed_live_endpoint_evidence",
        );
        const observation = {
            label,
            runId: envelope.runId,
            generation: envelope.generation,
            status: envelope.status,
            exitCode: envelope.exitCode,
            identity: envelope.identity,
            assurance: envelope.assurance,
            coverage: envelope.result.coverage,
            budget: envelope.budget,
            reasons: envelope.reasons,
            endpoints,
            result: { path: resultPath, sha256: sha256(resultBytes) },
            manifest: { path: manifestPath, sha256: sha256(manifestBytes) },
        };
        observations.push(observation);
        remainingAttempts -= envelope.budget.attempts;
        remainingElapsedMs -= envelope.budget.elapsedMs;
        return envelope;
    };

    try {
        const version = await invoke("version", ["--version"], 10000);
        requireCondition(
            version.receipt.exitCode === 0 &&
                version.stdout.trim() === sourceIdentity.codeVersion,
            "source_version_mismatch",
        );
        const catalog = await invoke("catalog", ["scenarios", "list"], 10000);
        requireCondition(catalog.receipt.exitCode === 0, "catalog_failed");
        const manifest = JSON.parse(catalog.stdout).find(
            (item) => item.id === values.scenario,
        );
        requireCondition(
            manifest?.status === "implemented" && manifest.risk === "read-only",
            "scenario_not_implemented_read_only",
        );
        requestedOperations = manifest.capabilities.map(
            (item) => item.operation,
        );
        const common = [
            "--config",
            values.config,
            "--org",
            values.org,
            "--host",
            "github.com",
            "--live",
            "--profile",
            "operator-assisted-local",
            "--credential-class",
            values["credential-class"],
            "--reports",
            reportsPath,
            ...repositories.flatMap((repo) => ["--repo", repo]),
            ...(values.signal ?? []).flatMap((signal) => ["--signal", signal]),
            ...(billing ? ["--month", values.month] : []),
            ...(values["no-inventory"] ? ["--no-inventory"] : []),
        ];
        for (const stage of ["doctor", "inspect"]) {
            requireCondition(
                remainingAttempts > 0 && remainingElapsedMs > 0,
                "acceptance_cumulative_allowance_exhausted",
            );
            const args =
                stage === "doctor"
                    ? ["doctor", "--scenario", values.scenario]
                    : ["inspect", values.scenario];
            const captured = await invoke(
                stage,
                [
                    ...args,
                    ...common,
                    "--max-requests",
                    String(remainingAttempts),
                    "--max-elapsed-ms",
                    String(Math.floor(remainingElapsedMs)),
                ],
                Math.ceil(remainingElapsedMs) + 5000,
            );
            const envelope = await inspectArtifacts(stage, captured);
            if (stage === "doctor" && billing)
                requireCondition(
                    envelope.result.totals?.operation === "billing.usage",
                    "billing_doctor_did_not_probe_detail",
                );
            if (captured.receipt.exitCode !== 0) {
                status = envelope.status;
                throw new Error(`${stage}_not_completed`);
            }
            if (stage === "inspect" && billing)
                requireCondition(
                    Array.isArray(envelope.result.totals?.partitions) &&
                        envelope.evidence.some(
                            (item) => item.operation === "billing.usage",
                        ),
                    "billing_detail_domain_result_missing",
                );
        }
        requireCondition(
            getSourceIdentity().sourceSha256 === sourceIdentity.sourceSha256,
            "source_changed_during_acceptance",
        );
        status = "observations-recorded";
    } catch (error) {
        errorCode = failureCode(error);
    }
    const observedOperations = [
        ...new Set(
            observations.flatMap((item) =>
                item.endpoints.map((endpoint) => endpoint.operation),
            ),
        ),
    ].sort();
    const report = {
        schemaVersion: "1",
        kind: "opt-in-live-contract-observations",
        status,
        errorCode,
        liveAcceptance: "pending-independent-review",
        fullReleaseCertification: "pending",
        startedAt,
        completedAt: new Date().toISOString(),
        versions: {
            code: sourceIdentity.codeVersion,
            sourceSha256: sourceIdentity.sourceSha256,
            node: process.version,
            platform: process.platform,
            api: apiVersion,
            apiBasis:
                "source request-header declaration; not a response-version attestation",
        },
        scope: {
            host: "github.com",
            org: values.org,
            sourceScope: values.scope,
            scenario: values.scenario,
            repositories,
            month: values.month ?? null,
        },
        config: { path: values.config, sha256: sha256(configBytes) },
        grants: {
            ...grants,
            record: {
                path: values["grant-record"],
                sha256: sha256(grantBytes),
            },
            effectiveGrantsVerifiedByHarness: false,
        },
        allowance: {
            maximumAttempts,
            maximumElapsedMs,
            remainingAttempts,
            remainingElapsedMs,
        },
        requestedOperations,
        observedOperations,
        notExercised: requestedOperations.filter(
            (operation) => !observedOperations.includes(operation),
        ),
        commands: receipts,
        observations,
        limitations: [
            "Doctor probes a minimal operation; inspect validates the actual requested scenario. A summary endpoint never substitutes for organization billing detail.",
            "Recorded grants remain declared or externally reviewed metadata. Read success does not establish no-write effective reach, complete population, or provider finality.",
            "Only operations with accepted evidence are listed as observed; diagnostics and failed attempts remain in the referenced artifacts.",
            "Optional fields, signals, roles, token classes, and scopes not exercised by these observations remain pending.",
            "No fixture fallback, credential-write test, Copilot approval automation, production claim, or pilot certification is performed.",
        ],
    };
    requireCondition(
        getSourceIdentity().sourceSha256 === sourceIdentity.sourceSha256,
        "source_changed_during_acceptance",
    );
    await writeFile(
        path.join(outputDirectory, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(
        `${JSON.stringify({
            status,
            errorCode,
            liveAcceptance: report.liveAcceptance,
            report: `${relativeDirectory}/report.json`,
            observedOperations,
            notExercised: report.notExercised,
        })}\n`,
    );
    if (status !== "observations-recorded" || errorCode !== null)
        process.exitCode = 1;
}

await main().catch((error) => {
    process.stderr.write(`${failureCode(error)}\n`);
    process.exitCode = 1;
});
