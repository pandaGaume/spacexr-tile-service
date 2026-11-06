import { readFile } from "node:fs/promises";
import { digest, uploadPublication, type IPublicationReceipt } from "./common";

/** Resume one exact publication. Existing public objects must match local bytes. */
async function main(): Promise<void> {
    const [baseUrl, receiptPath = ".local/r2-nasa-moon/latest.json"] = process.argv.slice(2);
    if (!baseUrl) throw new Error("Usage: tsx tools/r2/resume.ts https://BUCKET.r2.dev [RECEIPT]");
    const base = new URL(baseUrl);
    if (base.protocol !== "https:") throw new Error("Expected HTTPS public base URL");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as IPublicationReceipt;
    const missing: typeof receipt.objects = [];
    for (const object of receipt.objects) {
        const response = await fetch(new URL(object.key, base.origin + "/"), { signal: AbortSignal.timeout(30000) });
        if (response.status === 404) {
            missing.push(object);
            continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${object.key}`);
        if (digest(new Uint8Array(await response.arrayBuffer())) !== digest(await readFile(object.file)))
            throw new Error(`Immutable object differs: ${object.key}`);
    }
    console.log(`Resuming ${missing.length} missing objects of ${receipt.objects.length}.`);
    await uploadPublication({ ...receipt, objects: missing });
}
await main();
