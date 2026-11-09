import { createRequire } from 'node:module'
import { readFile, mkdir, open, link, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(new URL('../profiles/workbench/package.json',import.meta.url))
const {parseDocument,isSeq,isMap,isScalar,isAlias,visit} = require('yaml')
const {withFileLock,writeFileAtomic} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
const digest = value => createHash('sha256').update(value).digest('hex')
const documentOf = text => {
  // Preserve JavaScript expression tags as data. Never evaluate profile content.
  const document = parseDocument(text,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:value=>value}]})
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Profile patch must be a valid YAML sequence')
  return document
}

/** Remove only unchanged rows from the exact old platform baseline. */
export function inheritedUserPatch(user, baseline) {
  const document=documentOf(user), original=documentOf(baseline)
  const semantic = (document,node,active=new Set()) => {
    if(node==null)return null
    if(active.has(node))throw new Error('Cyclic profile aliases cannot be migrated')
    active.add(node)
    let result
    if(isAlias(node))result=semantic(document,node.resolve(document),active)
    else if(isScalar(node))result={value:node.value}
    else if(isSeq(node))result=node.items.map(item=>semantic(document,item,active))
    else if(isMap(node))result=node.items.map(pair=>[semantic(document,pair.key,active),semantic(document,pair.value,active)])
      .sort((a,b)=>JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])))
    else throw new Error('Unsupported profile patch node')
    if(node.tag)result={tag:node.tag,value:result}
    active.delete(node)
    return result
  }
  const rows=original.contents.items.map(item=>semantic(original,item))
  const consumed=new Set(),remove=[]
  for(let index=0; index<document.contents.items.length; index++) {
    const item=document.contents.items[index], value=semantic(document,item)
    const inherited=rows.findIndex((row, rowIndex)=>!consumed.has(rowIndex) && isDeepStrictEqual(row,value))
    if(inherited>=0) {consumed.add(inherited);remove.push(index)}
  }
  // A surviving user alias may reference a definition in an inherited row.
  // Resolve it with YAML's own AST cloning before removing that definition.
  visit(document,{Alias(_key,node) {
    const target=node.resolve(document)
    if(!target)throw new Error('Unresolved profile alias cannot be migrated')
    const value=target.clone()
    value.anchor=undefined
    return value
  }})
  for(const index of remove.reverse()) document.delete(index)
  return {text:String(document),removed:remove.length,retained:document.contents.items.length}
}

/** Upgrade only retired DSH configuration fields; preserve unrelated AST nodes and JS tags. */
export function dsh022UserPatch(user) {
  const document = documentOf(user)
  let changes = 0
  const set = (row, key, value) => { row.set(key, value); changes++ }
  const value = (row, key) => row.get(key)
  const plugin = (row, id, name) => value(row, 'id') === id || value(row, 'name') === name
  visit(document, { Seq(_key, rows) {
    const maps = rows.items.filter(isMap)
    const find = id => rows.items.find(row => isMap(row) && value(row, 'id') === id)
    const executor = kind => {
      const id = `tool-executor-${kind}`
      let row = find(id)
      if (!row) { row = document.createNode({ id, name: `@deepseek-ai/dsh-${id}` }); rows.add(row); changes++ }
      return row
    }
    for (const row of maps) {
      const config = row.get('config', true)
      if (plugin(row, 'tools', '@deepseek-ai/dsh-tools') && isMap(config)) {
        const mode = config.get('mode', true)
        if (mode !== undefined) {
          if (!isScalar(mode) || mode.tag || !['native', 'ptc'].includes(mode.value))
            throw new Error('DSH 0.2.2 migration requires a literal tools.mode (native or ptc)')
          for (const kind of ['native', 'ptc']) {
            const target = executor(kind), disabled = kind !== mode.value
            if (target.has('disabled') && value(target, 'disabled') !== disabled)
              throw new Error('Legacy tools.mode conflicts with an explicit tool executor; resolve the profile before startup')
            set(target, 'disabled', disabled)
          }
          config.delete('mode'); changes++
        }
        const parallel = config.get('maxParallelSubCalls', true)
        if (parallel !== undefined) {
          const existingPtc = find('tool-executor-ptc')
          const target = executor('ptc')
          if (!existingPtc && mode === undefined) set(target, 'disabled', true)
          if (!target.has('config')) target.set('config', document.createNode({}))
          const options = target.get('config', true)
          if (!isMap(options)) throw new Error('PTC executor configuration must be a mapping')
          if (!options.has('maxParallelSubCalls')) set(options, 'maxParallelSubCalls', parallel.clone())
          config.delete('maxParallelSubCalls'); changes++
        }
      }
      if ((plugin(row, 'tool-subagent', '@deepseek-ai/dsh-tool-subagent') || value(row, 'id') === 'tool-subagent-fork') && isMap(config) && config.has('modelSelectionSettings')) {
        const legacy = config.get('modelSelectionSettings', true)
        if (!config.has('modelSelection')) set(config, 'modelSelection', legacy.clone())
        if (!config.has('modelDiscovery') && isScalar(legacy) && legacy.value === true
          && !maps.some(other => isMap(other.get('config', true)) && other.get('config', true).get('modelDiscovery') === true))
          set(config, 'modelDiscovery', true)
        config.delete('modelSelectionSettings'); changes++
      }
      if (plugin(row, 'tool-subagent-list-agents', '@deepseek-ai/dsh-tool-subagent-control/list-agents')) {
        // The upstream control entry owns all three control tools. An id-only
        // patch for the retired row has no target and must also be removed.
        const control = maps.find(other => other !== row && plugin(other, 'tool-subagent-control', '@deepseek-ai/dsh-tool-subagent-control'))
        if (control || !row.has('name')) { rows.items.splice(rows.items.indexOf(row), 1); changes++ }
        else {
          set(row, 'id', 'tool-subagent-control')
          set(row, 'name', '@deepseek-ai/dsh-tool-subagent-control')
        }
      }
    }
  } })
  return { text: changes ? String(document) : user, changes }
}

const optional = async path => {
  try{return await readFile(path,'utf8')}
  catch(error){if(error.code==='ENOENT')return undefined;throw error}
}

async function publishBackupOnce(filename, content) {
  const temporary=`${filename}.${randomBytes(8).toString('hex')}.tmp`
  let file, created=false
  try {
    file=await open(temporary,'wx',0o600)
    created=true
    await file.writeFile(content,'utf8')
    await file.sync()
    await file.close()
    file=undefined
    // A hard link publishes the complete inode atomically and refuses EEXIST.
    // An interrupted write can never occupy the final backup path.
    await link(temporary,filename)
  } finally {
    await file?.close()
    if(created) await rm(temporary,{force:true})
  }
  if(process.platform!=='win32') {
    const directory=await open(dirname(filename),'r')
    try{await directory.sync()}finally{await directory.close()}
  }
}

/** Internal writer for bytes extracted by prepare-profile-upgrade.py from the old image. */
export async function provisionLegacyBaseline(profileDirectory,{ownerId,imageId,baseline,baselineSha256}={}) {
  if(!ownerId || !/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')
    || !/^[a-f0-9]{64}$/.test(baselineSha256 ?? '') || typeof baseline!=='string'
    || digest(baseline)!==baselineSha256) throw new Error('Legacy image, owner and baseline digest inputs are inconsistent')
  documentOf(baseline)
  const directory=resolve(profileDirectory)
  await mkdir(directory,{recursive:true})
  return withFileLock(join(directory,'package.json'),async()=>{
    const path=join(directory,'legacy-platform-baseline.patch.yml')
    const proof=join(directory,'legacy-platform-baseline.json')
    const metadata={schemaVersion:1,ownerId,imageId,baselineSha256,
      sourcePath:'/opt/workbench/profiles/workbench/cordis.runtime.patch.yml'}
    const saved=await optional(path), previous=await optional(proof)
    if(saved!==undefined && saved!==baseline) throw new Error('An existing legacy baseline must not be replaced')
    if(previous!==undefined && !isDeepStrictEqual(JSON.parse(previous),metadata))
      throw new Error('An existing legacy baseline identity must not be replaced')
    if(saved===undefined) await writeFileAtomic(path,baseline,{mode:0o600})
    if(previous===undefined) await writeFileAtomic(proof,JSON.stringify(metadata)+'\n',{mode:0o600})
    return metadata
  })
}

/** One-time bootstrap conversion; future starts leave the native user document untouched. */
export async function migratePlatformPatch(profileDirectory,{ownerId}={}) {
  const directory=resolve(profileDirectory)
  await mkdir(directory,{recursive:true})
  return withFileLock(join(directory,'package.json'),async()=>{
    const patch=join(directory,'cordis.patch.yml')
    const marker=join(directory,'.gxzs-bundle-layout-v1.json')
    const previous=await optional(marker)
    if(previous) {
      const receipt=JSON.parse(previous)
      if(receipt.schemaVersion!==1 || receipt.layout!=='bundle-base') throw new Error('Unknown profile settings layout')
      return {changed:false,layout:'bundle-base'}
    }
    const user=await optional(patch)
    let result={text:'[]\n',removed:0,retained:0}
    let baselineSha256
    if(user && documentOf(user).contents.items.length) {
      const baseline=await optional(join(directory,'legacy-platform-baseline.patch.yml'))
      const proof=await optional(join(directory,'legacy-platform-baseline.json'))
      if(!baseline || !proof) throw new Error('An exact legacy platform baseline is required to preserve profile settings')
      const metadata=JSON.parse(proof)
      if(metadata.schemaVersion!==1 || metadata.sourcePath!=='/opt/workbench/profiles/workbench/cordis.runtime.patch.yml'
        || !/^sha256:[a-f0-9]{64}$/.test(metadata.imageId ?? '')
        || !/^[a-f0-9]{64}$/.test(metadata.baselineSha256 ?? '') || digest(baseline)!==metadata.baselineSha256
        || !ownerId || metadata.ownerId!==ownerId) throw new Error('Legacy platform baseline identity does not match this owner')
      baselineSha256=metadata.baselineSha256
      const backup=join(directory,'.cordis.patch.before-bundle-layout-v1.yml')
      const saved=await optional(backup)
      result=inheritedUserPatch(saved ?? user,baseline)
      if(saved!==undefined && saved!==user && user!==result.text) throw new Error('Profile changed after an interrupted layout migration')
      if(saved===undefined) await publishBackupOnce(backup,user)
    } else if(user) result.text=user
    const receipt={schemaVersion:1,layout:'bundle-base',baselineSha256,
      removed:result.removed,retained:result.retained,userSha256:digest(result.text)}
    await writeFileAtomic(patch,result.text,{mode:0o600})
    await writeFileAtomic(marker,JSON.stringify(receipt)+'\n',{mode:0o600})
    return {changed:true,...receipt}
  })
}

/** Independent versioned migration: existing bundle-layout markers must not bypass DSH upgrades. */
export async function migrateDsh022Profile(profileDirectory) {
  const directory = resolve(profileDirectory)
  return withFileLock(join(directory, 'package.json'), async () => {
    const patch = join(directory, 'cordis.patch.yml')
    const marker = join(directory, '.gxzs-dsh-0.2.2-rc.1.json')
    const previous = await optional(marker)
    if (previous) {
      if (JSON.parse(previous).version !== '0.2.2-rc.1') throw new Error('Unknown DSH migration receipt')
      return { changed: false }
    }
    const user = await optional(patch) ?? '[]\n'
    const backup = join(directory, '.cordis.patch.before-dsh-0.2.2-rc.1.yml')
    const saved = await optional(backup)
    const result = dsh022UserPatch(saved ?? user)
    if (saved !== undefined && saved !== user && user !== result.text)
      throw new Error('Profile changed after an interrupted DSH migration')
    if (result.changes && saved === undefined) await publishBackupOnce(backup, user)
    if (result.text !== user) await writeFileAtomic(patch, result.text, { mode: 0o600 })
    await writeFileAtomic(marker, JSON.stringify({ version: '0.2.2-rc.1', changes: result.changes, userSha256: digest(result.text) }) + '\n', { mode: 0o600 })
    return { changed: result.changes > 0, changes: result.changes }
  })
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.env.DSH_HOME) throw new Error('DSH_HOME is required')
  const directory=join(process.env.DSH_HOME,'profiles/workbench')
  if(process.argv.length>2) throw new Error('Unknown profile migration operation; prepare baselines with prepare-profile-upgrade.py')
  await migratePlatformPatch(directory,{ownerId:process.env.GXZS_HOST_OWNER_ID})
  await migrateDsh022Profile(directory)
}
