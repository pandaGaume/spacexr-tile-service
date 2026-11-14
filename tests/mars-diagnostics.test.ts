import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { cubeTileDirection } from "@spacexr/tiles";
import { createJezeroServer } from "../tools/mars/jezero-server";

describe("CTX line diagnostic", () => {
    it("records positions inside four source tiles with consistent planetocentric coordinates", async () => {
        const json = JSON.parse(
            await readFile(new URL("../tools/mars/diagnostics/ctx-line.geojson", import.meta.url), "utf8"),
        );
        const feature = json.features[0];
        expect(feature.geometry.type).toBe("LineString");
        expect(feature.properties.tiles.map((t: { y: number }) => t.y)).toEqual([295, 296, 297, 298]);
        feature.properties.points.forEach(
            (p: { face: number; lod: number; xTile: number; yTile: number; u: number; v: number }, i: number) => {
                expect(p.u).toBeGreaterThan(0);
                expect(p.u).toBeLessThan(1);
                const d = cubeTileDirection({ face: p.face, lod: p.lod, x: p.xTile, y: p.yTile }, p.u, p.v);
                expect(feature.geometry.coordinates[i][0]).toBeCloseTo((Math.atan2(d.y, d.x) * 180) / Math.PI, 8);
                expect(feature.geometry.coordinates[i][1]).toBeCloseTo(
                    (Math.atan2(d.z, Math.hypot(d.x, d.y)) * 180) / Math.PI,
                    8,
                );
            },
        );
    });
    it("serves the diagnostic independently of the local corpus and keeps the preview script valid", async () => {
        const service = createJezeroServer("missing-fixture-root");
        const server = createServer((req, res) => service.emit("request", req, res));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const port = (server.address() as { port: number }).port;
            const response = await fetch(`http://127.0.0.1:${port}/diagnostics/ctx-line.geojson`);
            expect(response.status).toBe(200);
            expect(response.headers.get("Content-Type")).toContain("application/geo+json");
            expect((await response.json()).features).toHaveLength(1);
            const source = await readFile(new URL("../tools/mars/jezero-server.ts", import.meta.url), "utf8");
            const script = source.match(/<script>([\s\S]*?)<\/script>/)![1]!;
            expect(() => new Script(script)).not.toThrow();
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
