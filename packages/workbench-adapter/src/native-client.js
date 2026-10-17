import { createHash } from 'node:crypto'
import { bootInjections } from '@deepseek-ai/dsh-client-modules'
import { httpError } from './http.js'

const MODULES = '@deepseek-ai/dsh-client-modules'
const ROOTS = [MODULES, '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-job-controller', '@deepseek-ai/dsh-api-session-controller', '@gxzs/dsh-workbench-adapter']

/** Signed carrier for the original public client artifacts; never a filesystem server. */
export class WorkbenchNativeClient {
  constructor({ modules }) { this.modules = modules }

  graph() {
    const registry = this.modules()
    const graph = registry?.graph()
    if (!graph?.entries) throw httpError(503, '原生客户端尚未就绪')
    const entries = new Map(graph.entries.map(row => [row.id, row]))
    const selected = new Set()
    const visit = id => {
      if (selected.has(id)) return
      const row = entries.get(id)
      if (!row) throw httpError(503, '原生客户端模块尚未就绪')
      selected.add(id)
      for (const dependency of row.inject ?? []) visit(dependency)
      for (const request of row.external ?? []) {
        const dependency = graph.entries.find(entry => request === entry.id || request.startsWith(`${entry.id}/`))
        if (dependency) visit(dependency.id)
      }
    }
    ROOTS.forEach(visit)
    // Single-resource native URLs keep the module graph and its exact revisions,
    // without serving unrelated renderers from the Host's application combo.
    const rows = graph.entries.filter(row => selected.has(row.id))
    const release = graph.release
    if (release?.version !== '0.2.1-alpha.5') throw httpError(503, '原生客户端版本尚未就绪')
    const rev = createHash('sha256').update(JSON.stringify({ release, rows })).digest('hex')
    return { registry, boot: { rev, release, entries: rows, batches: rows.map(row => ({
      phase: row.id === MODULES ? 'bootstrap' : 'application', url: row.url, rev: row.rev, entries: [row.id],
    })) } }
  }

  manifest() {
    const { boot } = this.graph()
    const bootstrap = bootInjections(boot).find(row => row.kind === 'script' && typeof row.text === 'string')?.text
    if (!bootstrap) throw httpError(503, '原生客户端启动入口不可用')
    return { protocol: 1, version: '0.2.1-alpha.5', boot, bootstrap }
  }

  async bundle(url, rev) {
    const { registry, boot } = this.graph()
    if (rev !== boot.rev) throw httpError(409, '原生客户端版本已更新，请重新加载')
    if (typeof url !== 'string' || !boot.entries.some(row => row.url === url))
      throw httpError(404, '原生客户端资源不存在')
    // fetchBundle itself only serves the registry's advertised revisioned URLs.
    const response = await registry.fetchBundle(new Request(new URL(url, 'http://workbench.local/'), { method: 'GET' }))
    if (!response.ok) throw httpError(response.status, '原生客户端资源不可用')
    const source = await response.text()
    if (Buffer.byteLength(source, 'utf8') > 8 * 1024 * 1024) throw httpError(413, '原生客户端资源超过允许大小')
    return { source }
  }
}
