import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { MARS_REGIONS, REGIONAL_SCHEMA } from "../mars/regional-refinement";

interface IObject {
    key: string;
    file: string;
    bytes: number;
    modified: number;
    contentType: string;
    cacheControl: string;
}

interface IReceiptLine {
    key: string;
    bytes: number;
    modified: number;
}

const DEFAULT_MOON_ROOT = process.env.LUNAR_DATA_ROOT ?? "F:/LunarData";
const DEFAULT_MARS_ROOT = process.env.MARS_DATA_ROOT ?? "F:/MarsData";
const PREFIX = "cube";
const BUCKET = "planetary-tiles";

function parseArgs(): { moonRoot: string; marsRoot: string; bucket: string; concurrency: number; dryRun: boolean } {
    const values = new Map<string, string>();
    const rawArgs = process.argv.slice(2);
    const dryRun = rawArgs.includes("--dry-run");
    const args = rawArgs.filter((argument) => argument !== "--dry-run");
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (!name?.startsWith("--") || !value) throw new Error("Expected paired CLI options.");
        values.set(name, value);
    }
    const bucket = values.get("--bucket") ?? BUCKET;
    const concurrency = Number(values.get("--concurrency") ?? "8");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Invalid R2 bucket name.");
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
        throw new Error("Concurrency must be an integer from 1 to 32.");
    return {
        moonRoot: resolve(values.get("--moon-root") ?? DEFAULT_MOON_ROOT),
        marsRoot: resolve(values.get("--mars-root") ?? DEFAULT_MARS_ROOT),
        bucket,
        concurrency,
        dryRun,
    };
}

function toKey(path: string): string {
    return path.split(sep).join("/").replace(/^\/+/, "");
}

function contentType(path: string): string {
    switch (extname(path).toLowerCase()) {
        case ".png":
            return "image/png";
        case ".webp":
            return "image/webp";
        case ".json":
            return "application/json";
        case ".html":
            return "text/html; charset=utf-8";
        default:
            return "application/octet-stream";
    }
}

async function walk(directory: string): Promise<string[]> {
    const output: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) output.push(...(await walk(path)));
        else if (entry.isFile()) output.push(path);
    }
    return output;
}

async function addObject(
    objects: Map<string, IObject>,
    key: string,
    file: string,
    expectedBytes?: number,
): Promise<void> {
    const details = await stat(file);
    if (!details.isFile()) throw new Error(`Not a regular file: ${file}`);
    if (expectedBytes !== undefined && details.size !== expectedBytes)
        throw new Error(`Manifest size mismatch for ${file}: expected ${expectedBytes}, got ${details.size}`);
    const object: IObject = {
        key,
        file,
        bytes: details.size,
        modified: details.mtimeMs,
        contentType: contentType(file),
        cacheControl: key.endsWith("/catalog/latest-global.json")
            ? "public, max-age=60"
            : "public, max-age=31536000, immutable",
    };
    const previous = objects.get(key);
    if (previous && (previous.file !== object.file || previous.bytes !== object.bytes))
        throw new Error(`Duplicate R2 object key has conflicting source files: ${key}`);
    objects.set(key, object);
}

function portableSourcePath(value: string): string {
    const segments = value.split(/[\\/]+/).filter(Boolean);
    const sourceIndex = segments.findIndex((segment) => segment.toLowerCase() === "sources");
    return sourceIndex >= 0 ? segments.slice(sourceIndex).join("/") : (segments.at(-1) ?? value);
}

async function collectMoon(root: string, objects: Map<string, IObject>): Promise<{ revision: string; tiles: number }> {
    const pointerPath = resolve(root, "catalog/latest-global.json");
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { directory: string; revision: string };
    if (!/^[a-f0-9]{20}$/.test(pointer.revision) || pointer.directory !== `datasets/moon/global-${pointer.revision}`)
        throw new Error("The lunar latest-global pointer is invalid.");
    const directory = resolve(root, pointer.directory);
    if (!directory.startsWith(`${root}${sep}`)) throw new Error("Lunar publication path escapes its data root.");
    const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")) as {
        schema: string;
        status: string;
        revision: string;
        files: Array<{ path: string; bytes: number }>;
    };
    if (
        manifest.schema !== "lunar-global/1" ||
        manifest.status !== "verified" ||
        manifest.revision !== pointer.revision
    )
        throw new Error("The current lunar publication is not verified.");
    const expected = new Map(manifest.files.map((file) => [file.path, file.bytes]));
    for (const file of await walk(directory)) {
        const relativePath = toKey(relative(root, file));
        const datasetPath = toKey(relative(directory, file));
        if (datasetPath.startsWith(".rows/")) continue;
        await addObject(objects, `cube/moon/${relativePath}`, file, expected.get(datasetPath));
    }
    await addObject(objects, "cube/moon/catalog/latest-global.json", pointerPath);
    return { revision: pointer.revision, tiles: manifest.files.length };
}

/** The regional refinements of Mars, each with its manifest made portable and its tiles. */
async function collectMars(
    root: string,
    objects: Map<string, IObject>,
    staging: string,
): Promise<{ sources: string[]; tiles: number }> {
    const sources: string[] = [];
    let tiles = 0;
    for (const region of MARS_REGIONS) {
        const dataset = resolve(root, `datasets/mars/${region.id}`);
        const manifestPath = resolve(dataset, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
            schema: string;
            region: string;
            sources: Array<{ id: string; tiles: Array<{ path: string; bytes: number }>; file?: string }>;
            geoidSources?: Array<{ file?: string }>;
            baseSource?: { file?: string };
        };
        if (manifest.schema !== REGIONAL_SCHEMA || manifest.region !== region.id)
            throw new Error(`Unsupported ${region.id} manifest.`);
        const expected = new Map(
            manifest.sources.flatMap((source) => source.tiles.map((tile) => [toKey(tile.path), tile.bytes] as const)),
        );
        const portable = structuredClone(manifest);
        for (const source of portable.sources) if (source.file) source.file = portableSourcePath(source.file);
        for (const source of portable.geoidSources ?? [])
            if (source.file) source.file = portableSourcePath(source.file);
        if (portable.baseSource?.file) portable.baseSource.file = portableSourcePath(portable.baseSource.file);
        await mkdir(staging, { recursive: true });
        const safeManifest = resolve(staging, `mars-${region.id}-manifest.json`);
        await writeFile(
            safeManifest,
            `${JSON.stringify(portable, null, 2)}
`,
        );
        await addObject(objects, `cube/mars/datasets/mars/${region.id}/manifest.json`, safeManifest);
        for (const file of await walk(dataset)) {
            if (file.toLowerCase() === manifestPath.toLowerCase()) continue;
            const relativePath = toKey(relative(root, file));
            await addObject(objects, `cube/mars/${relativePath}`, file, expected.get(relativePath));
        }
        sources.push(...manifest.sources.map((source) => `${region.id}/${source.id}`));
        tiles += expected.size;
    }
    return { sources, tiles };
}

/** The global Mars revision of `npm run mars -- global-cube`, when one was built: its tree, then its pointer. */
async function collectMarsGlobal(
    root: string,
    objects: Map<string, IObject>,
): Promise<{ revision: string; tiles: number } | undefined> {
    const pointerPath = resolve(root, "catalog/latest-global.json");
    let pointer: { directory: string; revision: string };
    try {
        pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { directory: string; revision: string };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    if (!/^[a-f0-9]{20}$/.test(pointer.revision) || pointer.directory !== `datasets/mars/global-${pointer.revision}`)
        throw new Error("The Mars latest-global pointer is invalid.");
    const directory = resolve(root, pointer.directory);
    if (!directory.startsWith(`${root}${sep}`)) throw new Error("Mars publication path escapes its data root.");
    const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")) as {
        schema: string;
        status: string;
        revision: string;
        files: Array<{ path: string; bytes: number }>;
        imagery?: { files: Array<{ path: string; bytes: number }> };
    };
    if (manifest.schema !== "mars-global/1" || manifest.status !== "verified" || manifest.revision !== pointer.revision)
        throw new Error("The current Mars publication is not verified.");
    const listed = [...manifest.files, ...(manifest.imagery?.files ?? [])];
    const expected = new Map(listed.map((file) => [file.path, file.bytes]));
    for (const file of await walk(directory)) {
        const datasetPath = toKey(relative(directory, file));
        await addObject(objects, `cube/mars/${toKey(relative(root, file))}`, file, expected.get(datasetPath));
    }
    await addObject(objects, "cube/mars/catalog/latest-global.json", pointerPath);
    return { revision: pointer.revision, tiles: listed.length };
}

async function uploadOne(baseUrl: string, token: string, object: IObject): Promise<void> {
    const url = `${baseUrl}/${object.key.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, {
        method: "PUT",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": object.contentType,
            "cache-control": object.cacheControl,
        },
        body: await readFile(object.file),
        signal: AbortSignal.timeout(120000),
    });
    if (!response.ok)
        throw new Error(`R2 upload failed for ${object.key}: HTTP ${response.status} ${await response.text()}`);
}

async function uploadWithRetry(baseUrl: string, token: string, object: IObject): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            await uploadOne(baseUrl, token, object);
            return;
        } catch (error) {
            if (attempt === 3) throw error;
            await new Promise((accept) => setTimeout(accept, 1000 * 2 ** attempt));
        }
    }
}

async function availablePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((accept, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not reserve a local uploader port.");
    await new Promise<void>((accept, reject) => server.close((error) => (error ? reject(error) : accept())));
    return address.port;
}

async function startLocalUploader(
    bucket: string,
    directory: string,
): Promise<{ baseUrl: string; token: string; child: ReturnType<typeof spawn>; configPath: string }> {
    const port = await availablePort();
    const token = randomBytes(32).toString("hex");
    const configPath = resolve(directory, "wrangler-upload.jsonc");
    const mainPath = relative(dirname(configPath), resolve("tools/r2/cube-upload-worker.ts")).split(sep).join("/");
    const config = {
        name: "planetary-cube-upload-local",
        main: mainPath,
        compatibility_date: "2026-11-07",
        vars: { UPLOAD_TOKEN: token },
        r2_buckets: [{ binding: "BUCKET", bucket_name: bucket, remote: true }],
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const child = spawn(
        process.execPath,
        [
            resolve("node_modules/wrangler/bin/wrangler.js"),
            "dev",
            "--config",
            configPath,
            "--ip",
            "127.0.0.1",
            "--port",
            String(port),
        ],
        {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        },
    );
    let output = "";
    const capture = (chunk: Buffer) => {
        if (output.length < 6000) output += chunk.toString();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        for (let attempt = 0; attempt < 60; attempt++) {
            if (child.exitCode !== null) throw new Error(`Local R2 uploader exited during startup: ${output}`);
            try {
                const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
                if (response.ok && (await response.text()) === "ok") return { baseUrl, token, child, configPath };
            } catch {
                /* Wrangler is still starting. */
            }
            await new Promise((accept) => setTimeout(accept, 500));
        }
        throw new Error(`Local R2 uploader did not become ready: ${output}`);
    } catch (error) {
        child.kill();
        await unlink(configPath).catch(() => undefined);
        throw error;
    }
}

async function stopLocalUploader(child: ReturnType<typeof spawn>, configPath: string): Promise<void> {
    if (child.exitCode === null) {
        child.kill();
        await Promise.race([
            new Promise<void>((accept) => child.once("exit", () => accept())),
            new Promise<void>((accept) => setTimeout(accept, 5000)),
        ]);
    }
    await unlink(configPath).catch(() => undefined);
}

async function main(): Promise<void> {
    const options = parseArgs();
    const moonRoot = options.moonRoot;
    const marsRoot = options.marsRoot;
    const runDirectory = resolve(".local/r2-cube");
    await mkdir(runDirectory, { recursive: true });
    const objects = new Map<string, IObject>();
    const moon = await collectMoon(moonRoot, objects);
    const mars = await collectMars(marsRoot, objects, resolve(runDirectory, "staging"));
    const marsGlobal = await collectMarsGlobal(marsRoot, objects);
    const indexPath = resolve(runDirectory, "cube-catalog.json");
    await writeFile(
        indexPath,
        `${JSON.stringify(
            {
                schema: "spacexr-planetary-cube-catalog/1",
                bodies: {
                    moon: {
                        prefix: "cube/moon/",
                        latestPublication: "cube/moon/catalog/latest-global.json",
                        revision: moon.revision,
                    },
                    mars: {
                        prefix: "cube/mars/",
                        ...(marsGlobal
                            ? {
                                  latestPublication: "cube/mars/catalog/latest-global.json",
                                  revision: marsGlobal.revision,
                              }
                            : {}),
                        regions: Object.fromEntries(
                            MARS_REGIONS.map((region) => [
                                region.id,
                                `cube/mars/datasets/mars/${region.id}/manifest.json`,
                            ]),
                        ),
                    },
                },
            },
            null,
            2,
        )}\n`,
    );
    await addObject(objects, "cube/catalog.json", indexPath);

    const receiptPath = resolve(runDirectory, "publication.json");
    const receipt = Array.from(objects.values()).map(({ key, file, bytes, modified }) => ({
        key,
        file,
        bytes,
        modified,
    }));
    await writeFile(
        receiptPath,
        `${JSON.stringify({ bucket: options.bucket, prefix: PREFIX, moon, mars, marsGlobal, objects: receipt }, null, 2)}\n`,
    );
    const checkpointPath = resolve(runDirectory, "completed.jsonl");
    const completed = new Map<string, IReceiptLine>();
    try {
        for (const line of (await readFile(checkpointPath, "utf8")).split(/\r?\n/)) {
            if (!line) continue;
            try {
                const item = JSON.parse(line) as IReceiptLine;
                completed.set(item.key, item);
            } catch {
                /* Ignore a partial final checkpoint line. */
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const queue = Array.from(objects.values()).filter((object) => {
        const previous = completed.get(object.key);
        return !previous || previous.bytes !== object.bytes || previous.modified !== object.modified;
    });
    const totalBytes = Array.from(objects.values()).reduce((sum, object) => sum + object.bytes, 0);
    console.log(
        `R2 publication: ${options.bucket}/cube, ${objects.size} objects, ${(totalBytes / 1e9).toFixed(2)} GB.`,
    );
    console.log(
        `Moon: ${moon.tiles} tiles at revision ${moon.revision}. Mars: ${mars.tiles} tiles (${mars.sources.join(", ")}).`,
    );
    if (marsGlobal) console.log(`Mars global: ${marsGlobal.tiles} tiles at revision ${marsGlobal.revision}.`);
    console.log(`Uploading ${queue.length} remaining objects with concurrency ${options.concurrency}.`);
    if (options.dryRun) {
        for (const object of Array.from(objects.values()).slice(0, 12))
            console.log(`${object.key} (${object.bytes} bytes)`);
        console.log("Dry run complete. No R2 objects were changed.");
        return;
    }
    let cursor = 0;
    let uploaded = 0;
    let failure: unknown;
    let writes = Promise.resolve();
    let pendingLines: string[] = [];
    const flush = () => {
        if (pendingLines.length === 0) return writes;
        const chunk = `${pendingLines.splice(0).join("\n")}\n`;
        writes = writes.then(() => appendFile(checkpointPath, chunk));
        return writes;
    };
    const localUploader = await startLocalUploader(options.bucket, runDirectory);
    try {
        const workers = Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
            while (!failure) {
                const object = queue[cursor++];
                if (!object) return;
                try {
                    await uploadWithRetry(localUploader.baseUrl, localUploader.token, object);
                    pendingLines.push(
                        JSON.stringify({ key: object.key, bytes: object.bytes, modified: object.modified }),
                    );
                    if (pendingLines.length >= 32) await flush();
                    uploaded++;
                    if (uploaded % 500 === 0) {
                        await flush();
                        console.log(`Progress: ${uploaded}/${queue.length} uploaded in this run.`);
                    }
                } catch (error) {
                    failure = error;
                    await flush();
                }
            }
        });
        await Promise.all(workers);
        await flush();
    } finally {
        await stopLocalUploader(localUploader.child, localUploader.configPath);
    }
    if (failure) throw failure;
    const summary = {
        bucket: options.bucket,
        rootObject: "cube/catalog.json",
        moon: { revision: moon.revision, tiles: moon.tiles },
        mars: { tiles: mars.tiles, sources: mars.sources, ...(marsGlobal ? { global: marsGlobal } : {}) },
        objects: objects.size,
        bytes: totalBytes,
        uploadedAt: new Date().toISOString(),
    };
    await writeFile(resolve(runDirectory, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
        `Complete: ${objects.size} objects, ${(totalBytes / 1e9).toFixed(2)} GB uploaded to ${options.bucket}/cube/.`,
    );
    console.log(`Resume receipt: ${receiptPath}`);
}

await main();
