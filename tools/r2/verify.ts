import { readFile } from "node:fs/promises";
import { verifyPublication, type IPublicationReceipt } from "./common";
const [base, receiptPath = ".local/r2-nasa-moon/latest.json"] = process.argv.slice(2);
if (!base) throw new Error("Usage: tsx tools/r2/verify.ts https://BUCKET.r2.dev [RECEIPT]");
const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as IPublicationReceipt;
await verifyPublication(base, receipt);
