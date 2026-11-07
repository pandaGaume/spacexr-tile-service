import { resolve } from "node:path";
import { buildJezeroCtxCorrection, buildJezeroRefinement } from "./jezero-refinement";
import { createJezeroServer } from "./jezero-server";

const [command, ...args] = process.argv.slice(2);
let root = process.env.MARS_DATA_ROOT ?? "F:/MarsData";
let maxLOD = 14;
let port = 8794;
for (let index = 0; index < args.length; index += 2) {
    if (args[index] === "--root" && args[index + 1]) root = args[index + 1]!;
    else if (args[index] === "--max-lod" && args[index + 1]) maxLOD = Number(args[index + 1]);
    else if (args[index] === "--port" && args[index + 1]) port = Number(args[index + 1]);
    else throw new Error("Usage: npm run mars -- jezero-refine|jezero-refine-ctx-corrected|jezero-serve [--root DIRECTORY] [--max-lod 11..16] [--port PORT]");
}

if (command === "jezero-refine-ctx-corrected") {
    await buildJezeroCtxCorrection(resolve(root));
} else if (command === "jezero-refine") {
    await buildJezeroRefinement(resolve(root), maxLOD);
} else if (command === "jezero-serve") {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
    const server = createJezeroServer(resolve(root));
    await new Promise<void>((accept, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", accept);
    });
    console.log(`Jezero terrain: http://127.0.0.1:${port}/`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
} else {
    throw new Error("Usage: npm run mars -- jezero-refine|jezero-refine-ctx-corrected|jezero-serve [--root DIRECTORY] [--max-lod 11..16] [--port PORT]");
}
