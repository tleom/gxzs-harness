# Sidebar browser display client

KasmVNC 1.5.0 and its exact noVNC submodule are pinned by commit and SHA-256.
`npm ci && node build.mjs` creates one self-contained ESM artifact. The Host
serves that artifact only through the authenticated `browser-client` route.
No arbitrary asset path or remote module URL is accepted.

The browser uses Kasm's public RFB raw-channel API over the existing signed
HTTP/SSE and owner SSH transport. Ordered RFB deltas replace screenshot frames.
The Xvnc WebSocket listens only on the sandbox loopback interface. A slow or
replaced viewer loses its display connection; the Chromium session survives.

Build adaptations disable extra monitors, printer/smart-card relays and QOI worker creation. PNG/JPEG/WebP
decoding remains upstream code. WebRTC, hardware video and binary clipboard are
disabled by the product wrapper. The build also makes the WebRTC allocation
respect that setting and releases its peer, data channel and upgrade timer on
disconnect. The bundled upstream MPL-2.0 license is kept
next to the artifact; upstream source is available at
https://github.com/kasmtech/noVNC/tree/475ecfa5356579ef222983c7ce4619a7576a3bce.

The client does not advertise JPEG quality support, and the product wrapper
disables WebP and video scaling. Tight therefore carries lossless zlib pixels.
The CDP fallback uses PNG at the viewport's original resolution, including
during motion, with an 8 MiB encoded-frame limit and matching transport bounds.

The single-display adaptation releases decoded ImageBitmap/VideoFrame images
after painting, on dropped frames, and on disconnect, including late decodes.
It also closes the display BroadcastChannel. Desktop pixels use CSS resolution
(at most 1920x1080) and the viewer requests 15 fps to bound animation work.
