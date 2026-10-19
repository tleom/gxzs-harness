import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// The exact client submodule shipped by KasmVNC v1.5.0. Never build against master.
const commit = '475ecfa5356579ef222983c7ce4619a7576a3bce'
const sha256 = '73c5ee62c7469da6080e0ea171a38c652f8e8b8647396d340b31465baa837914'
const base = dirname(fileURLToPath(import.meta.url))
const output = resolve(process.argv[2] || join(base, 'dist'))
const temporary = await mkdtemp(join(tmpdir(), 'workbench-vnc-client-'))
try {
  const archive = process.env.KASM_CLIENT_ARCHIVE ? await readFile(process.env.KASM_CLIENT_ARCHIVE)
    : Buffer.from(await (await fetch(`https://api.github.com/repos/kasmtech/noVNC/tarball/${commit}`, {
      headers: { 'user-agent': 'gxzs-browser-client-build' }, signal: AbortSignal.timeout(120000),
    })).arrayBuffer())
  if (createHash('sha256').update(archive).digest('hex') !== sha256) throw new Error('Kasm client archive checksum mismatch')
  await writeFile(join(temporary, 'source.tar.gz'), archive)
  await promisify(execFile)('tar', ['-xzf', join(temporary, 'source.tar.gz'), '-C', temporary])
  const source = join(temporary, (await readdir(temporary)).find(name => name.startsWith('kasmtech-noVNC-')))
  await mkdir(output, { recursive: true })
  await build({ stdin: { contents: `export { default as RFB } from ${JSON.stringify(join(source, 'core/rfb.js'))}`, resolveDir: base },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    outfile: join(output, 'client.js'), nodePaths: [join(base, 'node_modules')],
    plugins: [{ name: 'single-browser-client', setup(plugin) {
      plugin.onResolve({ filter: /app\/ui\.js$/ }, () => ({ path: 'ui', namespace: 'workbench' }))
      plugin.onResolve({ filter: /output\/(?:printer|smartcard)\.js$/ }, () => ({ path: 'device-disabled', namespace: 'workbench' }))
      plugin.onResolve({ filter: /\?worker$/ }, () => ({ path: 'qoi-disabled', namespace: 'workbench' }))
      plugin.onLoad({ filter: /.*/, namespace: 'workbench' }, args => ({ contents: args.path === 'ui'
        ? 'export default { registeredWindows: new Map(), displayWindows: new Map() }'
        : args.path === 'device-disabled' ? 'export default function() {}'
        : 'export default class { constructor() { throw new Error("QOI workers are disabled") } }' }))
      plugin.onResolve({ filter: /\?url$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'asset' }))
      plugin.onLoad({ filter: /.*/, namespace: 'asset' }, async args => ({ contents:
        `export default "data:application/octet-stream;base64,${(await readFile(args.path)).toString('base64')}"` }))
      plugin.onLoad({ filter: /core[\\/]rfb\.js$/ }, async args => {
        const text = await readFile(args.path, 'utf8')
        const declaration = 'this._supportsMultiMonitor = (typeof BroadcastChannel !== "undefined" && typeof SharedWorker !== "undefined");'
        if (text.split(declaration).length !== 2) throw new Error('Kasm single-display contract changed')
        // The pinned handler returns undefined on success. Treat only false as
        // incomplete input, so a coalesced ServerFence is processed immediately.
        // Otherwise the server waits for its fence reply and sends no more pixels.
        const encoders = 'return this._handleServerVideoEncoders();'
        if (text.split(encoders).length !== 2) throw new Error('Kasm video-encoder dispatch contract changed')
        const frameHook = 'this._display.onflush = this._onFlush.bind(this);'
        if (text.split(frameHook).length !== 2) throw new Error('Kasm frame observer contract changed')
        const udpInit = "if (typeof RTCPeerConnection !== 'undefined' && this._isPrimaryDisplay) {"
        const udpUpgrade = 'setTimeout(function() { this._sendUdpUpgrade() }.bind(this), 3000);'
        const disconnect = 'Log.Debug(">> RFB.disconnect");'
        for (const contract of [udpInit, udpUpgrade, disconnect]) {
          if (text.split(contract).length !== 2) throw new Error('Kasm WebRTC lifecycle contract changed')
        }
        return { contents: text.replace(declaration, 'this._supportsMultiMonitor = false;')
          .replace(udpInit, "if (this._useUdp && typeof RTCPeerConnection !== 'undefined' && this._isPrimaryDisplay) {")
          .replace(udpUpgrade, 'this._udpUpgradeTimeout = ' + udpUpgrade)
          .replace(disconnect, disconnect + `
        clearTimeout(this._udpUpgradeTimeout);
        if (this._udpChannel) {
            this._udpChannel.onerror = null;
            this._udpChannel.onmessage = null;
            this._udpChannel.close();
            this._udpChannel = null;
        }
        if (this._udpPeer) {
            this._udpPeer.onicecandidate = null;
            this._udpPeer.ondatachannel = null;
            this._udpPeer.close();
            this._udpPeer = null;
        }
        this._udpBuffer?.clear();`)
          .replace(encoders, 'return this._handleServerVideoEncoders() !== false;')
          .replace(frameHook, frameHook + '\n        this._display.onframe = () => this.dispatchEvent(new CustomEvent("frame"));')
          .replace('Log.Warn("This browser does not support multi-monitor setups.");', 'Log.Debug("Single browser display");'), resolveDir: dirname(args.path) }
      })
      plugin.onLoad({ filter: /core[\\/]display\.js$/ }, async args => {
        const text = await readFile(args.path, 'utf8')
        const painted = 'this._flipCnt += 1;'
        if (text.split(painted).length !== 2) throw new Error('Kasm rendered-frame contract changed')
        return { contents: text.replace(painted,
          painted + '\n            if (primaryScreenRects > 0) this.onframe?.();'), resolveDir: dirname(args.path) }
      })
      plugin.onLoad({ filter: /core[\\/]renderers[\\/]Canvas2DRenderer\.js$/ }, async args => {
        const text = await readFile(args.path, 'utf8')
        const alpha = 'alpha: false'
        if (text.split(alpha).length !== 2) throw new Error('Kasm visible-canvas alpha contract changed')
        // Let unpainted/reset pixels reveal the white viewer background. Actual
        // webpage pixels and the upstream save/restore logic stay unchanged.
        return { contents: text.replace(alpha, 'alpha: true'), resolveDir: dirname(args.path) }
      })
    } }],
    banner: { js: `/* KasmVNC/noVNC ${commit}; MPL-2.0. Sources and local build adaptations: https://github.com/tleom/gxzs-harness/tree/main/services/browser-client */` },
  })
  const code = await readFile(join(output, 'client.js'))
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ protocol: 1, commit, revision: createHash('sha256').update(code).digest('hex') }))
  await writeFile(join(output, 'LICENSE.txt'), await readFile(join(source, 'LICENSE.txt')))
} finally { await rm(temporary, { recursive: true, force: true }) }
