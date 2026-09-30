import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { schemas } from "../src/schema-export.ts";

const check = process.argv.slice(2).includes("--check");
if (!check) await mkdir("schemas", { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
    const text = `${JSON.stringify(schema, null, 2)}\n`;
    const file = resolve("schemas", name);
    if (check) {
        const existing = await readFile(file, "utf8");
        if (existing !== text)
            throw new Error(
                `schema_drift: Regenerate ${name} with npm run schemas`,
            );
    } else await writeFile(file, text);
}
process.stdout.write(
    `${check ? "Verified" : "Generated"} ${Object.keys(schemas).length} schema artifacts from executable definitions.\n`,
);
