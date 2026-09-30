import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { scenarios, getScenario } from "../src/scenarios/index.ts";

test("registry, schemas, native skills and docs identify exactly the supported scenarios", async () => {
    assert.equal(
        new Set(scenarios.map((item) => item.manifest.id)).size,
        scenarios.length,
    );
    const readme = await readFile("README.md", "utf8");
    for (const scenario of scenarios) {
        const manifest = scenario.manifest;
        assert.match(manifest.id, /^[a-z][a-z0-9-]+$/);
        assert.equal(manifest.status, "implemented");
        assert.equal(manifest.risk, "read-only");
        assert.deepEqual(manifest.modes, ["inspect"]);
        assert.equal(getScenario(manifest.id), scenario);
        assert.ok(manifest.capabilities.length > 0);
        assert.ok(manifest.views.defaultRows > 0);
        assert.ok(manifest.views.defaultRows <= manifest.views.maxRows);
        const skill = await readFile(manifest.skill, "utf8");
        assert.match(skill, new RegExp(`name: ${manifest.id}\\s`));
        assert.ok(readme.includes(manifest.id));
        const generated = JSON.parse(
            await readFile(`schemas/${manifest.id}.input.schema.json`, "utf8"),
        );
        assert.deepEqual(generated, z.toJSONSchema(scenario.inputSchema));
    }
    assert.throws(
        () => getScenario("test-runner-conformance"),
        /unsupported_scenario/,
    );
    assert.throws(() => getScenario("../../anything"), /unsupported_scenario/);
});
