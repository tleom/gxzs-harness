import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { nativeSettingsControllers } from '../../../scripts/native-settings-controllers.mjs'
import { WorkbenchSubagentSettings } from '../src/settings.js'

const profilePath = fileURLToPath(new URL('../../../profiles/workbench/', import.meta.url))
const require = createRequire(join(profilePath,'package.json'))
const native = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
const [{Context}, {boot,initProfile,readProfilePatches}, {default:Settings}, {default:ConfigEditor},
  {default:Subagents}, {default:Choice}, {SettingsController}, Store, Cordis, Conversation, Chat] = await Promise.all([
  native('cordis'),native('dsh-app-boot'),native('dsh-settings'),native('dsh-config-editor'),native('dsh-subagent'),
  import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-subagent/model-selection-settings')).href),
  native('dsh-api-settings-controller'),native('dsh-client-store'),native('cordis'),
  native('dsh-client-ui-conversation'),
  native('dsh-client-ui-chat'),
])
const contexts=[], directories=[]
afterEach(async () => {
  for(const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for(const directory of directories.splice(0)) await rm(directory,{recursive:true,force:true})
})

async function fixture() {
  const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)),'../temp/three-modules-align-20261014/native-settings-validation')
  await mkdir(root,{recursive:true})
  const home=await mkdtemp(join(root,'profile-')); directories.push(home)
  const dir=join(home,'profiles','test'),bundle=join(dir,'node_modules','test-bundle')
  await initProfile(dir,['test-bundle'])
  await mkdir(bundle,{recursive:true})
  await writeFile(join(home,'package.json'),'{"name":"settings-fixture"}')
  await writeFile(join(bundle,'package.json'),JSON.stringify({name:'test-bundle',version:'1.0.0',dsh:{bundle:{patch:'cordis.patch.yml'}}}))
  await writeFile(join(bundle,'cordis.patch.yml'),JSON.stringify([{insert:[
    {id:'config-editor',name:'cordis:editor'},{id:'settings',name:'cordis:settings'},
    {id:'subagent',name:'cordis:subagents'},
    {id:'subagent-model-selection-settings',name:'cordis:choice'},
    {id:'ui-conversation',name:'cordis:conversation'},
    {id:'ui-chat',name:'cordis:chat'},
  ]}]))
  await writeFile(join(dir,'cordis.yml'),'[]\n')
  const profile={name:'test',startedBundles:['test-bundle'],dir,patchPath:join(dir,'cordis.patch.yml'),
    installAnchor:join(home,'package.json'),cwd:home,home,overlays:[],telemetryDisabledEnv:undefined}
  const ctx=await boot('test',join(dir,'cordis.yml'),readProfilePatches('test',profile),ctx=>{
    ctx.provide('profileContext',profile)
    ctx.provide('appReady',{onReady:listener=>{listener();return ()=>{}}})
    ctx.provide('workingDirectory',{ensure:async()=>'/workspace'})
    Object.assign(ctx.loader.builtins,{editor:ConfigEditor,settings:Settings,subagents:Subagents,choice:Choice,conversation:Conversation,chat:Chat})
  }); contexts.push(ctx)
  await ctx.plugin(SettingsController)
  const gateway=new WorkbenchSubagentSettings({controller:()=>ctx.settingsController,modelCatalog:async()=>({groups:[{id:'p',models:[{id:'current'}]}]})})
  return {ctx,gateway,profile}
}

it('persists native volatile limits and model preferences, rejects stale revisions and resets to the composition default', async () => {
  const {ctx,gateway,profile}=await fixture()
  expect(ctx.subagents.resolveMaxDepth()).toBe(1)
  const original=gateway.describe().namespaces.find(row=>row.ns==='subagent')
  const changed=await gateway.mutate({ownerId:'owner'},{ns:'subagent',expectedRevision:original.revision,
    ops:[{op:'set',path:['maxDepth'],value:3},{op:'set',path:['maxActiveSubagents'],value:2}]})
  expect(ctx.subagents.resolveMaxDepth()).toBe(3)
  expect(changed.value.maxActiveSubagents).toBe(2)
  await expect(gateway.mutate({}, {ns:'subagent',expectedRevision:original.revision,ops:[{op:'set',path:['maxDepth'],value:4}]}))
    .rejects.toMatchObject({code:'settings/conflict'})
  const preference=gateway.describe().namespaces.find(row=>row.ns==='subagent-model-selection-settings')
  await gateway.mutate({}, {ns:preference.ns,expectedRevision:preference.revision,ops:[
    {op:'set',path:['enabled'],value:true},{op:'set',path:['allowedModels'],value:[{provider:'p',model:'current'}]},
  ]})
  expect(ctx.subagentModelSelection.current()).toEqual({enabled:true,allowedModels:[{provider:'p',model:'current'}]})
  const persisted=await readFile(profile.patchPath,'utf8')
  expect(persisted).toContain('maxDepth')
  expect(persisted).toContain('allowedModels')
  await gateway.mutate({}, {ns:'subagent',expectedRevision:changed.revision,ops:[{op:'unset',path:['maxDepth']}]})
  expect(ctx.subagents.resolveMaxDepth()).toBe(1)
})
it('keeps a slow native persistence write visible and rejects new writes after lifecycle draining begins', async () => {
  const host=await fixture()
  let finish, draining=false
  const wait=new Promise(resolve=>{finish=resolve})
  const controller=host.ctx.settingsController
  const mutate=vi.fn(async(...args)=>{await wait;return controller.mutate(...args)})
  const gateway=new WorkbenchSubagentSettings({controller:()=>({describe:()=>controller.describe(),mutate}),
    assertWritable:async()=>{expect(gateway.activeWrites).toBeGreaterThan(0);if(draining)throw Object.assign(new Error('Host draining'),{status:503})}})
  const section=gateway.describe().namespaces.find(row=>row.ns==='subagent')
  const request={ns:section.ns,expectedRevision:section.revision,ops:[{op:'set',path:['maxDepth'],value:3}]}
  const write=gateway.mutate({},request)
  await vi.waitFor(()=>expect(mutate).toHaveBeenCalledOnce())
  draining=true
  expect(gateway.activeWrites).toBe(1)
  await expect(gateway.mutate({},request)).rejects.toMatchObject({status:503})
  expect(mutate).toHaveBeenCalledOnce()
  expect(gateway.activeWrites).toBe(1)
  finish();await write
  expect(gateway.activeWrites).toBe(0)
  expect(host.ctx.subagents.resolveMaxDepth()).toBe(3)
  expect(await readFile(host.profile.patchPath,'utf8')).toContain('maxDepth: 3')
})

it('uses the exact generated native form/controllers over real Host schema, staged edits and revision-fenced saves', async () => {
  const host=await fixture()
  const source=await nativeSettingsControllers(profilePath)
  const {build}=require('esbuild')
  const compiled=await build({stdin:{contents:source,resolveDir:profilePath},format:'cjs',platform:'browser',bundle:true,
    external:['@deepseek-ai/cordis','@deepseek-ai/dsh-client-store'],write:false})
  const module={exports:{}}
  runInNewContext(compiled.outputFiles[0].text,{exports:module.exports,module,require:id=>id==='@deepseek-ai/cordis'?Cordis:Store,
    structuredClone,console,setTimeout,clearTimeout})
  const core=module.exports
  const lineage={byId:{root:{id:'root',displayTitle:'Root'},parent:{id:'parent',displayTitle:'Parent',origin:'subagent',parentId:'root'},
    child:{id:'child',displayTitle:'Child',origin:'subagent',parentId:'parent'}}}
  expect(core.deriveAncestry(lineage,'child')).toEqual([{id:'root',displayTitle:'Root',subagent:false},{id:'parent',displayTitle:'Parent',subagent:true},{id:'child',displayTitle:'Child',subagent:true}])
  expect(core.deriveAncestry(lineage,'missing')).toEqual([])
  lineage.byId.parent.parentId='child'
  expect(core.deriveAncestry(lineage,'child').map(row=>row.id)).toEqual(['parent','child'])
  const ctx=new Context();contexts.push(ctx)
  const mutation=vi.fn(async(ns,ops,expectedRevision)=>{
    try{return{ok:true,value:await host.gateway.mutate({}, {ns,ops,expectedRevision})}}
    catch(error){return{ok:false,error}}
  })
  const remote={settings:{describe:async()=>({ok:true,value:host.gateway.describe()}),mutate:mutation},
    session:{modelCatalog:async()=>({ok:true,value:{groups:[{id:'p',name:'Provider',models:[{id:'current',name:'Current'}]}],failures:[]}})}}
  ctx.provide('remote',remote);ctx.provide('remote.settings',remote.settings)
  let mirror,forms
  await ctx.plugin({inject:['remote','remote.settings'],apply(scope){
    const schema=new core.SettingsSchemaService(scope)
    mirror=new core.SettingsDescribeMirror(scope,'host')
    forms=new core.ConfigForms(scope,{mirror,schema,persistence:'host'})
  }})
  await mirror.ensure()
  const limits=new core.SubagentLimitsCardController(forms.get('subagent'))
  const models=new core.SubagentModelSelectionCardController(forms.get('subagent-model-selection-settings'),ctx)
  const face=core.subagentCardFace(limits.inject(),models.inject())
  const limitState=()=>face.hooks.subagentLimitsCard.getSnapshot()
  const policy=new core.ComposerSubmissionPolicy(forms.get('ui-conversation'))
  const transcript=new core.TranscriptViewPolicy(forms.get('ui-chat'),'standard')
  expect(transcript.mode.getSnapshot()).toBe('standard')
  expect(transcript.collapseTiming.getSnapshot()).toBe('completion')
  expect(await readFile(host.profile.patchPath,'utf8')).not.toContain('transcriptView')
  transcript.setMode('detailed')
  transcript.setCollapseTiming('next-input')
  await vi.waitFor(()=>expect(host.gateway.describe().namespaces.find(row=>row.ns==='ui-chat').value)
    .toMatchObject({transcriptView:'detailed',collapseTiming:'next-input'}))
  expect(await readFile(host.profile.patchPath,'utf8')).toContain('collapseTiming')
  const restored=new core.TranscriptViewPolicy(forms.get('ui-chat'),'standard')
  expect(restored.mode.getSnapshot()).toBe('detailed')
  expect(restored.collapseTiming.getSnapshot()).toBe('next-input')
  const chatSection=host.gateway.describe().namespaces.find(row=>row.ns==='ui-chat')
  await expect(host.gateway.mutate({}, {ns:'ui-chat',expectedRevision:chatSection.revision,ops:[{op:'set',path:['collapseTiming'],value:'invalid'}]})).rejects.toBeDefined()
  await expect(host.gateway.mutate({}, {ns:'ui-chat',expectedRevision:chatSection.revision,ops:[{op:'set',path:['linkOpening'],value:'new-tab'}]})).rejects.toMatchObject({status:400})
  restored.dispose();transcript.dispose()
  expect(policy.busyEnter.getSnapshot()).toBe('queue')
  for (const preferred of ['queue','steer']) {
    policy.setBusyEnter(preferred)
    for (const running of [false,true]) for (const supportsSteer of [false,true]) {
      expect(core.resolveSubmitMode(policy.busyEnter.getSnapshot(),running,'enter',supportsSteer))
        .toBe(running && supportsSteer ? preferred : 'queue')
      expect(core.resolveSubmitMode(policy.busyEnter.getSnapshot(),running,'accelerated',supportsSteer))
        .toBe(running && supportsSteer ? (preferred==='queue'?'steer':'queue') : 'queue')
    }
  }
  await vi.waitFor(()=>expect(host.gateway.describe().namespaces.find(row=>row.ns==='ui-conversation').value.busyEnter).toBe('steer'))
  expect(await readFile(host.profile.patchPath,'utf8')).toContain('busyEnter')
  mutation.mockClear()
  expect(limitState()).toMatchObject({available:true,writable:true,maxDepth:{text:'1',overridden:false}})
  face.editLimit('maxDepth','2')
  expect(mutation).not.toHaveBeenCalled()
  expect(limitState()).toMatchObject({dirty:true,invalid:false})
  face.save()
  await vi.waitFor(()=>expect(host.ctx.subagents.resolveMaxDepth()).toBe(2))
  await vi.waitFor(()=>expect(limitState()).toMatchObject({saving:false,dirty:false,maxDepth:{text:'2'}}))
  expect(mutation.mock.calls[0][2]).toEqual(expect.any(Number))
  face.resetLimit('maxDepth');face.save()
  await vi.waitFor(()=>expect(host.ctx.subagents.resolveMaxDepth()).toBe(1))
  await vi.waitFor(()=>expect(limitState()).toMatchObject({saving:false,dirty:false,maxDepth:{text:'1'}}))
  face.toggleEnabled()
  await vi.waitFor(()=>expect(face.hooks.subagentModelSelectionCard.getSnapshot().catalogStatus).toBe('ready'))
  expect(face.hooks.subagentModelSelectionCard.getSnapshot().invalid).toBe(true)
  const choice=face.hooks.subagentModelSelectionCard.getSnapshot().candidates[0]
  face.toggleModel(choice.key);face.save()
  await vi.waitFor(()=>expect(host.ctx.subagentModelSelection.current().enabled).toBe(true))
  await vi.waitFor(()=>expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({saving:false,dirty:false,enabled:true}))
  expect(host.ctx.subagentModelSelection.current().allowedModels).toEqual([{provider:'p',model:'current'}])
  limits.dispose();models.dispose();policy.dispose()
  expect(core.nativeSettingsProvenance.version).toBe('0.2.1-rc.2')
})
