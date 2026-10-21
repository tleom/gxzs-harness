import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Manager responses close their HTTP/1.0 connection. Node's bundled fetch can
// crash in Parser.finish when FIN arrives while a response is backpressured
// (nodejs/undici#5360). Use the core HTTP stream at this internal boundary.
export function managerFetch(input, options = {}) {
  const url = new URL(input)
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: options.method, headers: options.headers, signal: options.signal,
    }, incoming => {
      const status = incoming.statusCode
      if (options.redirect === 'error' && status >= 300 && status < 400 && status !== 304) {
        incoming.destroy()
        reject(new TypeError('Manager redirects are not allowed'))
        return
      }
      try {
        const headers = new Headers()
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1])
        const body = [204, 205, 304].includes(status) || options.method === 'HEAD' ? null : Readable.toWeb(incoming, {
          strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
        })
        if (body === null) incoming.resume()
        resolve(new Response(body, { status, statusText: incoming.statusMessage, headers }))
      } catch (error) { incoming.destroy(); reject(error) }
    })
    request.on('error', reject)
    if (options.body instanceof Readable) void pipeline(options.body, request).catch(reject)
    else request.end(options.body)
  })
}
