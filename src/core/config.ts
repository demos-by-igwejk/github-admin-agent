import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
    configSchema,
    type Config,
    type JsonObject,
    type JsonValue,
    type ScenarioDefinition,
} from "./contracts.ts";
import { readJsonInput, resolveSafePath } from "./paths.ts";
import { digest } from "./redact.ts";

export const policySchema = z
    .strictObject({
        schemaVersion: z.literal("1"),
        name: z.string().min(1).max(200),
        rules: z
            .array(
                z.strictObject({
                    id: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/),
                    setting: z.enum([
                        "visibility",
                        "archived",
                        "default_branch",
                        "allow_merge_commit",
                        "allow_squash_merge",
                        "allow_rebase_merge",
                        "delete_branch_on_merge",
                    ]),
                    expected: z.union([z.boolean(), z.string().max(200)]),
                    repositories: z
                        .array(
                            z
                                .string()
                                .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/),
                        )
                        .optional(),
                }),
            )
            .min(1)
            .max(1000),
    })
    .superRefine((policy, context) => {
        const ids = new Set<string>();
        for (const [index, rule] of policy.rules.entries()) {
            if (ids.has(rule.id))
                context.addIssue({
                    code: "custom",
                    path: ["rules", index, "id"],
                    message: "Rule IDs must be unique",
                });
            ids.add(rule.id);
            if (rule.setting === "visibility") {
                if (
                    !["public", "private", "internal"].includes(
                        String(rule.expected),
                    )
                )
                    context.addIssue({
                        code: "custom",
                        path: ["rules", index, "expected"],
                        message:
                            "Visibility must be public, private, or internal",
                    });
            } else if (rule.setting === "default_branch") {
                if (
                    typeof rule.expected !== "string" ||
                    rule.expected.length === 0
                )
                    context.addIssue({
                        code: "custom",
                        path: ["rules", index, "expected"],
                        message: "Default branch must be a nonempty string",
                    });
            } else if (typeof rule.expected !== "boolean")
                context.addIssue({
                    code: "custom",
                    path: ["rules", index, "expected"],
                    message: "Setting requires a boolean",
                });
            for (const previous of policy.rules.slice(0, index)) {
                const overlaps =
                    !previous.repositories ||
                    !rule.repositories ||
                    previous.repositories.some((name) =>
                        rule.repositories?.some(
                            (other) =>
                                other.toLowerCase() === name.toLowerCase(),
                        ),
                    );
                if (
                    previous.setting === rule.setting &&
                    previous.expected !== rule.expected &&
                    overlaps
                )
                    context.addIssue({
                        code: "custom",
                        path: ["rules", index],
                        message:
                            "Contradictory rules overlap for the same setting",
                    });
            }
        }
    });
export type RepositoryPolicy = z.infer<typeof policySchema>;

export interface ConfigOverrides {
    org?: string;
    host?: string;
    profile?: string;
    credentialClass?: string;
    policyPath?: string;
    ownersPath?: string;
    reportsPath?: string;
    repositories?: string[];
    signals?: string[];
    maxAttempts?: number;
    maxElapsedMs?: number;
}

export async function configuredReportsPath(
    root: string,
    configPath?: string,
    override?: string,
): Promise<string> {
    if (override !== undefined) {
        await resolveSafePath(root, override);
        return override;
    }
    let raw: unknown;
    try {
        raw = await readJsonInput(
            root,
            configPath ?? "config/admin-agent.json",
        );
    } catch (error) {
        if (!configPath && isMissing(error)) return "reports";
        throw error;
    }
    rejectLegacyCredentialSource(raw);
    const config = configSchema.parse(raw);
    await resolveSafePath(root, config.reportsPath);
    return config.reportsPath;
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid_config: Configuration must be an object");
    return value as Record<string, unknown>;
}
function rejectLegacyCredentialSource(value: unknown): void {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return;
    if (
        "credential" in value &&
        value.credential !== null &&
        typeof value.credential === "object" &&
        Object.hasOwn(value.credential, "tokenEnv")
    )
        throw new Error(
            "legacy_credential_source: credential.tokenEnv is no longer supported; remove it, set credential.source to gh-cli, and provision the intended gh credential outside Copilot before a new live request",
        );
}
export async function loadConfiguration(
    root: string,
    path: string | undefined,
    overrides: ConfigOverrides = {},
): Promise<{ config: Config; overrides: string[] }> {
    let raw: Record<string, unknown> = {};
    try {
        raw = record(
            await readJsonInput(root, path ?? "config/admin-agent.json"),
        );
    } catch (error) {
        if (path || !isMissing(error)) throw error;
    }
    rejectLegacyCredentialSource(raw);
    const overrideKeys: string[] = [];
    const set = (key: string, value: unknown) => {
        if (value !== undefined) {
            raw[key] = value;
            overrideKeys.push(key);
        }
    };
    set("org", overrides.org);
    set("host", overrides.host);
    set("policyPath", overrides.policyPath);
    set("ownersPath", overrides.ownersPath);
    set("reportsPath", overrides.reportsPath);
    if (overrides.profile || overrides.credentialClass) {
        const credential =
            raw.credential === undefined ? {} : record(raw.credential);
        set("credential", {
            ...credential,
            ...(overrides.profile ? { name: overrides.profile } : {}),
            ...(overrides.credentialClass
                ? { credentialClass: overrides.credentialClass }
                : {}),
        });
    }
    if (overrides.repositories)
        set("selection", {
            ...(raw.selection === undefined ? {} : record(raw.selection)),
            repositories: overrides.repositories,
        });
    if (overrides.signals)
        set("activity", {
            ...(raw.activity === undefined ? {} : record(raw.activity)),
            signals: overrides.signals,
        });
    if (
        overrides.maxAttempts !== undefined ||
        overrides.maxElapsedMs !== undefined
    )
        set("budgets", {
            ...(raw.budgets === undefined ? {} : record(raw.budgets)),
            ...(overrides.maxAttempts !== undefined
                ? { maxAttempts: overrides.maxAttempts }
                : {}),
            ...(overrides.maxElapsedMs !== undefined
                ? { maxElapsedMs: overrides.maxElapsedMs }
                : {}),
        });
    if (raw.host !== undefined && raw.host !== "github.com")
        throw new Error(
            "unsupported_deployment: Release 1 supports only github.com; no API-origin fallback is allowed",
        );
    const config = configSchema.parse(raw);
    const seen = new Set<string>();
    for (const repository of config.selection.repositories) {
        if (
            repository.split("/")[0]?.toLowerCase() !== config.org.toLowerCase()
        )
            throw new Error(
                "scope_mismatch: Every repository must belong to the configured organization",
            );
        if (seen.has(repository.toLowerCase()))
            throw new Error(
                "duplicate_target: Repository selectors must be unique",
            );
        seen.add(repository.toLowerCase());
    }
    await Promise.all(
        [config.reportsPath, config.policyPath, config.ownersPath].map(
            (relative) => resolveSafePath(root, relative),
        ),
    );
    return { config, overrides: overrideKeys };
}

export function parseOwners(text: string, org: string): JsonObject {
    if (Buffer.byteLength(text) > 1024 * 1024)
        throw new Error("owners_too_large: Ownership mapping exceeds 1 MiB");
    const records: string[][] = [];
    let row: string[] = [],
        field = "",
        quoted = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index]!;
        if (char === '"') {
            if (quoted && text[index + 1] === '"') {
                field += '"';
                index++;
            } else if (quoted || field.length === 0) quoted = !quoted;
            else throw new Error("invalid_owners: Invalid CSV quoting");
        } else if (char === "," && !quoted) {
            row.push(field);
            field = "";
        } else if (char === "\n" && !quoted) {
            row.push(field.replace(/\r$/, ""));
            records.push(row);
            row = [];
            field = "";
        } else field += char;
    }
    if (quoted) throw new Error("invalid_owners: Unterminated CSV field");
    if (field.length > 0 || row.length > 0) {
        row.push(field.replace(/\r$/, ""));
        records.push(row);
    }
    if (records[0]?.join(",") !== "repository,owner")
        throw new Error("invalid_owners: Expected repository,owner CSV header");
    const result: JsonObject = {};
    for (const columns of records.slice(1)) {
        if (columns.length === 1 && columns[0] === "") continue;
        const [repository, owner] = columns;
        if (
            columns.length !== 2 ||
            !repository ||
            !owner ||
            !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository) ||
            repository.split("/")[0]?.toLowerCase() !== org.toLowerCase()
        )
            throw new Error(
                "invalid_owners: Each ownership row needs an in-scope repository and owner",
            );
        const key = repository.toLowerCase();
        if (Object.hasOwn(result, key))
            throw new Error(
                "duplicate_owner: Ownership mapping has duplicate repository keys",
            );
        result[key] = owner;
    }
    return result;
}

export async function loadScenarioInputs(
    root: string,
    config: Config,
    scenario: ScenarioDefinition,
): Promise<Record<string, JsonValue>> {
    const inputs: Record<string, JsonValue> = {};
    for (const input of scenario.manifest.inputs) {
        const path =
            input.name === "policy"
                ? config.policyPath
                : input.name === "owners"
                  ? config.ownersPath
                  : input.defaultPath;
        try {
            if (input.name === "owners")
                inputs.owners = parseOwners(
                    await readFile(
                        await resolveSafePath(root, path, { mustExist: true }),
                        "utf8",
                    ),
                    config.org,
                );
            else if (input.name === "policy")
                inputs.policy = policySchema.parse(
                    await readJsonInput(root, path),
                );
            else
                throw new Error(
                    `unsupported_input: Input ${input.name} needs a reviewed loader`,
                );
        } catch (error) {
            if (input.required || !isMissing(error)) throw error;
        }
    }
    return inputs;
}

export function inputDigest(
    input: JsonObject,
    inputs: Record<string, JsonValue>,
): string {
    return digest({ input, inputs });
}
