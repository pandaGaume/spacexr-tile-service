# CTX oblique line near Jezero

The cyan trace in the Mars preview identifies the visible segment of an internal CTX elevation line. It is a diagnostic location, not a geological classification or a correction of the source heights.

- Source raster: `sources/jezero/ctx/M20_JezeroCrater_CTXDEM_20m.tif`, relative to the Mars data root.
- Source ID: `ctx-20m`.
- Cube face: `1`, LOD: `10`, column: `373`, rows: `295`, `296`, `297`, `298`.
- Approximate segment: 18.667552 N, 77.819080 E to 18.367792 N, 77.855473 E.
- Coordinates are Mars planetocentric latitude and east longitude. They are not Earth coordinates.
- The trace follows maxima of the elevation gradient in the visually identified corridor, every 16 DEM pixels. It covers the inspected segment only. The JSON includes per-point cube coordinates, source tile paths and hashes.

[Open tile 1/10/373/296 with the cyan overlay](http://127.0.0.1:8794/mars/?source=ctx-20m&lod=10&tile=datasets/mars/jezero/ctx-20m/elevation/1/10/373/296.png).

[Download the diagnostic GeoJSON](http://127.0.0.1:8794/mars/diagnostics/ctx-line.geojson).

Toggle **Tracer la ligne CTX (cyan)** to compare with the unmarked DEM. Select the other three rows to follow the line across the inspected tiles. It crosses their interiors, rather than following their borders. A separately shaded continuous mosaic of the source samples reproduces the line without a 3D engine.
