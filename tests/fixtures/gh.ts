import { chmod, copyFile, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export function fakeGhEnvironment(root: string): NodeJS.ProcessEnv {
    return {
        PATH: join(root, "fake-gh-bin"),
        GH_CONFIG_DIR: join(root, "fake-gh-config"),
        GITHUB_ADMIN_TEST_GH_LOG: join(root, "fake-gh-invocations.jsonl"),
        GITHUB_ADMIN_TEST_GH_MODE: "unexpected",
    };
}

export async function installFakeGh(root: string): Promise<void> {
    const directory = join(root, "fake-gh-bin");
    await mkdir(directory, { recursive: true });
    const executable = join(directory, "gh");
    await copyFile(new URL("./gh.mjs", import.meta.url), executable);
    await chmod(executable, 0o700);
    await symlink(process.execPath, join(directory, "node"));
}

const invocationSchema = z.object({
    pid: z.number().int().positive(),
    argv: z.array(z.string()),
    controls: z.record(z.string(), z.string().nullable()),
    ghTokenPreserved: z.boolean(),
    githubTokenPreserved: z.boolean(),
});
export async function ghInvocations(root: string) {
    let content: string;
    try {
        content = await readFile(
            join(root, "fake-gh-invocations.jsonl"),
            "utf8",
        );
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return [];
        throw error;
    }
    return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => invocationSchema.parse(JSON.parse(line)));
}
