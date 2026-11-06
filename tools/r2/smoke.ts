import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { BodyRegistry } from "@spacexr-service/body-adapter";
import { buildSyntheticDataset } from "@spacexr-service/tile2d-builder";
import type { IBodyProfile } from "@spacexr-service/shared";

/** Generate a small, explicitly synthetic R2 fixture. Pass --upload BUCKET to publish it. */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const bucket = args[0] === "--upload" ? args[1] : undefined;
    if (args.length && (!bucket || args.length !== 2 || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))) {
        throw new Error("Usage: tsx tools/r2-smoke.ts [--upload BUCKET]");
    }
    // A fresh prefix prevents this smoke test from replacing an earlier publication.
    const revision = randomUUID();
    const prefix = `smoke/${revision}`;
    const directory = resolve(".local/r2-smoke", revision);
    const objects: { key: string; file: string; contentType: string }[] = [];
    const profiles: IBodyProfile[] = ["Moon", "Mars"].map((name) => ({
        id: name.toLowerCase(),
        catalogueName: name,
        referenceFrame: `body-fixed:${name.toLowerCase()}`,
        latitudeType: "planetographic",
        longitudeDirection: "east-positive",
        verticalDatum: "reference-ellipsoid",
    }));
    const bodies = new BodyRegistry(profiles);
    for (const profile of profiles) {
        for await (const object of buildSyntheticDataset({
            instanceId: "r2-test",
            id: `${profile.id}-synthetic`,
            revision,
            body: bodies.get(profile.id),
            maxLevel: 0,
            terrarium: true,
        })) {
            const file = resolve(directory, profile.id, object.path);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, object.bytes);
            objects.push({ key: `${prefix}/${profile.id}/${object.path}`, file, contentType: object.contentType });
        }
    }
    const file = resolve(directory, "index.html");
    const sections = profiles
        .map(
            ({ id, catalogueName }) =>
                `<section><h2>${catalogueName}</h2><p><a href="${id}/manifest.json">Manifest</a></p><div class="tiles"><img alt="Western root" src="${id}/imagery/0/0/0.webp"><img alt="Eastern root" src="${id}/imagery/0/1/0.webp"></div><p>Terrarium DEM: <a href="${id}/dem/0/0/0.png">west</a>, <a href="${id}/dem/0/1/0.png">east</a>.</p></section>`,
        )
        .join("");
    await writeFile(
        file,
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>R2 tile smoke test</title><style>body{background:#111827;color:#e5e7eb;font:16px system-ui;max-width:960px;margin:32px auto;padding:16px}a{color:#93c5fd}.tiles{display:flex}.tiles img{width:50%;height:auto}</style><h1>R2 tile smoke test</h1><p>SYNTHETIC DATA. These analytical fixtures test transport and geographic 2x1 addressing. They are not NASA images or measured elevations.</p>${sections}</html>`,
    );
    objects.push({ key: `${prefix}/index.html`, file, contentType: "text/html; charset=utf-8" });
    await mkdir(resolve(".local/r2-smoke"), { recursive: true });
    await writeFile(resolve(".local/r2-smoke/latest.json"), JSON.stringify({ bucket, prefix, objects }, null, 2));
    if (bucket) {
        // Wrangler owns authentication. No credentials enter this script or its output.
        const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
        for (const object of objects) {
            const result = spawnSync(
                process.execPath,
                [
                    wrangler,
                    "r2",
                    "object",
                    "put",
                    `${bucket}/${object.key}`,
                    "--remote",
                    "--file",
                    object.file,
                    "--content-type",
                    object.contentType,
                    "--cache-control",
                    "public, max-age=3600",
                ],
                { stdio: "inherit" },
            );
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error(`Upload failed: ${object.key}`);
        }
    }
    console.log(
        JSON.stringify({ bucket, prefix, files: objects.length, preview: `${prefix}/index.html`, directory }, null, 2),
    );
}

await main();
