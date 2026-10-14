import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inheritedUserPatch, migratePlatformPatch } from '../../../scripts/migrate-platform-patch.mjs'

const directories=[]
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)),'../temp/three-modules-align-20261014/profile-layer-validation')
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true})})
async function fixture(user,baseline) {
  await mkdir(root,{recursive:true})
  const directory=await mkdtemp(join(root,'profile-'));directories.push(directory)
  await writeFile(join(directory,'package.json'),'{}')
  if(user!==undefined)await writeFile(join(directory,'cordis.patch.yml'),user)
  if(baseline!==undefined) {
    await writeFile(join(directory,'legacy-platform-baseline.patch.yml'),baseline)
    await writeFile(join(directory,'legacy-platform-baseline.json'),JSON.stringify({schemaVersion:1,ownerId:'owner',
      imageId:'sha256:'+'1'.repeat(64),baselineSha256:createHash('sha256').update(baseline).digest('hex')}))
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
