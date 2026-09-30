import type { ActivityPolicy, Clock } from "./contracts.ts";

export const systemClock: Clock = {
    now: () => new Date(),
    sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(signal.reason);
                return;
            }
            const onAbort = () => {
                clearTimeout(timer);
                reject(signal?.reason);
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            signal?.addEventListener("abort", onAbort, { once: true });
        }),
};

export function validTimestamp(value: unknown): value is string {
    if (
        typeof value !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
    )
        return false;
    const instant = Date.parse(value);
    return (
        Number.isFinite(instant) &&
        new Date(instant).toISOString().slice(0, 19) === value.slice(0, 19)
    );
}

export function activityCutoff(now: Date, policy: ActivityPolicy): string {
    if (policy.window.kind === "days")
        return new Date(
            now.getTime() - policy.window.value * 86400000,
        ).toISOString();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() - policy.window.value;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(
        Date.UTC(
            year,
            month,
            Math.min(now.getUTCDate(), lastDay),
            now.getUTCHours(),
            now.getUTCMinutes(),
            now.getUTCSeconds(),
            now.getUTCMilliseconds(),
        ),
    ).toISOString();
}

export function lastCompletedMonth(now: Date): string {
    const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthBounds(
    month: string,
    now?: Date,
): { start: string; end: string } {
    if (!/^(19|20|21)\d\d-(0[1-9]|1[0-2])$/.test(month))
        throw new Error("invalid_month: Expected a UTC YYYY-MM month");
    const [year, number] = month.split("-").map(Number);
    const start = new Date(Date.UTC(year!, number! - 1, 1)).toISOString();
    const end = new Date(Date.UTC(year!, number!, 1)).toISOString();
    if (now && Date.parse(end) > now.getTime())
        throw new Error(
            "incomplete_month: Billing requires completed UTC calendar months",
        );
    return { start, end };
}

export function observedTimestamp(
    value: unknown,
    observedAt: string,
    skewSeconds: number,
): string | null {
    if (!validTimestamp(value) || !validTimestamp(observedAt)) return null;
    return Date.parse(value) <= Date.parse(observedAt) + skewSeconds * 1000
        ? value
        : null;
}
