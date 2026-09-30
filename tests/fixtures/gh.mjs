#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const mode = process.env.GITHUB_ADMIN_TEST_GH_MODE ?? "unexpected";
appendFileSync(
    process.env.GITHUB_ADMIN_TEST_GH_LOG,
    `${JSON.stringify({
        pid: process.pid,
        argv: process.argv.slice(2),
        controls: Object.fromEntries(
            [
                "GH_DEBUG",
                "DEBUG",
                "GH_FORCE_TTY",
                "GH_PAGER",
                "PAGER",
                "GH_PROMPT_DISABLED",
                "GH_NO_UPDATE_NOTIFIER",
                "GH_NO_EXTENSION_UPDATE_NOTIFIER",
                "GH_TELEMETRY",
            ].map((name) => [name, process.env[name] ?? null]),
        ),
        ghTokenPreserved: process.env.GH_TOKEN === "fixture-gh-token",
        githubTokenPreserved:
            process.env.GITHUB_TOKEN === "fixture-github-token",
    })}\n`,
);
const expected = ["auth", "token", "--hostname", "github.com"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected))
    throw new Error("unexpected_test_auth_command");
const token = "synthetic-gh-credential-not-a-real-token";
if (mode === "success") process.stdout.write(`${token}\n`);
else if (mode === "failure") {
    process.stdout.write(`${token}\n`);
    process.stderr.write(`private-auth-failure ${token}\n`);
    process.exitCode = 1;
} else if (mode === "empty") process.stdout.write("");
else if (mode === "malformed") process.stdout.write("invalid token\n");
else if (mode === "multiline") process.stdout.write(`${token}\nother-line\n`);
else if (mode === "invalid-encoding")
    process.stdout.write(Buffer.from([0xff]));
else if (mode === "oversized-stdout")
    process.stdout.write("x".repeat(17 * 1024));
else if (mode === "oversized-stderr")
    process.stderr.write("x".repeat(17 * 1024));
else if (mode === "combined-output") {
    process.stdout.write("x".repeat(9 * 1024));
    process.stderr.write("x".repeat(9 * 1024));
} else if (mode === "hang") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
} else {
    process.stderr.write("unexpected_test_credential_retrieval\n");
    process.exitCode = 97;
}
