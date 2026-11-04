# SpaceXR Tile Service

Independent Cloudflare geospatial publishing instances share one modular source tree. The platform uses the SpaceXR geographic 2x1 tile matrix, explicit reference frames and datums, immutable R2 revisions and asynchronous external processing.

See [architecture](docs/ARCHITECTURE.md) and [dependency audit](docs/DEPENDENCY-AUDIT.md). The authoritative libraries are sibling checkouts during development. Build their packages before installing this workspace. Quantia provides units; the public Terrarium encoder belongs to @spacexr/dem.

This repository contains no cloud credentials or pre-created Cloudflare resource identifiers. Scientific coverage is published only after product verification and successful ingestion. Synthetic fixtures are identified as synthetic.
