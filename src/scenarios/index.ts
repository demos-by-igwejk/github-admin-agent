import type { ScenarioDefinition } from "../core/contracts.ts";
import { activityScenario } from "./repository-activity-inventory/index.ts";
import { billingScenario } from "./repository-billing-report/index.ts";
import { settingsScenario } from "./repository-settings-audit/index.ts";

export const scenarios: readonly ScenarioDefinition[] = Object.freeze([
    activityScenario,
    billingScenario,
    settingsScenario,
]);
const registry = new Map(
    scenarios.map((scenario) => [scenario.manifest.id, scenario]),
);

export function getScenario(id: string): ScenarioDefinition {
    const scenario = registry.get(id);
    if (!scenario)
        throw new Error(
            `unsupported_scenario: ${id} is not an implemented scenario; consult scenarios list`,
        );
    return scenario;
}
