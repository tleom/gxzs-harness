import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const { createBrowserDownloads, downloadName } = createRequire(import.meta.url)('../src/browser-downloads.cjs')
const base = resolve('.tmp/browser-downloads-tests'), roots = []
async function workspace() { await mkdir(base,{recursive:true}); const root=await mkdtemp(join(base,'case-')); roots.push(root); return root }
afterEach(async()=> { for(const root of roots.splice(0)) { if(!resolve(root).startsWith(base+sep)) throw new Error('Unsafe test path'); await rm(root,{recursive:true,force:true}) } })
function download(name, bytes='content') {
  return {suggestedFilename:()=>name,path:vi.fn(async()=>'/browser/temp'),saveAs:vi.fn(path=>writeFile(path,bytes)),
    delete:vi.fn(async()=>{}),cancel:vi.fn(async()=>{})}
}
it('saves completed downloads without overwriting names and removes the browser temporary copy',async()=> {
  const root=await workspace(),report=vi.fn(),manager=createBrowserDownloads({workspace:root,report})
  const first=download('报告.pdf','one'),second=download('报告.pdf','two')
  await Promise.all([manager.start(first),manager.start(second)])
  const files=report.mock.calls.flatMap(([event])=>event.download?[event.download]:[])
  expect(files).toHaveLength(2)
  expect(new Set(files.map(file=>file.path)).size).toBe(2)
  expect(await Promise.all(files.map(file=>readFile(join(root,file.path),'utf8')))).toEqual(expect.arrayContaining(['one','two']))
  expect(files.every(file=>file.path.startsWith('downloads/')&&file.size===3)).toBe(true)
  expect(first.delete).toHaveBeenCalledOnce();expect(second.delete).toHaveBeenCalledOnce()
  await manager.close()
  expect(first.cancel).not.toHaveBeenCalled()
  expect(await readFile(join(root,files[0].path),'utf8')).toBeTruthy()
})
it('removes only its incomplete destination when saving fails',async()=> {
  const root=await workspace(),report=vi.fn(),manager=createBrowserDownloads({workspace:root,report}),file=download('file.txt')
  file.saveAs.mockImplementation(async path=>{await writeFile(path,'partial');throw new Error('disk full')})
  await manager.start(file)
  expect(await readdir(join(root,'downloads'))).toEqual([])
  expect(report).toHaveBeenLastCalledWith({notice:'下载失败：file.txt'})
  expect(file.delete).toHaveBeenCalledOnce()
  await manager.close()
})
it('cancels active downloads on shutdown without creating files or reporting a failure after close',async()=> {
  const root=await workspace(),report=vi.fn(),manager=createBrowserDownloads({workspace:root,report}),file=download('slow.zip')
  let reject
  file.path.mockImplementation(()=>new Promise((_resolve,fail)=>{reject=fail}))
  file.cancel.mockImplementation(async()=>reject(new Error('cancelled')))
  const task=manager.start(file)
  await manager.close();await task
  expect(file.cancel).toHaveBeenCalledOnce();expect(file.delete).toHaveBeenCalledOnce()
  expect(file.saveAs).not.toHaveBeenCalled();expect(await readdir(root)).toEqual([])
  expect(report).toHaveBeenCalledTimes(1)
})
it.each(['../../x.txt','..\\..\\x.txt','/etc/passwd','NUL','a:b?.txt','文件'.repeat(200)+'.txt'])('keeps suggested filename %s inside one bounded file component',name=>{
  const value=downloadName(name)
  expect(value).not.toMatch(/[\\/:?*<>|]/);expect(value).not.toBe('..');expect(Buffer.byteLength(value)).toBeLessThanOrEqual(200)
})
