import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createJezeroServer } from "./mars/jezero-server";
import { createGlobalServer } from "./lunar/global-server";

const PAGE = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>SpaceXR Tile Service</title><style>body{max-width:850px;margin:32px auto;padding:0 20px;background:#101827;color:#e6edf5;font:16px system-ui}section{padding:20px;background:#192538;border-radius:12px;margin:20px 0}a{color:#9dd2ff}code{color:#d5e6f7}</style>
<h1>SpaceXR Tile Service</h1><p>Serveur local unique pour les jeux de tuiles planétaires.</p>
<section><h2>Lune</h2><p><a href="/moon/">Ouvrir l’aperçu lunaire</a></p><p><a href="/moon/manifest.json">Manifeste</a> · <a href="/moon/elevation.json">Descripteur DEM</a> · <a href="/moon/imagery.json">Descripteur imagerie</a></p></section>
<section><h2>Mars</h2><p><a href="/mars/">Ouvrir l’aperçu du cratère Jezero</a></p><p><a href="/mars/manifest.json">Manifeste Jezero</a></p></section>
<p>Les chemins d’API commencent par <code>/moon/</code> ou <code>/mars/</code>. Chaque corps conserve son manifeste, ses métadonnées et son schéma de tuiles.</p></html>`;

function routeTo(server: NodeJS.EventEmitter, prefix: string, request: IncomingMessage, response: ServerResponse): boolean {
    const original = request.url ?? "/";
    const pathname = original.split("?", 1)[0] ?? "/";
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
    const stripped = original.slice(prefix.length);
    request.url = stripped.startsWith("/") ? stripped : `/${stripped}`;
    server.emit("request", request, response);
    return true;
}

const [command, ...args] = process.argv.slice(2);
if (command !== "serve") throw new Error("Usage: npm run tiles:serve -- [--moon-root DIRECTORY] [--mars-root DIRECTORY] [--port PORT]");

let moonRoot = process.env.LUNAR_DATA_ROOT ?? "F:/LunarData";
let marsRoot = process.env.MARS_DATA_ROOT ?? "F:/MarsData";
let port = 8794;
for (let index = 0; index < args.length; index += 2) {
    if (args[index] === "--moon-root" && args[index + 1]) moonRoot = args[index + 1]!;
    else if (args[index] === "--mars-root" && args[index + 1]) marsRoot = args[index + 1]!;
    else if (args[index] === "--port" && args[index + 1]) port = Number(args[index + 1]);
    else throw new Error("Usage: npm run tiles:serve -- [--moon-root DIRECTORY] [--mars-root DIRECTORY] [--port PORT]");
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");

const moon = createGlobalServer(resolve(moonRoot), "/moon");
const mars = createJezeroServer(resolve(marsRoot));
const server = createServer((request, response) => {
    const pathname = request.url?.split("?", 1)[0] ?? "/";
    if (pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        response.end(request.method === "HEAD" ? undefined : PAGE);
    } else if (!routeTo(moon, "/moon", request, response) && !routeTo(mars, "/mars", request, response)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Unknown tile set");
    }
});

await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
});
console.log(`SpaceXR Tile Service: http://127.0.0.1:${port}/`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
