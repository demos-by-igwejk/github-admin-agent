import { z } from "zod";
import { configSchema, scenarioResultSchema } from "./core/contracts.ts";
import { policySchema } from "./core/config.ts";
import { resultEnvelopeSchema } from "./core/envelope.ts";
import { scenarios } from "./scenarios/index.ts";

export const schemas = {
    "configuration.schema.json": z.toJSONSchema(configSchema),
    "repository-policy.schema.json": z.toJSONSchema(policySchema),
    "scenario-result.schema.json": z.toJSONSchema(scenarioResultSchema),
    "result-envelope.schema.json": z.toJSONSchema(resultEnvelopeSchema),
    ...Object.fromEntries(
        scenarios.flatMap((scenario) => [
            [
                `${scenario.manifest.id}.input.schema.json`,
                z.toJSONSchema(scenario.inputSchema),
            ],
            [
                `${scenario.manifest.id}.result.schema.json`,
                z.toJSONSchema(scenario.resultSchema),
            ],
        ]),
    ),
};
