import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inheritedUserPatch, migratePlatformPatch, provisionLegacyBaseline } from '../../../scripts/migrate-platform-patch.mjs'

const failure=vi.hoisted(()=>({backup:''}))
vi.mock('node:fs/promises',async original=>{
  const fs=await original()
  return {...fs,open:async(...args)=>{
    const file=await fs.open(...args)
    if(!failure.backup || !String(args[0]).includes('.cordis.patch.before-bundle-layout-v1.yml.') || !String(args[0]).endsWith('.tmp'))return file
    return {
      writeFile:async content=>{
        if(failure.backup==='write'){
          await file.writeFile(content.slice(0,7))
          throw Object.assign(new Error('Injected partial backup write'),{code:'ENOSPC'})
        }
        return file.writeFile(content)
      },
      sync:async()=>{
        if(failure.backup==='sync')throw Object.assign(new Error('Injected backup flush failure'),{code:'EIO'})
        return file.sync()
      },
      close:()=>file.close(),
    }
  }}
})

const directories=[]
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)),'../temp/three-modules-align-20261014/profile-layer-validation')
afterEach(async()=>{failure.backup='';for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true})})
async function fixture(user,baseline) {
  await mkdir(root,{recursive:true})
  const directory=await mkdtemp(join(root,'profile-'));directories.push(directory)
  await writeFile(join(directory,'package.json'),'{}')
  if(user!==undefined)await writeFile(join(directory,'cordis.patch.yml'),user)
  if(baseline!==undefined) {
    await writeFile(join(directory,'legacy-platform-baseline.patch.yml'),baseline)
    await writeFile(join(directory,'legacy-platform-baseline.json'),JSON.stringify({schemaVersion:1,ownerId:'owner',
      imageId:'sha256:'+'1'.repeat(64),baselineSha256:createHash('sha256').update(baseline).digest('hex'),
      sourcePath:'/opt/workbench/profiles/workbench/cordis.runtime.patch.yml'}))
  }
  return directory
}
it('removes only unchanged baseline occurrences and retains changed, extra and identical additional user overrides with JS tags intact',()=>{
  const baseline='- id: original\n  config:\n    value: !!js process.env.VALUE\n- id: edited\n  config:\n    count: 1\n'
  const user=baseline.replace('count: 1','count: 2')+'- id: original\n  config:\n    value: !!js process.env.VALUE\n- id: extra\n  config:\n    value: keep\n'
  const result=inheritedUserPatch(user,baseline)
  expect(result).toMatchObject({removed:1,retained:3})
  expect(result.text).toContain('!!js process.env.VALUE')
  expect(result.text).toContain('count: 2')
  expect(inheritedUserPatch('- id: original\n  config:\n    value: process.env.VALUE\n',baseline).retained).toBe(1)
})
it('never executes JavaScript tags, resolves ordinary aliases and refuses cyclic alias graphs',()=>{
  const baseline='- id: test\n  config:\n    value: !!js globalThis.__migrationExecuted = true\n'
  expect(inheritedUserPatch(baseline,baseline)).toMatchObject({removed:1,retained:0})
  expect(globalThis.__migrationExecuted).toBeUndefined()
  const alias='- id: one\n  config: &v { depth: 1 }\n- id: two\n  config: *v\n'
  expect(inheritedUserPatch(alias,alias)).toMatchObject({removed:2})
  const inherited='- id: baseline\n  config: &base { value: !!js process.env.VALUE }\n'
  const remainder=inheritedUserPatch(inherited+'- id: added\n  config: *base\n',inherited)
  expect(remainder).toMatchObject({removed:1,retained:1})
  expect(remainder.text).not.toContain('*base')
  expect(remainder.text).toContain('!!js process.env.VALUE')
  expect(()=>inheritedUserPatch('- id: cyclic\n  config: &v { self: *v }\n','[]\n')).toThrow('Cyclic')
})
it('initializes a new owner and then leaves changed native user settings byte-for-byte unchanged across starts',async()=>{
  const directory=await fixture()
  await migratePlatformPatch(directory,{ownerId:'owner'})
  const user='- id: subagent\n  config: { maxDepth: 4 }\n'
  await writeFile(join(directory,'cordis.patch.yml'),user)
  expect(await migratePlatformPatch(directory,{ownerId:'owner'})).toEqual({changed:false,layout:'bundle-base'})
  expect(await readFile(join(directory,'cordis.patch.yml'),'utf8')).toBe(user)
})
it('refuses missing or mismatched legacy baseline identities before changing the user document',async()=>{
  const user='- id: subagent\n  config: { maxDepth: 2 }\n'
  for(const ownerId of ['owner','foreign']) {
    const directory=await fixture(user,ownerId==='foreign'?user:undefined)
    await expect(migratePlatformPatch(directory,{ownerId})).rejects.toThrow()
    expect(await readFile(join(directory,'cordis.patch.yml'),'utf8')).toBe(user)
  }
})
it('refuses static-patch provenance before removing any inherited or user rows',async()=>{
  const user='- id: platform\n  disabled: true\n- id: owner-model\n'
  const directory=await fixture(user,user)
  const proof=join(directory,'legacy-platform-baseline.json')
  const metadata=JSON.parse(await readFile(proof,'utf8'))
  metadata.sourcePath='/opt/workbench/profiles/workbench/cordis.patch.yml'
  await writeFile(proof,JSON.stringify(metadata))
  await expect(migratePlatformPatch(directory,{ownerId:'owner'})).rejects.toThrow('identity')
  expect(await readFile(join(directory,'cordis.patch.yml'),'utf8')).toBe(user)
})
it('backs up the original document and completes an interrupted conversion from the exact saved baseline',async()=>{
  const baseline='- id: platform\n  disabled: true\n'
  const user=baseline+'- id: subagent\n  config: { maxDepth: 3 }\n'
  const directory=await fixture(user,baseline)
  const converted=inheritedUserPatch(user,baseline).text
  await writeFile(join(directory,'.cordis.patch.before-bundle-layout-v1.yml'),user)
  await writeFile(join(directory,'cordis.patch.yml'),converted)
  expect(await migratePlatformPatch(directory,{ownerId:'owner'})).toMatchObject({removed:1,retained:1})
  expect(await readFile(join(directory,'.cordis.patch.before-bundle-layout-v1.yml'),'utf8')).toBe(user)
  expect(await readFile(join(directory,'cordis.patch.yml'),'utf8')).toBe(converted)
})
it.each(['write','sync'])('does not publish an incomplete backup after a %s failure and retries without touching the original settings',async operation=>{
  const baseline='- id: platform\n  disabled: true\n'
  const user=baseline+'- id: owner-model\n'
  const directory=await fixture(user,baseline)
  failure.backup=operation
  await expect(migratePlatformPatch(directory,{ownerId:'owner'})).rejects.toThrow('Injected')
  expect(await readFile(join(directory,'cordis.patch.yml'),'utf8')).toBe(user)
  await expect(readFile(join(directory,'.cordis.patch.before-bundle-layout-v1.yml'))).rejects.toMatchObject({code:'ENOENT'})
  expect((await readdir(directory)).filter(name=>name.endsWith('.tmp'))).toEqual([])
  failure.backup=''
  expect(await migratePlatformPatch(directory,{ownerId:'owner'})).toMatchObject({removed:1,retained:1})
  expect(await readFile(join(directory,'.cordis.patch.before-bundle-layout-v1.yml'),'utf8')).toBe(user)
})

it('provisions a pinned owner baseline before migration without replacing user settings or prior proof',async()=>{
  const baseline='- id: platform\n  disabled: true\n'
  const user=baseline+'- id: llm-pi-ai\n  config: { models: [] }\n'
  const directory=await fixture(user)
  const metadata={ownerId:'owner',imageId:'sha256:'+'2'.repeat(64),baseline,
    baselineSha256:createHash('sha256').update(baseline).digest('hex')}
  await provisionLegacyBaseline(directory,metadata)
  await provisionLegacyBaseline(directory,metadata)
  expect(await readFile(join(directory,'cordis.patch.yml'),'utf8')).toBe(user)
  await expect(provisionLegacyBaseline(directory,{...metadata,ownerId:'foreign'})).rejects.toThrow('identity')
  await expect(provisionLegacyBaseline(directory,{...metadata,baselineSha256:'0'.repeat(64)})).rejects.toThrow('digest')
  expect(await migratePlatformPatch(directory,{ownerId:'owner'})).toMatchObject({removed:1,retained:1})
  expect(await readFile(join(directory,'.cordis.patch.before-bundle-layout-v1.yml'),'utf8')).toBe(user)
  expect(await readFile(join(directory,'cordis.patch.yml'),'utf8')).toContain('llm-pi-ai')
})

it('rejects caller-paired baseline and image arguments; only the host Docker extractor prepares production proofs',async()=>{
  const rootDirectory=await fixture()
  const home=join(rootDirectory,'home')
  const directory=join(home,'profiles/workbench')
  await mkdir(directory,{recursive:true})
  const baseline='- id: platform\n  disabled: true\n'
  const user=baseline+'- id: agent-default-model\n  config: { model: owner-model }\n'
  const input=join(rootDirectory,'captured-old-image.patch.yml')
  await writeFile(input,baseline)
  await writeFile(join(directory,'package.json'),'{}')
  await writeFile(join(directory,'cordis.patch.yml'),user)
  const script=fileURLToPath(new URL('../../../scripts/migrate-platform-patch.mjs',import.meta.url))
  const options={env:{...process.env,DSH_HOME:home,GXZS_HOST_OWNER_ID:'owner'}}
  expect(()=>execFileSync(process.execPath,[script,'--seed-legacy-baseline',input,'sha256:'+'3'.repeat(64),
    createHash('sha256').update(baseline).digest('hex')],{...options,stdio:'pipe'})).toThrow()
  expect(await readFile(join(directory,'cordis.patch.yml'),'utf8')).toBe(user)
  await expect(readFile(join(directory,'legacy-platform-baseline.json'))).rejects.toMatchObject({code:'ENOENT'})
  await provisionLegacyBaseline(directory,{ownerId:'owner',imageId:'sha256:'+'3'.repeat(64),baseline,
    baselineSha256:createHash('sha256').update(baseline).digest('hex')})
  execFileSync(process.execPath,[script],options)
  expect(await readFile(join(directory,'.cordis.patch.before-bundle-layout-v1.yml'),'utf8')).toBe(user)
  expect(await readFile(join(directory,'cordis.patch.yml'),'utf8')).toContain('owner-model')
})
