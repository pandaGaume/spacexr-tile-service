import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { GlobalMola } from "./global-mola";

interface ITileEntry {
    path: string;
    bytes: number;
    sha256: string;
}
interface IJezeroManifest {
    schema: string;
    sources: Array<{ id: string; tiles: ITileEntry[] }>;
}

const PAGE = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Mars, Jezero</title><style>body{max-width:900px;margin:24px auto;padding:0 18px;background:#101827;color:#e6edf5;font:16px system-ui}section{padding:18px;background:#192538;border-radius:10px;margin:16px 0}select{padding:8px;background:#273b55;color:white;border:1px solid #69839d;border-radius:5px;margin:4px}canvas{display:block;width:min(80vw,700px);height:auto;image-rendering:pixelated;background:#111;margin:16px auto}a{color:#9dd2ff}small{color:#aec1d5}</style>
<h1>Raffinement du cratère Jezero</h1><p>Terrain cubique Mars, DEM CTX 20 m et HiRISE 1 m, hauteurs encodées Terrarium.</p>
<section><label>Source <select id="source"></select></label><label>Niveau <select id="lod"></select></label><label>Tuile <select id="tile"></select></label><p><label><input id="trace" type="checkbox" checked> Tracer la ligne CTX (cyan)</label> · <a href="diagnostics/ctx-line.geojson">Tracé GeoJSON</a></p><p id="info">Chargement du manifeste...</p><canvas id="view" width="257" height="257"></canvas><small>Relief colorisé depuis les hauteurs de la tuile, avec ombrage local calculé au navigateur.</small><p><a href="manifest.json">Manifeste JSON</a></p></section>
<script>
const sourceSelect=document.querySelector('#source'),lodSelect=document.querySelector('#lod'),tileSelect=document.querySelector('#tile'),info=document.querySelector('#info'),canvas=document.querySelector('#view'),ctx=canvas.getContext('2d');let manifest,diagnostic;const params=new URLSearchParams(location.search);const traceReady=fetch('diagnostics/ctx-line.geojson').then(r=>r.ok?r.json():null).then(d=>diagnostic=d).catch(()=>null);
function traceOverlay(tile){if(!document.querySelector('#trace').checked||!diagnostic)return;const feature=diagnostic.features[0],points=feature.properties.points.filter(p=>p.face===tile.face);if(!points.length)return;const scale=2**(tile.lod-feature.properties.mosaic.lod);ctx.save();ctx.beginPath();points.forEach((p,i)=>{const x=((p.xTile+p.u)*scale-tile.x)*256,y=((p.yTile+p.v)*scale-tile.y)*256;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y)});ctx.strokeStyle='#00ffff';ctx.lineWidth=1.5;ctx.stroke();ctx.restore()}
document.querySelector('#trace').addEventListener('change',()=>{if(!manifest)return;const t=manifest.sources.flatMap(s=>s.tiles).find(t=>t.path===tileSelect.value);if(t)draw(t)});
function fill(select,values,label){select.innerHTML='';for(const value of values){const option=document.createElement('option');option.value=label?String(label(value)):String(value);option.textContent=label?label(value):String(value);select.append(option)}}
function draw(tile){traceReady.then(()=>fetch(tile.path)).then(r=>r.blob()).then(createImageBitmap).then(bitmap=>{ctx.drawImage(bitmap,0,0);const data=ctx.getImageData(0,0,257,257),p=data.data,h=new Float32Array(257*257);for(let i=0;i<h.length;i++)h[i]=p[i*4]*256+p[i*4+1]+p[i*4+2]/256-32768;for(let y=0;y<257;y++)for(let x=0;x<257;x++){const i=y*257+x,left=h[y*257+Math.max(0,x-1)],right=h[y*257+Math.min(256,x+1)],up=h[Math.max(0,y-1)*257+x],down=h[Math.min(256,y+1)*257+x],slope=Math.min(1,Math.hypot(right-left,down-up)/25),light=Math.max(.45,Math.min(1.4,1-(right-left+down-up)/80));let c;if(h[i]<-4000)c=[59,42,42];else if(h[i]<-3000)c=[119,62,44];else if(h[i]<-2000)c=[177,99,54];else if(h[i]<-1000)c=[207,151,82];else c=[226,198,140];for(let k=0;k<3;k++)p[i*4+k]=Math.min(255,Math.round(c[k]*light*(1-.18*slope)))}ctx.putImageData(data,0,0);traceOverlay(tile);info.textContent=tile.path+' | '+tile.bytes+' octets | '+(tile.sha256||'tuile MOLA calculée').slice(0,24)})}
function update(){const s=manifest.sources.find(v=>v.id===sourceSelect.value),lod=Number(lodSelect.value),tiles=s.tiles.filter(t=>t.lod===lod);tileSelect.innerHTML='';for(const t of tiles){const o=document.createElement('option');o.value=t.path;o.textContent=t.path.split('/').slice(-4).join('/');tileSelect.append(o)}if(tiles.length){const selected=tiles.find(t=>t.path===params.get('tile'))||tiles[0];tileSelect.value=selected.path;draw(selected)}}
fetch('manifest.json').then(r=>r.json()).then(m=>{manifest=m;fill(sourceSelect,m.sources,s=>s.id);if(m.sources.some(s=>s.id===params.get('source')))sourceSelect.value=params.get('source');sourceSelect.addEventListener('change',()=>{const s=manifest.sources.find(v=>v.id===sourceSelect.value);fill(lodSelect,[...new Set(s.tiles.map(t=>t.lod))].sort((a,b)=>a-b));if([...lodSelect.options].some(o=>o.value===params.get('lod')))lodSelect.value=params.get('lod');update()});lodSelect.addEventListener('change',update);tileSelect.addEventListener('change',()=>{const s=manifest.sources.find(v=>v.id===sourceSelect.value),t=s.tiles.find(v=>v.path===tileSelect.value);if(t)draw(t)});sourceSelect.dispatchEvent(new Event('change'))}).catch(e=>info.textContent=String(e));
</script></html>`;

/** Serve only the paths listed in the Jezero manifest to local terrain clients. */
export function createJezeroServer(root: string): Server {
    const global = new GlobalMola(root);
    const manifestPath = resolve(root, "datasets/mars/jezero/manifest.json");
    let inventory: Promise<{ bytes: Buffer; tiles: Map<string, ITileEntry> }> | undefined;
    const loadInventory = (): Promise<{ bytes: Buffer; tiles: Map<string, ITileEntry> }> =>
        (inventory ??= readFile(manifestPath).then(async (bytes) => {
            const manifest = JSON.parse(bytes.toString("utf8")) as IJezeroManifest;
            const tiles = new Map(
                manifest.sources.flatMap((source) => source.tiles.map((tile) => [`/${tile.path}`, tile])),
            );
            const hasGlobal = await global.available();
            const combined = {
                ...manifest,
                coverage: hasGlobal ? "global" : "regional",
                globalMaxLOD: hasGlobal ? 4 : null,
                sources: hasGlobal ? [global.source(), ...manifest.sources] : manifest.sources,
            };
            return { bytes: Buffer.from(JSON.stringify(combined)), tiles };
        }));
    return createServer(async (request, response) => {
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { Allow: "GET, HEAD" }).end();
            return;
        }
        const path = decodeURIComponent(request.url?.split("?")[0] ?? "/");
        try {
            if (path === "/diagnostics/ctx-line.geojson") {
                const bytes = await readFile(new URL("./diagnostics/ctx-line.geojson", import.meta.url));
                response.setHeader("Content-Type", "application/geo+json; charset=utf-8");
                response.setHeader("Cache-Control", "no-cache");
                response.writeHead(200).end(request.method === "HEAD" ? undefined : bytes);
                return;
            }
            const { bytes: manifestBytes, tiles } = await loadInventory();
            if (path === "/") {
                response.setHeader("Content-Type", "text/html; charset=utf-8");
                response.setHeader("Cache-Control", "no-cache");
                response.writeHead(200).end(request.method === "HEAD" ? undefined : PAGE);
                return;
            }
            if (path === "/manifest.json") {
                response.setHeader("Content-Type", "application/json; charset=utf-8");
                response.setHeader("Cache-Control", "no-cache");
                response.writeHead(200).end(request.method === "HEAD" ? undefined : manifestBytes);
                return;
            }
            const globalAddress = global.address(path);
            if (globalAddress) {
                const bytes = await global.tile(globalAddress);
                response.setHeader("Content-Type", "image/png");
                response.setHeader("Cache-Control", "public, max-age=3600");
                response.writeHead(200).end(request.method === "HEAD" ? undefined : bytes);
                return;
            }
            const tile = tiles.get(path);
            if (!tile) {
                response.writeHead(404).end("Unknown Jezero tile");
                return;
            }
            const file = resolve(root, tile.path);
            if ((await stat(file)).size !== tile.bytes) throw new Error("Tile size differs from its manifest entry");
            const bytes = await readFile(file);
            response.setHeader("Content-Type", "image/png");
            response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            response.setHeader("ETag", `"${tile.sha256}"`);
            response.writeHead(200).end(request.method === "HEAD" ? undefined : bytes);
        } catch (error) {
            const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
            response.writeHead(missing ? 503 : 500, { "Content-Type": "text/plain; charset=utf-8" });
            response.end(error instanceof Error ? error.message : String(error));
        }
    });
}
