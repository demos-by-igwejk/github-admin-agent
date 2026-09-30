import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import {
    API_VERSION,
    CODE_VERSION,
    configSchema,
} from "../src/core/contracts.ts";
import { parseOwners, policySchema } from "../src/core/config.ts";
import { getSourceIdentity } from "../src/core/source-revision.ts";

const scenarioIds = [
    "repository-activity-inventory",
    "repository-billing-report",
    "repository-settings-audit",
] as const;
const read = (name: string) => readFile(path.join(process.cwd(), name), "utf8");
const json = async (name: string): Promise<unknown> =>
    JSON.parse(await read(name));

function frontmatter(source: string): Record<string, string> {
    const match = /^---\n([\s\S]+?)\n---\n/.exec(source);
    assert.ok(match, "Expected simple native YAML frontmatter");
    const fields: Record<string, string> = {};
    for (const line of match[1]!.split("\n")) {
        const entry = /^([a-z][a-z-]*): (.+)$/.exec(line);
        assert.ok(
            entry,
            "Delivery frontmatter uses one literal field per line",
        );
        assert.equal(
            Object.hasOwn(fields, entry[1]!),
            false,
            "No duplicate frontmatter keys",
        );
        fields[entry[1]!] = entry[2]!;
    }
    return fields;
}

const exactValueSchema = z.strictObject({
    repository: z.string().nullable(),
    sku: z.string().min(1),
    field: z.enum([
        "quantity",
        "pricePerUnit",
        "grossAmount",
        "discountAmount",
        "netAmount",
    ]),
    value: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/),
});
const corpusSchema = z.strictObject({
    schemaVersion: z.literal("2"),
    version: z.literal("3.0.0"),
    surfaces: z.array(z.enum(["copilot-cli", "vscode", "copilot-app"])),
    syntheticOnly: z.literal(true),
    minimumRounds: z.number().int().min(2),
    accuracyTarget: z.literal(0.95),
    fixtureClock: z.iso.datetime(),
    limitations: z.array(z.string()).min(1),
    cases: z
        .array(
            z.strictObject({
                id: z.string().regex(/^[a-z][a-z0-9-]+$/),
                category: z.enum([
                    "normal",
                    "ambiguous",
                    "unsupported",
                    "approval-denial",
                ]),
                prompt: z.string().min(20),
                operatorAction: z.string().optional(),
                expected: z.strictObject({
                    intent: z.enum(["execute", "clarify", "refuse", "denied"]),
                    scenario: z.enum(scenarioIds).optional(),
                    argv: z.array(z.string()).optional(),
                    status: z
                        .enum([
                            "completed",
                            "partial",
                            "failed",
                            "deferred",
                            "cancelled",
                        ])
                        .optional(),
                    exitCode: z.number().int().optional(),
                    exactValues: z.array(exactValueSchema).optional(),
                }),
            }),
        )
        .min(30),
});

test("static delivery: configuration, policy, and synthetic owners match current schemas", async () => {
    const [rawConfig, rawPolicy, owners] = await Promise.all([
        json("config/admin-agent.example.json"),
        json("config/policies/repositories.example.json"),
        read("examples/owners.example.csv"),
    ]);
    const config = configSchema.parse(rawConfig);
    assert.equal(config.org, "example-org");
    assert.equal(config.host, "github.com");
    assert.deepEqual(config.credential, {
        name: "restricted-reader",
        credentialClass: "none",
        source: "gh-cli",
    });
    assert.deepEqual(config.activity.signals, ["push"]);
    assert.equal(config.policyPath, "config/policies/repositories.json");
    assert.equal(config.ownersPath, "config/owners.csv");
    assert.equal(config.reportsPath, "reports");
    assert.equal(config.retentionDays, 30);
    assert.ok(policySchema.parse(rawPolicy).rules.length > 0);
    const mapping = parseOwners(owners, config.org);
    assert.equal(Object.keys(mapping).length, 4);
    assert.ok(
        Object.values(mapping).every(
            (owner) =>
                typeof owner === "string" && owner.startsWith("Synthetic "),
        ),
    );
});

test("static delivery: native adapters use matching IDs and documented aliases, not approval grants", async () => {
    const [agent, ...skills] = await Promise.all([
        read(".github/agents/github-admin.agent.md"),
        ...scenarioIds.map((id) => read(`.github/skills/${id}/SKILL.md`)),
    ]);
    const fields = frontmatter(agent!);
    assert.equal(fields.name, "github-admin");
    assert.ok(fields.description);
    assert.deepEqual(JSON.parse(fields.tools!), ["read", "search", "execute"]);
    assert.deepEqual(Object.keys(fields).sort(), [
        "description",
        "name",
        "tools",
    ]);
    for (const [index, source] of skills.entries()) {
        const skill = frontmatter(source);
        assert.equal(skill.name, scenarioIds[index]);
        assert.ok(skill.description);
        assert.deepEqual(Object.keys(skill).sort(), ["description", "name"]);
        assert.ok(
            source.includes(
                `node src/cli.ts demo --scenario ${scenarioIds[index]}`,
            ),
        );
        assert.ok(
            source.includes(`node src/cli.ts inspect ${scenarioIds[index]}`),
        );
        assert.match(source, /result RUN_ID --view rows/);
        assert.match(source, /operator-assisted-local/);
        assert.ok(source.includes(`node src/cli.ts auth-plan ${scenarioIds[index]}`));
        assert.match(source, /unknown|unverified/);
    }
    for (const source of [agent!, ...skills]) {
        assert.doesNotMatch(
            source,
            /^model:|^allowed-tools:|--allow-all|--allow-tool|--yolo/m,
        );
        assert.doesNotMatch(
            source,
            /node\s+dist\/cli\.js|tsx\s+src\/|npx\s+tsx/,
        );
        assert.match(source, /approvals?/i);
        assert.match(source, /deni(?:al|ed)/i);
        assert.match(source, /gh-cli/);
        assert.doesNotMatch(source, /GITHUB_ADMIN_TOKEN|--token-env/);
        assert.doesNotMatch(source, /^gh auth (?:token|login|refresh|switch)\b/gm);
    }
});

test("static delivery: shared instructions and exact VS Code help approval do not authorize collection", async () => {
    const [instructions, settings] = await Promise.all([
        read(".github/copilot-instructions.md"),
        json(".vscode/settings.json"),
    ]);
    for (const value of ["Copilot CLI", "VS Code", "Copilot app", "gh-cli", "auth-plan", "scenarios list"])
        assert.ok(instructions.includes(value));
    assert.match(instructions, /stop.*denial/i);
    assert.match(instructions, /not a host-wide sandbox/i);
    assert.doesNotMatch(instructions, /GITHUB_ADMIN_TOKEN|--token-env|^gh auth (?:token|login|refresh|switch)\b/gm);
    const parsed = z.strictObject({
        "chat.tools.terminal.autoApprove": z.record(
            z.string(),
            z.strictObject({
                approve: z.literal(true),
                matchCommandLine: z.literal(true),
            }),
        ),
    }).parse(settings);
    const entries = Object.entries(parsed["chat.tools.terminal.autoApprove"]);
    assert.equal(entries.length, 1);
    const [rule] = entries[0]!;
    assert.equal(rule, "/^node src/cli\\.ts inspect repository-activity-inventory --help$/");
    const expression = new RegExp(rule.slice(1, -1));
    assert.ok(expression.test("node src/cli.ts inspect repository-activity-inventory --help"));
    for (const command of [
        "node src/cli.ts demo --scenario repository-activity-inventory",
        "node src/cli.ts inspect repository-activity-inventory --live",
        "node src/cli.ts inspect repository-billing-report --help",
        "node src/cli.ts inspect repository-activity-inventory --help && gh auth token",
        "node src/unreviewed.ts --help",
        "gh auth token",
    ])
        assert.equal(expression.test(command), false, command);
});

test("static delivery: declared commands use current CLI option names", async () => {
    const names = [
        "README.md",
        "docs/getting-started.md",
        ".github/copilot-instructions.md",
        ".github/agents/github-admin.agent.md",
        "docs/operations.md",
        "docs/authoring-scenarios.md",
        ...scenarioIds.map((id) => `.github/skills/${id}/SKILL.md`),
    ];
    const [cli, ...documents] = await Promise.all([
        read("src/cli.ts"),
        ...names.map(read),
    ]);
    const source = ts.createSourceFile("src/cli.ts", cli!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = new Map<string, ts.Expression>();
    const visit = (node: ts.Node): void => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            ["optionDefinitions", "configurationOptions", "allowedOptions"].includes(node.name.text)
        )
            declarations.set(node.name.text, node.initializer);
        ts.forEachChild(node, visit);
    };
    visit(source);
    const definitions = declarations.get("optionDefinitions");
    assert.ok(
        definitions,
        "Inspect updated CLI option definitions when changing this static consistency check",
    );
    const initializer = ts.isAsExpression(definitions) ? definitions.expression : definitions;
    assert.ok(ts.isObjectLiteralExpression(initializer));
    const options = new Set(
        initializer.properties.map((property) => {
            assert.ok(ts.isPropertyAssignment(property));
            assert.ok(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name));
            return property.name.text;
        }),
    );
    assert.ok(options.has("credential-class"));
    const configuration = declarations.get("configurationOptions");
    assert.ok(configuration && ts.isArrayLiteralExpression(configuration));
    const configurationFlags = configuration.elements.map((element) => {
        assert.ok(ts.isStringLiteral(element));
        return element.text;
    });
    const permitted = declarations.get("allowedOptions");
    assert.ok(permitted && ts.isObjectLiteralExpression(permitted));
    const allowedByCommand = new Map(permitted.properties.map((property) => {
        assert.ok(ts.isPropertyAssignment(property));
        assert.ok(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name));
        assert.ok(ts.isArrayLiteralExpression(property.initializer));
        const values = property.initializer.elements.flatMap((element) => {
            if (ts.isSpreadElement(element)) {
                assert.ok(ts.isIdentifier(element.expression));
                assert.equal(element.expression.text, "configurationOptions");
                return configurationFlags;
            }
            assert.ok(ts.isStringLiteral(element));
            return [element.text];
        });
        return [property.name.text, new Set(["help", "version", ...values])] as const;
    }));
    const commands = new Set([
        "scenarios",
        "auth-plan",
        "doctor",
        "demo",
        "inspect",
        "resume",
        "refresh",
        "result",
        "--version",
    ]);
    let checked = 0;
    for (const source of documents) {
        assert.doesNotMatch(
            source,
            /^node dist\/cli\.js|^npm run build|^npx tsx/gm,
        );
        for (const match of source.matchAll(/^node src\/cli\.ts (.+)$/gm)) {
            checked++;
            const command = match[1]!;
            const name = command.split(" ")[0]!;
            assert.ok(commands.has(name));
            for (const flag of command.matchAll(/--([a-z-]+)/g)) {
                assert.ok(
                    options.has(flag[1]!),
                    `Unknown documented option: ${flag[0]}`,
                );
                if (!name.startsWith("--"))
                    assert.ok(
                        allowedByCommand.get(name)?.has(flag[1]!),
                        `${flag[0]} does not apply to documented command ${name}`,
                    );
            }
        }
    }
    assert.ok(
        checked >= scenarioIds.length * 2,
        "Native source command examples must actually be checked",
    );
});

test("static delivery: validation evidence references existing native test files", async () => {
    const document = await read("docs/validation.md");
    const references = new Set(
        [...document.matchAll(/`(tests\/[\w/-]+\.test\.ts)`/g)].map(
            (match) => match[1]!,
        ),
    );
    assert.ok(
        references.size > 0,
        "Validation must identify concrete test evidence",
    );
    await Promise.all(
        [...references].map(async (name) => {
            assert.ok(
                (await stat(path.join(process.cwd(), name))).isFile(),
                `Missing validation evidence: ${name}`,
            );
        }),
    );
});

test("static delivery: customer guides have local link targets, balanced diagrams, and no internal history", async () => {
    const names = [
        "README.md",
        ...(await readdir("docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`),
        ".github/copilot-instructions.md",
        ".github/agents/github-admin.agent.md",
        ...scenarioIds.map((id) => `.github/skills/${id}/SKILL.md`),
    ];
    const sources = await Promise.all(names.map(read));
    let diagrams = 0;
    for (const [index, source] of sources.entries()) {
        const name = names[index]!;
        assert.doesNotMatch(
            source,
            /prior[- ]chat|conversation[- ]history|(?:greenfield|donor)[- ](?:approval|migration|implementation|code)|untouched source documents|rubber-duck reviews|review-driven regressions|(?:user|operator)\s+(?:explicitly\s+)?approved\s+(?:a|the|this)\s+(?:greenfield|source-only|refactor)/i,
            name,
        );
        const blocks = [...source.matchAll(/^```mermaid[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
        assert.equal(blocks.length, [...source.matchAll(/^```mermaid\b.*$/gm)].length, name);
        for (const block of blocks) {
            assert.match(block[1]!, /^\s*(?:flowchart|graph|sequenceDiagram|stateDiagram-v2|classDiagram)\b/m);
            diagrams++;
        }
        for (const match of source.matchAll(/\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
            const destination = match[1]!;
            if (/^[a-z][a-z0-9+.-]*:/i.test(destination)) continue;
            const local = decodeURIComponent(destination.split("#")[0]!.split("?")[0]!);
            const resolved = local ? path.resolve(path.dirname(name), local) : path.resolve(name);
            const relative = path.relative(process.cwd(), resolved);
            assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${name}: ${destination}`);
            assert.ok((await stat(resolved)).isFile(), `${name}: ${destination}`);
        }
    }
    assert.ok(diagrams > 0, "The architecture guide must include a fenced diagram");
});

test("static delivery: corpus covers two rounds, 30 normal/ambiguous cases, safety, and exact values", async () => {
    const corpus = corpusSchema.parse(
        await json("tests/host-acceptance/intent-corpus.json"),
    );
    assert.equal(corpus.cases.length, 39);
    assert.deepEqual(corpus.surfaces, ["copilot-cli", "vscode", "copilot-app"]);
    assert.equal(corpus.cases.filter((item) => item.expected.argv).length, 24);
    assert.equal(
        new Set(corpus.cases.map((item) => item.id)).size,
        corpus.cases.length,
    );
    assert.ok(
        corpus.cases.filter(
            (item) =>
                item.category === "normal" || item.category === "ambiguous",
        ).length >= 30,
    );
    for (const category of [
        "normal",
        "ambiguous",
        "unsupported",
        "approval-denial",
    ])
        assert.ok(corpus.cases.some((item) => item.category === category));
    const exits = {
        completed: 0,
        partial: 2,
        failed: 1,
        deferred: 3,
        cancelled: 130,
    };
    const exactValues = [];
    for (const item of corpus.cases) {
        if (item.category === "normal" || item.category === "approval-denial") {
            assert.ok(item.expected.argv && item.expected.scenario);
            assert.deepEqual(item.expected.argv.slice(0, 3), [
                "node",
                "src/cli.ts",
                "demo",
            ]);
            assert.equal(
                item.expected.argv[
                    item.expected.argv.indexOf("--scenario") + 1
                ],
                item.expected.scenario,
            );
            assert.ok(!item.expected.argv.includes("--live"));
            if (item.category === "normal") {
                assert.equal(item.expected.intent, "execute");
                assert.ok(item.expected.status);
                assert.equal(
                    item.expected.exitCode,
                    exits[item.expected.status],
                );
            } else {
                assert.equal(item.expected.intent, "denied");
                assert.match(
                    item.operatorAction ?? "",
                    /actual collector command/,
                );
            }
        } else {
            assert.equal(
                item.expected.intent,
                item.category === "ambiguous" ? "clarify" : "refuse",
            );
            assert.equal(item.expected.argv, undefined);
        }
        exactValues.push(...(item.expected.exactValues ?? []));
    }
    assert.ok(exactValues.some((item) => item.value === "0.0005"));
    assert.ok(exactValues.some((item) => item.repository === null));
    assert.ok(exactValues.some((item) => item.field === "pricePerUnit"));
});

test("static delivery: acceptance scripts remain explicit opt-ins with truthful pending gates", async () => {
    const [host, live, docs] = await Promise.all([
        read("scripts/host-acceptance.mjs"),
        read("scripts/live-acceptance.mjs"),
        read("docs/acceptance.md"),
    ]);
    assert.match(host, /GITHUB_ADMIN_HOST_ACCEPTANCE\s*===\s*["']1["']/);
    assert.match(host, /values\[["']opt-in["']\]/);
    assert.doesNotMatch(host, /from\s+["']node:child_process["']|spawnSync\(/);
    assert.match(host, /pending-independent-review/);
    assert.match(host, /unclarified_or_unsupported_execution/);
    assert.match(host, /collector_executed_after_denial/);
    assert.match(host, /model_exact_value_mismatch/);
    assert.match(host, /runToRunVariation/);
    assert.match(host, /mixed_host_targets_not_allowed/);
    assert.match(host, /adapter_changed_during_acceptance/);
    assert.match(host, /corpus_changed_during_acceptance/);
    assert.match(host, /imageReceiptsRequiringReview/);
    assert.match(host, /command_attempted_after_denial/);
    assert.match(host, /sourceSha256: hash/);
    assert.match(host, /round\.codeVersion === sourceIdentity\.codeVersion/);
    assert.match(live, /GITHUB_ADMIN_LIVE_ACCEPTANCE\s*===\s*["']1["']/);
    assert.match(live, /values\.scope\s*===\s*["']organization["']/);
    assert.match(live, /values\.profile\s*===\s*["']operator-assisted-local["']/);
    assert.match(live, /spawnSync\(process\.execPath/);
    assert.match(live, /shell: false/);
    assert.match(live, /for\s*\(const stage of \[\s*["']doctor["'],\s*["']inspect["']\s*\]\)/);
    assert.match(live, /billing_doctor_did_not_probe_detail/);
    assert.match(live, /effectiveGrantsVerifiedByHarness: false/);
    assert.match(live, /envelope\.codeVersion === sourceIdentity\.codeVersion/);
    assert.match(
        live,
        /version\.stdout\.trim\(\) === sourceIdentity\.codeVersion/,
    );
    for (const script of [host, live]) {
        assert.match(script, /from\s+["']\.\.\/src\/core\/source-revision\.ts["']/);
        assert.match(script, /source_changed_during_acceptance/);
        assert.match(script, /acceptance_source_checkout_required/);
        assert.match(script, /src\/cli\.ts/);
        assert.doesNotMatch(
            script,
            /bundleSha256|bundleHash|dist\/cli\.js|packageInfo\.version/,
        );
    }
    assert.match(live, new RegExp(`const apiVersion\\s*=\\s*["']${API_VERSION}["']`));
    assert.doesNotMatch(
        live,
        /createFixtureTransport|['"]demo['"]|--allow-all/,
    );
    assert.match(docs, /recorder, not an automated Copilot acceptance run/);
    assert.match(docs, /never synthesize receipts/i);
    assert.match(docs, /Actual host acceptance remains pending/i);
    assert.match(docs, /Live API acceptance is also pending/i);
    assert.match(docs, /hostAcceptance:\s*["']pending-independent-review["']/);
    assert.match(docs, /sourceSha256/);
});

test("static delivery: source-only tooling typechecks without emission and discovers native tests", async () => {
    const [configValue, runner, schemas, npmIgnore] = await Promise.all([
        json("tsconfig.json"),
        read("scripts/test.mjs"),
        read("scripts/schemas.mjs"),
        read(".npmignore"),
    ]);
    const config = z
        .object({
            compilerOptions: z.object({
                target: z.literal("ES2023"),
                lib: z.array(z.string()),
                module: z.literal("NodeNext"),
                moduleResolution: z.literal("NodeNext"),
                strict: z.literal(true),
                noUncheckedIndexedAccess: z.literal(true),
                noUnusedLocals: z.literal(true),
                noUnusedParameters: z.literal(true),
                noEmit: z.literal(true),
                allowImportingTsExtensions: z.literal(true),
                erasableSyntaxOnly: z.literal(true),
                verbatimModuleSyntax: z.literal(true),
                rootDir: z.never().optional(),
                outDir: z.never().optional(),
            }),
            include: z.array(z.string()),
        })
        .parse(configValue);
    assert.deepEqual(config.compilerOptions.lib, ["ES2023", "DOM"]);
    assert.deepEqual(config.include, ["src/**/*.ts", "tests/**/*.ts"]);
    await Promise.all([
        assert.rejects(read("tsconfig.test.json"), { code: "ENOENT" }),
        assert.rejects(read("scripts/build.mjs"), { code: "ENOENT" }),
    ]);
    assert.match(runner, /readdir/);
    assert.match(runner, /\.test\.ts/);
    assert.match(runner, /--test/);
    assert.match(runner, /network-block\.mjs/);
    assert.doesNotMatch(
        runner,
        /\.test-dist|\.test\.js|experimental|tsc|esbuild/,
    );
    assert.match(
        schemas,
        /import\s*\{\s*schemas\s*\}\s*from\s*["']\.\.\/src\/schema-export\.ts["']/,
    );
    assert.match(schemas, /--check/);
    assert.match(schemas, /schema_drift/);
    assert.doesNotMatch(schemas, /esbuild|\.build|unlink|spawn/);
    assert.ok(npmIgnore.split("\n").includes(".test-tmp/"));
});

test("static delivery: pinned CI and private checkout metadata do not claim installed CLI or runtime acceptance", async () => {
    const [
        workflow,
        packageValue,
        lockValue,
        ignore,
        readme,
        provenance,
        support,
        notices,
        zodLicense,
        losslessLicense,
    ] = await Promise.all([
        read(".github/workflows/checks.yml"),
        json("package.json"),
        json("package-lock.json"),
        read(".gitignore"),
        read("README.md"),
        read("docs/provenance.md"),
        read("docs/support-matrix.md"),
        read("docs/third-party-notices.md"),
        read("node_modules/zod/LICENSE"),
        read("node_modules/lossless-json/LICENSE.md"),
    ]);
    const packageInfo = z
        .object({
            name: z.literal("github-admin-agent"),
            version: z.literal(CODE_VERSION.replace(/\+.*/, "")),
            private: z.literal(true),
            license: z.literal("UNLICENSED"),
            type: z.literal("module"),
            engines: z.object({ node: z.literal("^24.0.0 || ^26.0.0") }),
            bin: z.never().optional(),
            files: z.never().optional(),
            scripts: z.object({
                build: z.never().optional(),
                typecheck: z.literal("tsc --noEmit"),
                test: z.literal("node scripts/test.mjs"),
                check: z.literal("npm run typecheck && npm test"),
                schemas: z.literal("node scripts/schemas.mjs"),
            }),
            dependencies: z.strictObject({
                "lossless-json": z.literal("4.3.1"),
                zod: z.literal("4.6.5"),
            }),
            devDependencies: z.strictObject({
                "@types/node": z.literal("24.13.6"),
                typescript: z.literal("5.9.3"),
            }),
        })
        .parse(packageValue);
    const lock = z
        .object({
            lockfileVersion: z.literal(3),
            packages: z.record(
                z.string(),
                z.object({
                    version: z.string(),
                    license: z.string().optional(),
                    bin: z.unknown().optional(),
                    dev: z.boolean().optional(),
                    dependencies: z.record(z.string(), z.string()).optional(),
                    devDependencies: z
                        .record(z.string(), z.string())
                        .optional(),
                }),
            ),
        })
        .parse(lockValue);
    assert.equal(CODE_VERSION, getSourceIdentity().codeVersion);
    assert.deepEqual(lock.packages[""]?.dependencies, packageInfo.dependencies);
    assert.deepEqual(
        lock.packages[""]?.devDependencies,
        packageInfo.devDependencies,
    );
    assert.equal(lock.packages[""]?.bin, undefined);
    assert.ok(
        Object.keys(lock.packages).every((name) => !name.includes("esbuild")),
    );
    for (const [name, version] of Object.entries(packageInfo.dependencies)) {
        assert.equal(lock.packages[`node_modules/${name}`]?.version, version);
        assert.equal(lock.packages[`node_modules/${name}`]?.license, "MIT");
        assert.notEqual(lock.packages[`node_modules/${name}`]?.dev, true);
    }
    const pins = [...workflow.matchAll(/uses:\s+([a-z/-]+)@([a-f0-9]{40})/g)];
    assert.deepEqual(pins.map((match) => match[1]).sort(), [
        "actions/checkout",
        "actions/setup-node",
    ]);
    assert.ok(workflow.includes("249970729cb0ef3589644e2896645e5dc5ba9c38"));
    assert.ok(workflow.includes("d23441a48e516b6c34aea4fa41551a30e30af803"));
    assert.match(workflow, /^permissions:\s*\r?\n[ \t]+contents:\s*read\s*$/m);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /os: \[ubuntu-latest, macos-latest\]/);
    assert.match(workflow, /node: \[24\.0\.0, 24, 26\]/);
    assert.match(workflow, /npm ci --ignore-scripts/);
    assert.match(workflow, /npm run check/);
    assert.match(workflow, /npm run schemas -- --check/);
    assert.match(workflow, /tests\/fixtures\/network-block\.mjs/);
    assert.doesNotMatch(
        workflow,
        /pull_request_target|secrets\.|acceptance:host|acceptance:live|npm pack|npm run build/,
    );
    for (const item of [
        ".test-tmp/",
        "reports/",
        "config/admin-agent.json",
        "config/policies/repositories.json",
        "config/owners.csv",
    ])
        assert.ok(ignore.split("\n").includes(item));
    assert.match(readme, /node src\/cli\.ts/);
    assert.match(readme, /auth-plan/);
    assert.match(provenance, /UNLICENSED/);
    assert.match(provenance, /third-party/i);
    assert.match(notices, /zod 4\.6\.5/);
    assert.match(notices, /lossless-json 4\.3\.1/);
    assert.match(notices, /Copyright \(c\) 2025 Colin McDonnell/);
    assert.match(notices, /Copyright \(c\) 2016-2026 Jos de Jong/);
    const normalizedNotices = notices.replace(/\s+/g, " ");
    assert.ok(
        normalizedNotices.includes(zodLicense.trim().replace(/\s+/g, " ")),
        "Preserve the installed zod copyright and permission notice",
    );
    assert.ok(
        normalizedNotices.includes(losslessLicense.trim().replace(/\s+/g, " ")),
        "Preserve the installed lossless-json copyright and permission notice",
    );
    assert.match(support, /Live API acceptance: pending/);
    assert.match(support, /Copilot-host acceptance: pending/);
    assert.match(support, /no optional hooks or hooks-based safety claim/);
    assert.match(
        support,
        /Fine-grained PAT and App organization-detail support are not established/,
    );
});
