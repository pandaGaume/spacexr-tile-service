import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** One local file and its relative public R2 object key. No credentials are stored here. */
export interface IPublicationObject {
    key: string;
    file: string;
    contentType: string;
}
/** Publication receipt used to verify exact remote bytes after upload. */
export interface IPublicationReceipt {
    bucket: string;
    prefix: string;
    objects: IPublicationObject[];
}
/** SHA-256 over the exact stored bytes, not a provider-specific ETag. */
export function digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}
/** Save bytes under the generated dataset directory and register their immutable key. */
export async function saveObject(
    directory: string,
    prefix: string,
    path: string,
    bytes: Uint8Array | string,
    contentType: string,
    objects: IPublicationObject[],
): Promise<void> {
    const file = resolve(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    objects.push({ key: `${prefix}/${path}`, file, contentType });
}
/** Run Wrangler with inherited authentication and without invoking a shell. */
async function uploadOne(bucket: string, object: IPublicationObject): Promise<void> {
    await new Promise<void>((accept, reject) => {
        const child = spawn(
            process.execPath,
            [
                resolve("node_modules/wrangler/bin/wrangler.js"),
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
                "public, max-age=31536000, immutable",
            ],
            { stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? accept() : reject(new Error(`Upload failed: ${object.key}`))));
    });
}
/** Retry transient CLI/network errors with bounded backoff. */
async function uploadWithRetry(bucket: string, object: IPublicationObject): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await uploadOne(bucket, object);
            return;
        } catch (error) {
            if (attempt === 2) throw error;
            await delay(1000 * 2 ** attempt);
        }
    }
}
/** Upload at most two independent objects at once. The preview is uploaded last. */
export async function uploadPublication(receipt: IPublicationReceipt): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(receipt.bucket)) throw new Error("Invalid bucket name");
    const queue = receipt.objects.filter((object) => !object.key.endsWith("/index.html"));
    let index = 0;
    await Promise.all(
        Array.from({ length: 2 }, async () => {
            while (index < queue.length) {
                const object = queue[index++];
                await uploadWithRetry(receipt.bucket, object);
            }
        }),
    );
    for (const object of receipt.objects.filter((object) => object.key.endsWith("/index.html")))
        await uploadWithRetry(receipt.bucket, object);
}
/** Verify all downloads, MIME types, byte hashes and browser CORS against a local receipt. */
export async function verifyPublication(baseUrl: string, receipt: IPublicationReceipt): Promise<void> {
    const base = new URL(baseUrl);
    if (base.protocol !== "https:") throw new Error("Public base URL must use HTTPS");
    for (const object of receipt.objects) {
        const response = await fetch(new URL(object.key, base.origin + "/"), {
            headers: { Origin: "http://127.0.0.1:8096" },
            signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${object.key}`);
        if (!response.headers.get("content-type")?.startsWith(object.contentType.split(";")[0]))
            throw new Error(`MIME mismatch: ${object.key}`);
        if (response.headers.get("access-control-allow-origin") !== "*")
            throw new Error(`Missing public CORS: ${object.key}`);
        if (digest(new Uint8Array(await response.arrayBuffer())) !== digest(await readFile(object.file)))
            throw new Error(`Hash mismatch: ${object.key}`);
    }
    console.log(`Verified ${receipt.objects.length} objects: HTTP, MIME, SHA-256 and CORS.`);
}
