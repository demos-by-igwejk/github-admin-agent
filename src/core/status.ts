import type { ExecutionStatus, WorkUnit } from "./contracts.ts";

export const EXIT_CODES: Readonly<Record<ExecutionStatus, number>> = {
    completed: 0,
    partial: 2,
    failed: 1,
    deferred: 3,
    cancelled: 130,
};
export function deriveStatus(
    work: readonly WorkUnit[],
    options: { cancelled?: boolean; fatal?: boolean; usable: boolean },
): ExecutionStatus {
    if (options.cancelled || work.some((unit) => unit.outcome === "cancelled"))
        return "cancelled";
    if (options.fatal || work.length === 0) return "failed";
    const required = work.filter((unit) => unit.required);
    if (
        required.some(
            (unit) =>
                unit.outcome === "failed" || unit.outcome === "unassessed",
        )
    )
        return options.usable ? "partial" : "failed";
    if (required.some((unit) => unit.outcome === "waiting")) return "deferred";
    return "completed";
}
