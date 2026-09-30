import { test } from "node:test";
import assert from "node:assert/strict";
import { policySchema, parseOwners } from "../../src/core/config.ts";
import { configuredReportsPath, loadConfiguration } from "../../src/core/config.ts";
import { configSchema } from "../../src/core/contracts.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryProject } from "./storage-fixtures.ts";

test("credential configuration defaults to gh-cli without inferring token class and rejects legacy secret references", async (context) => {
    const root = await temporaryProject(context, "gh-config");
    const config = configSchema.parse({ org: "example-org" });
    assert.deepEqual(config.credential, {
        name: "restricted-reader",
        credentialClass: "none",
        source: "gh-cli",
    });
    assert.throws(() => configSchema.parse({
        org: "example-org",
        credential: { source: "environment" },
    }));
    await writeFile(join(root, "legacy.json"), JSON.stringify({
        org: "example-org",
        credential: { tokenEnv: "GITHUB_ADMIN_TOKEN" },
    }));
    await assert.rejects(loadConfiguration(root, "legacy.json"), /legacy_credential_source.*remove it.*gh-cli/);
    await assert.rejects(configuredReportsPath(root, "legacy.json"), /legacy_credential_source/);
    const loaded = await loadConfiguration(root, undefined, {
        org: "example-org",
        profile: "operator-assisted-local",
        credentialClass: "oauth",
    });
    assert.equal(loaded.config.credential.source, "gh-cli");
    assert.equal(loaded.config.credential.credentialClass, "oauth");
});

test("policy vocabulary, rule identities and expected types are strict", () => {
    const rule = { id: "private", setting: "visibility", expected: "private" };
    assert.equal(
        policySchema.parse({
            schemaVersion: "1",
            name: "baseline",
            rules: [rule],
        }).rules.length,
        1,
    );
    assert.throws(() =>
        policySchema.parse({
            schemaVersion: "1",
            name: "baseline",
            rules: [{ ...rule, expected: true }],
        }),
    );
    assert.throws(() =>
        policySchema.parse({
            schemaVersion: "1",
            name: "baseline",
            rules: [rule, rule],
        }),
    );
    assert.throws(() =>
        policySchema.parse({
            schemaVersion: "1",
            name: "baseline",
            rules: [{ ...rule, setting: "delete_repository" }],
        }),
    );
});
test("ownership inputs are scoped, duplicate-safe and support quoted CSV", () => {
    assert.deepEqual(
        parseOwners(
            'repository,owner\nexample-org/api,"Platform, team"\n',
            "example-org",
        ),
        { "example-org/api": "Platform, team" },
    );
    assert.throws(() =>
        parseOwners("repository,owner\nother-org/api,team\n", "example-org"),
    );
    assert.throws(() =>
        parseOwners(
            "repository,owner\nexample-org/api,A\nexample-org/API,B\n",
            "example-org",
        ),
    );
    assert.throws(() =>
        parseOwners(
            'repository,owner\nexample-org/api,"unfinished',
            "example-org",
        ),
    );
});
