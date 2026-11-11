import {readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {workspaceChangesDeletionSource} from './prepare-session-deletion.mjs'

/** Keep the installed native recorder intact; generate an instance-scoped IO factory. */
export function workspaceChangesFactory(source) {
  const fsImport='import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";'
  const osImport='import { homedir, tmpdir } from "node:os";'
  const exports='export { Config, apply, inject, name };'
  if(!source.includes(fsImport)||!source.includes(osImport)||!source.includes(exports))
    throw new Error('DSH workspace-changes IO contract changed; inspect upstream before upgrading')
  source=source.replace(fsImport,'').replace('import { readdir } from "node:fs/promises";','').replace(osImport,'').replace(exports,'return { Config, apply, inject, name };')
  const start=source.indexOf('async function captureFile(absolute, directory, maxBytes) {')
  const end=source.indexOf('function sameCapture(a, b) {',start)
  if(start<0||end<0)throw new Error('DSH workspace-changes capture contract changed')
  source=source.slice(0,start)+'const captureFile = io.captureFile;\n'+source.slice(end)
  const imports=[]
  source=source.replace(/^import .*;\r?\n/gm,line=>{imports.push(line);return ''})
  if(/node:fs|node:os/.test(source)||/\b(?:open|writeFile)\(/.test(source))throw new Error('Unadapted native file operation')
  return '// Generated from the installed DSH workspace-changes package (MIT).\n'+imports.join('')+
    '\nexport function createWorkspaceChanges(io) {\nconst {copyFile,mkdir,mkdtemp,readdir,readFile,realpath,rm,homedir,tmpdir}=io;\n'+source+'\n}\n'
}

export async function prepareWorkspaceChanges(profile) {
  const require=createRequire(join(profile,'package.json'))
  const manifest=require.resolve('@deepseek-ai/dsh-workspace-changes/package.json')
  const metadata=JSON.parse(await readFile(manifest,'utf8'))
  if(metadata.version!=='0.2.2-rc.1')throw new Error(`Unverified workspace-changes version: ${metadata.version}`)
  const entry=require.resolve('@deepseek-ai/dsh-workspace-changes')
  const runtimeRequire=createRequire(require.resolve('@gxzs/dsh-workbench-sandbox-runtime/changes'))
  const runtimeEntry=runtimeRequire.resolve('@deepseek-ai/dsh-workspace-changes')
  for(const target of new Set([entry,runtimeEntry])) {
    const version=JSON.parse(await readFile(join(dirname(target),'../package.json'),'utf8')).version
    if(version!==metadata.version)throw new Error('Workspace recorder dependency versions differ')
    await writeFile(join(dirname(target),'gxzs-sandbox.js'),workspaceChangesFactory(workspaceChangesDeletionSource(await readFile(target,'utf8'))))
  }
  return join(dirname(entry),'gxzs-sandbox.js')
}

/** Read snapshot paths inside the authenticated helper, without a second SSH process. */
export async function prepareSnapshotPaths(directory) {
  const version = JSON.parse(await readFile(join(directory, '../package.json'), 'utf8')).version
  if (version !== '0.2.2-rc.1') throw new Error(`Unverified SSH helper version: ${version}`)
  const target = join(directory, 'helper.js')
  const source = await readFile(target, 'utf8')
  const fallback = 'throw new Error(`Unknown SSH helper operation: ${method}`);'
  const route = `if (method === "workbench.snapshot-paths") {
      object.parse(raw);
      return { home: workbenchHomedir(), tempRoot: workbenchTmpdir() };
    }`
  if (source.includes(route)) return
  if (source.split(fallback).length !== 2) throw new Error('DSH SSH helper dispatch contract changed')
  await writeFile(target, 'import { homedir as workbenchHomedir, tmpdir as workbenchTmpdir } from "node:os";\n'
    + source.replace(fallback, route + '\n    ' + fallback))
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  await prepareWorkspaceChanges(process.argv[2] || fileURLToPath(new URL('../profiles/workbench',import.meta.url)))
}
