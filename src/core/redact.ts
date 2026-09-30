import { createHash } from "node:crypto";
import type { JsonValue } from "./contracts.ts";

const secretPattern =
    /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)/gi;
const secretKey =
    /^(?:authorization|token|password|secret|access_token|refresh_token|cookie|set-cookie)$/i;

export function redactText(
    value: string,
    secrets: readonly string[] = [],
): string {
    let result = value.replace(secretPattern, "[REDACTED]");
    for (const secret of secrets)
        if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
    return result;
}
export function redact(
    value: JsonValue,
    secrets: readonly string[] = [],
): JsonValue {
    if (typeof value === "string") return redactText(value, secrets);
    if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                secretKey.test(key) ? "[REDACTED]" : redact(item, secrets),
            ]),
        );
    return value;
}
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        const text = JSON.stringify(value);
        if (text === undefined)
            throw new Error("invalid_json: Undefined is not a hashable value");
        return text;
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
}
export function digest(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function csvText(value: string): string {
    const safe = /^[\s]*[=+@\-\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
}
