# R2 publication scripts

Run these commands from the repository root with Node.js 22 or later. Wrangler uses your local Cloudflare OAuth session. No credentials belong in this directory.

## Cloudflare setup

```powershell
npx wrangler login
npx wrangler r2 bucket create planetary-tiles-test
npx wrangler r2 bucket cors set planetary-tiles-test --file deployments/r2-test-cors.json
npx wrangler r2 bucket dev-url enable planetary-tiles-test
```

Create the bucket once. Enabling its development URL exposes all its objects publicly. This test bucket contains only public fixtures and NASA-derived maps. Its CORS policy permits GET and HEAD from any origin. The r2.dev URL is for development, without the custom-domain CDN cache.

## Synthetic fixtures

```powershell
npm run r2:smoke
npm run r2:smoke -- --upload planetary-tiles-test
```

Generates global level-zero imagery and Terrarium DEMs for Moon and Mars. These are explicitly synthetic, not NASA measurements. The receipt is `.local/r2-smoke/latest.json`.

## NASA lunar imagery and elevation

```powershell
npm run r2:moon
npm run r2:moon -- --upload planetary-tiles-test
```

The first command generates files locally. The second generates a fresh revision and uploads it. Each revision has a UUID prefix; previous publications are preserved. Uploads use two concurrent Wrangler processes, and the preview page is uploaded last. The receipt is `.local/r2-nasa-moon/latest.json`. Files and downloaded sources stay under ignored `.local/` directories.

The publication contains:

- 42 WebP imagery tiles, 256 by 256, levels 0 through 2.
- 10 Terrarium PNG elevation tiles, 257 by 257 vertices, levels 0 and 1.
- The same 10 elevation grids as little-endian Float32 metres.
- `manifest.json`, `source.json` and an interactive `index.html` preview with imagery and DEM modes.

Source: [NASA SVS CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/). The exact input bytes are pinned by SHA-256 in `nasa-moon.ts`.

`lroc_color_2k.jpg` is a 2048 by 1024 visualization derived from LROC observations. Its exposure and white balance are adjusted; missing polar areas use LOLA albedo, and gaps may be inpainted. It is not calibrated radiometry. The complete dataset therefore uses visualization provenance even though its elevation source is numeric LOLA data.

`ldem_4.tif` contains 1440 by 720 Float32 heights in kilometres, relative to a lunar reference sphere of radius 1,737,400 metres. Output values multiply the samples by 1,000. They are not derived from the JPEG displacement preview. The TIFF does not contain georeferencing tags; this adapter explicitly interprets the global cylindrical atlas as pixel-centred over longitude -180 to 180 and latitude 90 to -90. This registration convention must be checked against the original PDS labels before precision applications.

Sampling is bilinear, periodic in longitude, clamped at the source polar rows. Exact pole vertices use the corresponding row mean to avoid multiple elevations at one pole. The source's zero-filled first row is preserved, with this limitation recorded in `source.json`; finite zero values are not guessed to be NoData. Terrarium quantization is 1/256 metre and does not imply that level of measurement accuracy. Float32 grids preserve the sampled heights before Terrarium quantization.

Both channels have independent availability. DEM level 2 is absent; consumers must select the available parent and its correct UV window. Its target lattice is intentionally coarser than the source, rather than advertising oversampled detail.

The source datum is explicit and is not silently replaced by the celestial catalogue ellipsoid. On this source sphere, planetocentric and planetographic latitudes coincide. There is no conversion to another ellipsoid or rotational reference frame. Engine integration must honor this source frame or perform an explicit conversion.

Credit: NASA's Scientific Visualization Studio, LRO LROC and LOLA instrument teams. [NASA media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) apply; the maps do not imply NASA endorsement.

## Verify public downloads

```powershell
npm run r2:verify -- https://YOUR-PUBLIC-HOST.r2.dev
```

Checks every object against its local original: HTTP status, MIME type, SHA-256 and browser CORS. For the synthetic receipt:

```powershell
npm run r2:verify -- https://YOUR-PUBLIC-HOST.r2.dev .local/r2-smoke/latest.json
```

Open the public host followed by the receipt's prefix and `/index.html`. The bucket root does not list objects. In the lunar preview select the DEM mode and move the pointer across the map to read heights in metres. Hillshading is an illustrative display, not an additional elevation product.

## Resume an interrupted upload

```powershell
npx tsx tools/r2/resume.ts https://YOUR-PUBLIC-HOST.r2.dev
```

The existing receipt identifies the exact revision. Matching public bytes are retained; missing objects are uploaded. A conflicting existing object stops the operation. Uploads retry a failed Wrangler operation up to three times.

Verify the numeric DEM and every shared edge locally:

```powershell
npx tsx tools/r2/verify-dem.ts
```
