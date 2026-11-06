import { mkdir, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";
import { adminSchemas } from "../packages/shared/src/admin";
import { publicSchemas } from "../packages/shared/src/schemas";
await mkdir("schemas", { recursive: true });
await mkdir("packages/shared/generated", { recursive: true });
for (const [name, schema] of Object.entries({ ...publicSchemas, ...adminSchemas })) {
    await writeFile("schemas/" + name + ".schema.json", JSON.stringify(schema, null, 2) + "\n");
    const types = await compile(JSON.parse(JSON.stringify(schema)) as Parameters<typeof compile>[0], name, {
        bannerComment: "/** Generated from the shared JSON schema. Do not edit by hand. */",
        additionalProperties: false,
    });
    await writeFile("packages/shared/generated/" + name + ".d.ts", types);
}
console.log("Shared JSON schemas and TypeScript declarations generated");
