import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const { createBrowserDownloads, downloadName } = createRequire(import.meta.url)('../src/browser-downloads.cjs')
const base = resolve('.tmp/browser-downloads-tests'), roots = []
async function workspace() { await mkdir(base,{recursive:true}); const root=await mkdtemp(join(base,'case-')); roots.push(root); return root }
afterEach(async()=> { for(const root of roots.splice(0)) { if(!resolve(root).startsWith(base+sep)) throw new Error('Unsafe test path'); await rm(root,{recursive:true,force:true}) } })
function download(name, bytes='content') {
  return {suggestedFilename:()=>name,path:vi.fn(async()=>{const root=await workspace(),path=join(root,'browser-temp');await writeFile(path,bytes);return path}),saveAs:vi.fn(),
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
  expect(files.map(file=>file.path).sort()).toEqual(['Download/报告 (1).pdf','Download/报告.pdf'])
  expect(files.every(file=>file.size===3)).toBe(true)
  expect(first.delete).toHaveBeenCalledOnce();expect(second.delete).toHaveBeenCalledOnce()
  await manager.close()
  expect(first.cancel).not.toHaveBeenCalled()
  expect(await readFile(join(root,files[0].path),'utf8')).toBeTruthy()
})
it('does not leave a destination when the source cannot be copied',async()=> {
  const root=await workspace(),report=vi.fn(),manager=createBrowserDownloads({workspace:root,report}),file=download('file.txt')
  file.path.mockImplementation(workspace)
  await manager.start(file)
  expect(await readdir(join(root,'Download'))).toEqual([])
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
it('places downloads directly in the current conversation and preserves long Unicode extensions',async()=>{
  const root=await workspace(),directory=join(root,'conversations','new-chat'),report=vi.fn()
  await mkdir(directory,{recursive:true})
  const manager=createBrowserDownloads({workspace:root,directory,report})
  await manager.start(download('文件'.repeat(100)+'.docx','word'))
  const file=report.mock.calls.find(([event])=>event.download)[0].download
  expect(file.path).toBe(`conversations/new-chat/Download/${file.name}`)
  expect(file.name.endsWith('.docx')).toBe(true)
  expect(await readFile(join(root,file.path),'utf8')).toBe('word')
  await manager.close()
})
