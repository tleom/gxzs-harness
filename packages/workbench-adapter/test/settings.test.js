import { expect, it, vi } from 'vitest'
import { WorkbenchSubagentSettings } from '../src/settings.js'

const owner = { ownerId: 'owner' }
function fixture() {
  const controller = {
    describe: vi.fn(() => ({writable:true,hasDocument:true,namespaces:[
      {ns:'subagent',value:{maxDepth:1,maxActiveSubagents:8},revision:2},
      {ns:'subagent-model-selection-settings',value:{enabled:false,allowedModels:[{provider:'p',model:'retired'}]},revision:4},
      {ns:'ui-conversation',value:{busyEnter:'queue'},revision:1},
      {ns:'llm-pi-ai',value:{providers:{secret:'private'}}},
    ]})),
    mutate: vi.fn(async (_ns, _ops, revision) => ({revision:revision+1})),
  }
  const modelCatalog = vi.fn(async () => ({groups:[{id:'p',models:[{id:'current'}]}]}))
  return {controller,modelCatalog,gateway:new WorkbenchSubagentSettings({controller:()=>controller,modelCatalog})}
}
it('only serves the native subagent and composer fields and delegates the exact revision-fenced path mutation', async () => {
  const {gateway,controller}=fixture()
  expect(gateway.describe()).toEqual({writable:true,hasDocument:false,namespaces:[
    {ns:'subagent',value:{maxDepth:1,maxActiveSubagents:8},revision:2},
    {ns:'subagent-model-selection-settings',value:{enabled:false,allowedModels:[{provider:'p',model:'retired'}]},revision:4},
    {ns:'ui-conversation',value:{busyEnter:'queue'},revision:1},
  ]})
  const request={ns:'subagent',expectedRevision:2,ops:[{op:'set',path:['maxDepth'],value:3},{op:'unset',path:['maxActiveSubagents']}]}
  expect(await gateway.mutate(owner,request)).toEqual({revision:3})
  expect(controller.mutate).toHaveBeenCalledWith(request.ns,request.ops,2)
})
it('rejects other namespaces, fields, missing revision and nested paths before any Host settings write', async () => {
  const {gateway,controller}=fixture()
  for (const request of [
    {ns:'llm-pi-ai',expectedRevision:2,ops:[{op:'set',path:['providers'],value:{}}]},
    {ns:'__proto__',expectedRevision:2,ops:[{op:'set',path:['x'],value:true}]},
    {ns:'subagent',ops:[{op:'set',path:['maxDepth'],value:2}]},
    {ns:'subagent',expectedRevision:2,ops:[{op:'set',path:['maxDepth','x'],value:2}]},
    {ns:'subagent',expectedRevision:2,ops:[{op:'set',path:['secret'],value:'x'}]},
    {ns:'ui-conversation',expectedRevision:1,ops:[{op:'set',path:['providers'],value:{}}]},
  ]) await expect(gateway.mutate(owner,request)).rejects.toMatchObject({status:400})
  expect(controller.mutate).not.toHaveBeenCalled()
})
it('keeps stored unavailable routes removable while forbidding new routes outside the published owner catalog', async () => {
  const {gateway,controller,modelCatalog}=fixture()
  const request={ns:'subagent-model-selection-settings',expectedRevision:4,ops:[
    {op:'set',path:['enabled'],value:true},{op:'set',path:['allowedModels'],value:[{provider:'p',model:'current'},{provider:'p',model:'retired'}]},
  ]}
  await gateway.mutate(owner,request)
  expect(modelCatalog).toHaveBeenCalledWith(owner)
  const denied={...request,ops:[{op:'set',path:['allowedModels'],value:[{provider:'foreign',model:'private'}]}]}
  await expect(gateway.mutate(owner,denied)).rejects.toMatchObject({status:400})
  expect(controller.mutate).toHaveBeenCalledOnce()
})
it('counts a write before the locked lifecycle check and retains it until native persistence settles', async () => {
  const {controller}=fixture()
  let admit, finish
  const assertWritable=vi.fn(()=>new Promise(resolve=>{admit=resolve}))
  controller.mutate.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const gateway=new WorkbenchSubagentSettings({controller:()=>controller,assertWritable})
  const request={ns:'subagent',expectedRevision:2,ops:[{op:'set',path:['maxDepth'],value:3}]}
  const writing=gateway.mutate(owner,request)
  expect(gateway.activeWrites).toBe(1)
  expect(controller.mutate).not.toHaveBeenCalled()
  admit();await vi.waitFor(()=>expect(controller.mutate).toHaveBeenCalledOnce())
  expect(gateway.activeWrites).toBe(1)
  finish({revision:3});await writing
  expect(gateway.activeWrites).toBe(0)
  assertWritable.mockRejectedValue(Object.assign(new Error('Host draining'),{status:503}))
  await expect(gateway.mutate(owner,request)).rejects.toMatchObject({status:503})
  expect(controller.mutate).toHaveBeenCalledOnce()
  expect(gateway.activeWrites).toBe(0)
})
