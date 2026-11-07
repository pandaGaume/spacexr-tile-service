import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { createHeightGrid, encodeTerrariumGrid } from "@spacexr/dem";
import { cubeTileDirection, type ITileAddress } from "@spacexr/tiles";

const SIZE = 256;
const MAX_LOD = 4;
const WIDTH = 5760;
const HEIGHT = 2880;
const PREFIX = "global-mola-16ppd-v1";

/** Global MOLA radii, reprojected along planetocentric rays onto Mars 2000. */
export class GlobalMola {
    private grid?: Promise<Buffer>;
    private readonly cache = new Map<string, Promise<Buffer>>();

    public constructor(private readonly root: string) {}

    public async available(): Promise<boolean> {
        try {
            return (await stat(resolve(this.root, "sources/mola/meg016/megr90n000eb.img"))).size === WIDTH * HEIGHT * 2;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }

    public source() {
        const tiles = [];
        for (let face = 0; face < 6; face++)
            for (let lod = 0; lod <= MAX_LOD; lod++)
                for (let y = 0; y < 2 ** lod; y++)
                    for (let x = 0; x < 2 ** lod; x++)
                        tiles.push({
                            face,
                            lod,
                            x,
                            y,
                            minHeight: -32768,
                            maxHeight: 32768,
                            path: `${PREFIX}/${face}/${lod}/${x}/${y}.png`,
                        });
        return { id: "mola-16ppd", resolutionMetres: 3705, tiles };
    }

    public address(path: string): ITileAddress | undefined {
        const match = new RegExp(`^/${PREFIX}/([0-5])/(\\d+)/(\\d+)/(\\d+)\\.png$`).exec(path);
        if (!match) return undefined;
        const [face, lod, x, y] = match.slice(1).map(Number) as [number, number, number, number];
        return lod <= MAX_LOD && x < 2 ** lod && y < 2 ** lod ? { face, lod, x, y } : undefined;
    }

    public tile(address: ITileAddress): Promise<Buffer> {
        const key = `${address.face}/${address.lod}/${address.x}/${address.y}`;
        const previous = this.cache.get(key);
        if (previous) return previous;
        const pending = this.build(address).catch((error: unknown) => {
            this.cache.delete(key);
            throw error;
        });
        this.cache.set(key, pending);
        if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
        return pending;
    }

    private async build(address: ITileAddress): Promise<Buffer> {
        const bytes = await (this.grid ??= readFile(resolve(this.root, "sources/mola/meg016/megr90n000eb.img"))
            .then((data) => {
                if (data.length !== WIDTH * HEIGHT * 2) throw new Error("Invalid MOLA MEGR 16 ppd raster");
                return data;
            })
            .catch((error: unknown) => {
                this.grid = undefined;
                throw error;
            }));
        const sample = (latitude: number, longitude: number): number => {
            const px = (((longitude % 360) + 360) % 360) * 16 - 0.5;
            const py = (90 - latitude) * 16 - 0.5;
            const x = Math.floor(px),
                y = Math.floor(py),
                fx = px - x,
                fy = py - y;
            const value = (dx: number, dy: number) =>
                bytes.readInt16BE((Math.max(0, Math.min(HEIGHT - 1, y + dy)) * WIDTH + ((x + dx + WIDTH) % WIDTH)) * 2);
            return (
                3396000 +
                (value(0, 0) * (1 - fx) + value(1, 0) * fx) * (1 - fy) +
                (value(0, 1) * (1 - fx) + value(1, 1) * fx) * fy
            );
        };
        const heights = new Float32Array((SIZE + 1) ** 2);
        for (let y = 0; y <= SIZE; y++)
            for (let x = 0; x <= SIZE; x++) {
                const d = cubeTileDirection(address, x / SIZE, y / SIZE);
                const radius = sample(
                    (Math.atan2(d.z, Math.hypot(d.x, d.y)) * 180) / Math.PI,
                    (Math.atan2(d.y, d.x) * 180) / Math.PI,
                );
                const reference = 1 / Math.sqrt((d.x * d.x + d.y * d.y) / 3396190 ** 2 + (d.z * d.z) / 3376200 ** 2);
                heights[y * (SIZE + 1) + x] = radius - reference;
            }
        const encoded = encodeTerrariumGrid(createHeightGrid(SIZE + 1, SIZE + 1, heights));
        return sharp(encoded.data, { raw: { width: SIZE + 1, height: SIZE + 1, channels: 4 } })
            .png()
            .toBuffer();
    }
}
