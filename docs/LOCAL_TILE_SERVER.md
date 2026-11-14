# Local planetary tile server

The local server exposes planetary tile sets from one loopback address. The current registry contains the global Moon dataset and the Jezero refinement on Mars.

## Start and stop

From the repository root, run:

```powershell
npm run tiles:serve -- --port 8794
```

The defaults read lunar data from `F:/LunarData` and Mars data from `F:/MarsData`. Override either location when needed:

```powershell
npm run tiles:serve -- --moon-root F:/LunarData --mars-root F:/MarsData --port 8794
```

Stop the foreground process with `Ctrl+C`. The service listens only on `127.0.0.1`.

## Endpoints

Open `http://127.0.0.1:8794/` for the service index.

| Tile set     | Preview  | Manifest and descriptors                                            |
| ------------ | -------- | ------------------------------------------------------------------- |
| Moon         | `/moon/` | `/moon/manifest.json`, `/moon/elevation.json`, `/moon/imagery.json` |
| Mars, Jezero | `/mars/` | `/mars/manifest.json`                                               |

The lunar elevation and imagery descriptors contain their tile URL templates. The Jezero manifest lists every tile and provides a URL template rooted at `/mars/`. Both sets retain their own schema, metadata, and tile paths.

## Current coverage

The Moon endpoint serves the verified global lunar pyramid and its imported refinements. The Mars endpoint adds a global MOLA MEGR base at 16 pixels per degree (about 3.7 km) when `sources/mola/meg016/megr90n000eb.img` is available under the Mars root. It declares 2046 point-registered cube tiles over levels 0 to 4 and generates their Terrarium PNGs on demand, with a bounded in-memory cache. MOLA radii use the PDS offset of 3396000 metres and are converted to radial heights over Mars 2000. Longitude sampling wraps; polar sampling clamps to the available rows.

The same inventory retains the Jezero CTX refinement at 20 m per pixel and HiRISE refinement at 1 m per pixel. Without the MOLA raster, the manifest remains regional. The generated global URLs use the `global-mola-16ppd-v1` prefix; existing Jezero files and their immutable URLs are unchanged. The Mars preview colorizes DEM heights. Orthomosaic source files are not yet published as Mars imagery tiles.

Some CTX source heights contain an internal oblique line and isolated spikes near Jezero. These are visible when shading a continuous mosaic of the source tiles without any 3D engine. The service retains those source measurements; it does not silently smooth or correct them.

## Adding another tile set

Register the set in `tools/tile-server.ts`, provide its request handler, and add its route and index entry. Keep the body prefix in resource templates so a client can switch bodies without changing its host.


## Jezero CTX diagnostic

[Rapport de diagnostic et de correction expérimentale](mars/jezero/Rapport_Jezero_CTX_diagnostic_correction.docx) : analyse de la discontinuité CTX, méthode de correction et limites de validation. La correction reste expérimentale et doit être comparée à la source avant intégration.

The Jezero CTX manifest also exposes `ctx-20m-corrected`, an experimental variant generated from the corrected GeoTIFF in `sources/jezero/ctx/`. It is separate from `ctx-20m`, which remains unchanged. Select the source in the Mars preview to compare the corrected and original terrain. The correction is not scientifically validated; see [the diagnostic report](mars/jezero/Rapport_Jezero_CTX_diagnostic_correction.docx).

Open `http://127.0.0.1:8794/mars/?source=ctx-20m-corrected` to preview the corrected CTX source. Restart the service after regeneration so its in-memory tile inventory reloads the updated manifest.
