import { writeOpenApi } from "./openapi.mjs";
import { mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";
await mkdir("dist/admin", { recursive: true });
await Promise.all([
    build({
        entryPoints: ["apps/api/src/main.ts"],
        outfile: "dist/api/main.js",
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        sourcemap: true,
    }),
    build({
        entryPoints: ["apps/admin/src/app.ts"],
        outfile: "dist/admin/app.js",
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        sourcemap: true,
    }),
    copyFile("apps/admin/index.html", "dist/admin/index.html"),
]);
await writeOpenApi();
console.log("Administration API and frontend built in dist/.");
