import { resolve } from "node:path";
import { buildGlobalMars } from "./global-cube";
import { buildJezeroCtxCorrection, buildRegionalRefinement, MARS_REGIONS } from "./regional-refinement";
import { createJezeroServer } from "./jezero-server";
import { buildMoricImagery } from "./imagery/moric-imagery";

const USAGE = `Usage: npm run mars -- global-cube|imagery-moric|refine|jezero-refine-ctx-corrected|jezero-serve [--root DIRECTORY] [--region ${MARS_REGIONS.map((region) => region.id).join("|")}] [--port PORT]`;

const [command, ...args] = process.argv.slice(2);
let root = process.env.MARS_DATA_ROOT ?? "F:/MarsData";
let regionId: string | undefined;
let port = 8794;
for (let index = 0; index < args.length; index += 2) {
    if (args[index] === "--root" && args[index + 1]) root = args[index + 1]!;
    else if (args[index] === "--region" && args[index + 1]) regionId = args[index + 1]!;
    else if (args[index] === "--port" && args[index + 1]) port = Number(args[index + 1]);
    else throw new Error(USAGE);
}

if (command === "global-cube") {
    await buildGlobalMars(resolve(root));
} else if (command === "imagery-moric") {
    await buildMoricImagery(resolve(root));
} else if (command === "refine") {
    const regions = regionId ? MARS_REGIONS.filter((region) => region.id === regionId) : MARS_REGIONS;
    if (regions.length === 0) throw new Error(USAGE);
    for (const region of regions) await buildRegionalRefinement(resolve(root), region);
} else if (command === "jezero-refine-ctx-corrected") {
    await buildJezeroCtxCorrection(resolve(root));
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
    throw new Error(USAGE);
}
