import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
    authorizationPlan,
    GH_AUTH_MAX_OUTPUT_BYTES,
    GH_AUTH_TIMEOUT_MS,
    resolveGhToken,
} from "../../src/core/auth.ts";
import { configSchema } from "../../src/core/contracts.ts";
import { getScenario } from "../../src/scenarios/index.ts";
import { temporaryProject } from "./storage-fixtures.ts";
import {
    fakeGhEnvironment,
    ghInvocations,
    installFakeGh,
} from "../fixtures/gh.ts";

async function fakeEnvironment(context: TestContext, mode = "success") {
    const root = await temporaryProject(context, "gh-auth");
    await installFakeGh(root);
    const env = {
        ...fakeGhEnvironment(root),
        GITHUB_ADMIN_TEST_GH_MODE: mode,
        GH_TOKEN: "fixture-gh-token",
        GITHUB_TOKEN: "fixture-github-token",
        GH_DEBUG: "api",
        DEBUG: "1",
        GH_FORCE_TTY: "1",
        GH_PAGER: "untrusted-pager",
        PAGER: "untrusted-pager",
    };
    const previous = Object.fromEntries(
        Object.keys(env).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    context.after(() => {
        for (const [name, value] of Object.entries(previous))
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
    });
    return root;
}
const request = (signal = new AbortController().signal, timeoutMs = 1000) => ({
    host: "github.com" as const,
    signal,
    timeoutMs,
});

test("gh resolver privately invokes only the fixed host read and preserves token precedence without debug/prompt output", async (context) => {
    const root = await fakeEnvironment(context);
    assert.equal(
        await resolveGhToken(request()),
        "synthetic-gh-credential-not-a-real-token",
    );
    const invocations = await ghInvocations(root);
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0]?.argv, [
        "auth",
        "token",
        "--hostname",
        "github.com",
    ]);
    assert.equal(invocations[0]?.ghTokenPreserved, true);
    assert.equal(invocations[0]?.githubTokenPreserved, true);
    for (const name of ["GH_DEBUG", "DEBUG", "GH_FORCE_TTY", "GH_PAGER", "PAGER"])
        assert.equal(invocations[0]?.controls[name], null);
    for (const name of [
        "GH_PROMPT_DISABLED",
        "GH_NO_UPDATE_NOTIFIER",
        "GH_NO_EXTENSION_UPDATE_NOTIFIER",
    ])
        assert.equal(invocations[0]?.controls[name], "1");
    assert.equal(invocations[0]?.controls.GH_TELEMETRY, "false");
});

test("gh auth failures never expose captured stdout, stderr, credentials, or spawn errors", async (context) => {
    const root = await fakeEnvironment(context, "failure");
    await assert.rejects(resolveGhToken(request()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^gh_auth_failed:/);
        assert.doesNotMatch(
            JSON.stringify(error) + error.message,
            /synthetic-gh-credential|private-auth-failure|Command failed/,
        );
        return true;
    });
    assert.equal((await ghInvocations(root)).length, 1);
    const missing = join(root, "missing-executables");
    await mkdir(missing);
    process.env.PATH = missing;
    await assert.rejects(resolveGhToken(request()), /^Error: gh_cli_unavailable:/);
});

for (const mode of ["empty", "malformed", "multiline", "invalid-encoding"]) {
    test(`gh ${mode} output is explicitly invalid rather than a credential fallback`, async (context) => {
        const root = await fakeEnvironment(context, mode);
        await assert.rejects(resolveGhToken(request()), /gh_auth_invalid_output/);
        assert.equal((await ghInvocations(root)).length, 1);
    });
}
for (const mode of ["oversized-stdout", "oversized-stderr", "combined-output"]) {
    test(`gh ${mode} output is bounded privately before it reaches callers`, async (context) => {
        await fakeEnvironment(context, mode);
        assert.equal(GH_AUTH_MAX_OUTPUT_BYTES, 16384);
        await assert.rejects(
            resolveGhToken(request()),
            /gh_auth_output_too_large/,
        );
    });
}

test("auth timeout is separately bounded and forcibly stops a child that ignores SIGTERM", async (context) => {
    const root = await fakeEnvironment(context, "hang");
    const began = Date.now();
    await assert.rejects(
        resolveGhToken(request(undefined, 1000)),
        /gh_auth_timeout/,
    );
    assert.ok(Date.now() - began < 5000);
    const invocations = await ghInvocations(root);
    assert.equal(invocations.length, 1);
    const pid = invocations[0]!.pid;
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            assert.ok(
                error instanceof Error &&
                    "code" in error &&
                    error.code === "ESRCH",
            );
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("The fake gh child must not survive an authentication timeout");
});

test("aborted auth never starts a process and an in-flight cancellation is prompt", async (context) => {
    const root = await fakeEnvironment(context, "hang");
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(resolveGhToken(request(abort.signal)), /operator_cancelled/);
    await assert.rejects(stat(join(root, "fake-gh-invocations.jsonl")), {
        code: "ENOENT",
    });
    const active = new AbortController();
    const pending = resolveGhToken(request(active.signal, GH_AUTH_TIMEOUT_MS));
    const cancelled = assert.rejects(pending, /operator_cancelled/);
    for (let attempt = 0; attempt < 100; attempt++) {
        if ((await ghInvocations(root)).length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    active.abort();
    await cancelled;
    assert.equal((await ghInvocations(root)).length, 1);
});

test("invalid authentication timeout bounds fail before any process", async (context) => {
    const root = await fakeEnvironment(context);
    assert.equal(GH_AUTH_TIMEOUT_MS, 10000);
    for (const value of [0, -1, 0.5, 10001, Number.NaN])
        await assert.rejects(resolveGhToken(request(undefined, value)), /invalid_auth_request/);
    assert.deepEqual(await ghInvocations(root), []);
});

const planSchema = z.object({
    status: z.literal("planned"),
    secretRead: z.literal(false),
    authorizationVerified: z.literal(false),
    credential: z.object({
        source: z.literal("gh-cli"),
        declaredClass: z.string(),
        candidateClass: z.string(),
    }),
    capabilities: z.array(z.object({ operation: z.string() })),
    grants: z.object({
        ghLoginMinimumScopes: z.array(z.string()),
        additionalOAuthScopes: z.array(z.string()),
        billingScopeRecipe: z.string(),
    }),
    operatorCommands: z.object({
        login: z.array(z.array(z.string())),
        refresh: z.array(z.array(z.string())),
    }),
    references: z.array(z.string().url()),
    caveats: z.array(z.string()),
});

test("offline plans disclose gh OAuth write reach without retrieving any token or escalating optional signals", async (context) => {
    const root = await fakeEnvironment(context);
    const config = configSchema.parse({
        org: "example-org",
        activity: { signals: ["push", "discussions", "actions"] },
    });
    const plan = planSchema.parse(
        authorizationPlan(config, getScenario("repository-activity-inventory")),
    );
    assert.equal(plan.credential.declaredClass, "none");
    assert.equal(plan.credential.candidateClass, "oauth");
    assert.deepEqual(plan.grants.ghLoginMinimumScopes, [
        "repo",
        "read:org",
        "gist",
    ]);
    assert.deepEqual(plan.grants.additionalOAuthScopes, []);
    assert.deepEqual(plan.operatorCommands.refresh, [
        ["gh", "auth", "refresh", "--hostname", "github.com"],
    ]);
    assert.ok(
        plan.capabilities.some((item) => item.operation === "activity.discussions"),
    );
    assert.ok(
        plan.capabilities.some((item) => item.operation === "activity.actions"),
    );
    assert.ok(!JSON.stringify(plan).includes("read:discussion"));
    assert.match(plan.caveats.join(" "), /cannot create a read-only credential/);
    assert.match(plan.caveats.join(" "), /Live\/API and Copilot-host acceptance remain pending/);
    assert.deepEqual(await ghInvocations(root), []);
});

test("billing plan keeps the classic-PAT candidate separate from unsupported scope guesses and inventory access", () => {
    const config = configSchema.parse({ org: "example-org" });
    const scenario = getScenario("repository-billing-report");
    const plan = planSchema.parse(
        authorizationPlan(config, scenario, { inventory: false }),
    );
    assert.equal(plan.credential.candidateClass, "classic-pat");
    assert.equal(plan.grants.billingScopeRecipe, "not-established");
    assert.deepEqual(plan.capabilities.map((item) => item.operation), [
        "billing.usage",
    ]);
    assert.deepEqual(plan.operatorCommands.refresh, []);
    assert.equal(plan.operatorCommands.login[0]?.at(-1), "--with-token");
    assert.match(plan.caveats.join(" "), /does not create one or set billing permissions/);
    assert.doesNotMatch(JSON.stringify(plan), /admin:org|manage_billing:enterprise/);
    for (const credentialClass of ["oauth", "fine-grained-pat", "app-user", "app-installation"]) {
        const unverified = planSchema.parse(
            authorizationPlan(
                configSchema.parse({
                    org: "example-org",
                    credential: { credentialClass },
                }),
                scenario,
            ),
        );
        assert.deepEqual(unverified.operatorCommands, { login: [], refresh: [] });
        assert.match(unverified.caveats.join(" "), /not verified support/);
    }
});
