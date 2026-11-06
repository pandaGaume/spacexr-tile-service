import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** Initialize local credentials once, build the shell and apply local-only D1 migrations. */
async function main(): Promise<void> {
    let variables = "";
    try {
        variables = await readFile(".dev.vars", "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!/^OWNER_TOKEN=/m.test(variables)) variables += `\nOWNER_TOKEN=${randomBytes(32).toString("hex")}\n`;
    if (!/^BUILD_TOKEN=/m.test(variables)) variables += `BUILD_TOKEN=${randomBytes(32).toString("hex")}\n`;
    await writeFile(".dev.vars", variables, { mode: 0o600 });
    for (const args of [
        ["scripts/build.mjs"],
        [
            resolve("node_modules/wrangler/bin/wrangler.js"),
            "d1",
            "migrations",
            "apply",
            "DB",
            "--local",
            "--config",
            "wrangler.admin.jsonc",
        ],
    ]) {
        const child = spawnSync(process.execPath, args, { stdio: "inherit" });
        if (child.error) throw child.error;
        if (child.status !== 0) throw new Error("Local setup failed");
    }
    console.log("Local setup ready. Credentials are in ignored .dev.vars. Run npm run admin:dev.");
}
await main();
