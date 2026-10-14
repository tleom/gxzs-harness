import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { httpError } from './http.js'

let artifact
export async function browserClient() {
  artifact ||= (async () => {
    const base = new URL('../../../services/browser-client/dist/', import.meta.url)
    const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'))
    const source = await readFile(new URL('client.js', base), 'utf8')
    if (Buffer.byteLength(source) > 2 * 1024 * 1024 || manifest.protocol !== 1
      || manifest.revision !== createHash('sha256').update(source).digest('hex')) throw new Error('Invalid browser client')
    return { ...manifest, source }
  })().catch(error => { artifact = undefined; throw error })
  try { return await artifact }
  catch { throw httpError(503, '浏览器显示客户端尚未就绪，请更新工作台镜像') }
}
