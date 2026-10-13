import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchRuntime } from '../src/runtime.js'
import { projectInboxClaim, nativePresentation } from '../src/projection.js'

describe('frozen run MCP authorization', () => {
  it('releases a rejected sidebar receipt so a later explicit activation can use a fresh identity', () => {
    const database = new WorkbenchDatabase(':memory:')
    try {
      const chat = database.createChat({ ownerId: 't:1', sessionId: 'root', selection: {} })
      const original = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 'root', query: 'delegate', selection: { subagent_ids: ['child'] }, mcpTools: [{ id: 'search', version: 'v1' }] }).run
      database.transitionRun('t:1', original.id, 'completed')
      const root = { id: 'root', session: { id: 'root' }, status: 'idle' }
      const child = { id: 'child', session: { id: 'child' }, status: 'idle' }
      const runtime = new WorkbenchRuntime(new Context(), database, 't:1')
      runtime.agents = { get: id => id === 'root' ? root : child, list: () => [root, child], isOwnedBy: (id, parent) => id === 'child' && parent === root }
      const rejected = runtime.prepareChildPrompt(chat, { id: 'child', title: '调查员' }, 'rejected')
      runtime.rejectChildPrompt(rejected)
      expect(database.getRun('t:1', rejected.id).status).toBe('discarded')
      expect(database.pendingRunFences('t:1')).toEqual([])
      expect(() => runtime.prepareChildPrompt(chat, { id: 'child', title: '调查员' }, 'rejected')).toThrow('该消息已结束')
      expect(runtime.childPrompts.has('child')).toBe(false)
      expect(runtime.childRuns.has(child)).toBe(false)
      const accepted = runtime.prepareChildPrompt(chat, { id: 'child', title: '调查员' }, 'accepted')
      expect(accepted.id).not.toBe(rejected.id)
      expect(accepted.mcpTools).toEqual(original.mcpTools)
      expect(runtime.childRuns.get(child)).toBe(accepted.id)
    } finally { database.close() }
  })
  it('gives an explicit sidebar activation a fresh receipt while preserving the old fence and frozen resource scope', () => {
    const database=new WorkbenchDatabase(':memory:')
    try {
      const chat=database.createChat({ownerId:'t:1',sessionId:'root',selection:{}})
      const original=database.createRun({ownerId:'t:1',chatId:chat.id,sessionId:'root',query:'delegate',selection:{subagent_ids:['child']},mcpTools:[{id:'search',version:'v1'}]}).run
      database.transitionRun('t:1',original.id,'completed');database.requireRunFence('t:1',original.id);database.confirmRunFence('t:1',original.id)
      const root={id:'root',session:{id:'root'},status:'idle'}
      const child={id:'child',session:{id:'child'},status:'idle',cancel:()=>{throw Error('old stop reached fresh child')}}
      const runtime=new WorkbenchRuntime(new Context(),database,'t:1')
      runtime.agents={get:id=>id==='root'?root:child,list:()=>[root,child],isOwnedBy:(id,parent)=>id==='child'&&parent===root}
      runtime.scheduler={hasAdmission:()=>true}
      const receipt=runtime.prepareChildPrompt(chat,{id:'child',title:'调查员'},'request')
      expect(receipt.id).not.toBe(original.id)
      expect(runtime.prepareChildPrompt(chat,{id:'child',title:'调查员'},'request').id).toBe(receipt.id)
      expect(runtime.prepareChildPrompt(chat,{id:'child',title:'调查员'},'second-message').id).toBe(receipt.id)
      expect(database.listRuns('t:1',chat.id)).toHaveLength(2)
      child.status='running';runtime.bindChild(child)
      expect(runtime.authorizeMcp('child','search','v1')).toMatchObject({runId:receipt.id})
      expect(runtime.authorizeRunMcp('t:1',receipt.id,'search','v1')).toBe(true)
      expect(runtime.authorizeRunMcp('t:1',original.id,'search','v1')).toBe(false)
      expect(runtime.authorizeMcp('child','search','v2')).toBeUndefined()
      runtime.cancelOwned('root',original.id)
      child.status='idle';runtime.settleChild(child)
      expect(database.getRun('t:1',receipt.id).status).toBe('completed')
      expect(runtime.prepareChildPrompt(chat,{id:'child',title:'调查员'},'second-message').id).toBe(receipt.id)
      expect(database.getRun('t:1',original.id).stopConfirmation.fenced).toBe(true)
      const message={id:'report',source:{kind:'agent-message',senderSessionId:'child'},content:[{type:'text',text:'Agent child sent a message: '},{type:'text',text:'调查结果'}]}
      const parent=projectInboxClaim(database,{agent:root,message,turn:2},'t:1')
      expect(parent).toMatchObject({parentRunId:receipt.id,selection:{native_notice:true,native_child:false}})
      expect(nativePresentation(parent,{type:'user/message',time:1000,data:message})).toMatchObject([{event:'workbench_agent_message',sender_name:'调查员',query:'调查结果'}])
      expect(nativePresentation(parent,{type:'user/message',time:1000,data:{id:'settled',source:{kind:'subagent-settled',senderSessionId:'child',summary:'completed'},content:[{type:'text',text:'child completed'}]}})).toMatchObject([{query:'child completed'}])
    } finally {database.close()}
  })
  it('retains the exact spawning run for a live native child after its parent completes or accepts another prompt', () => {
    const database = new WorkbenchDatabase(':memory:')
    try {
      const chat = database.createChat({ ownerId: 't:1', sessionId: 'root', selection: {} })
      const { run } = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 'root', query: 'spawn', selection: {}, mcpTools: [{ id: 'old', version: 'v1' }] })
      database.bindRunMessage('root', run.id, 1, 'message')
      database.transitionRun('t:1', run.id, 'running')
      let turn = 1
      const root = { id: 'root', session: { id: 'root' }, status: 'running', ctx: { sessionProjections: { stateOf: () => ({ lastTurn: turn }) } } }
      const child = { id: 'child', session: { id: 'child' }, status: 'running', cancel() {} }
      const unrelated = { id: 'unrelated', session: { id: 'unrelated', header: { parentSession: 'root' } }, status: 'running' }
      const agents = { list: () => [root, child, unrelated], get: id => [root, child, unrelated].find(item => item.id === id), isOwnedBy: (id, parent) => id === 'child' && parent === root }
      const runtime = new WorkbenchRuntime(new Context(), database, 't:1'); runtime.agents = agents
      runtime.scheduler = { hasAdmission: () => true }
      runtime.bindChild(child)
      database.transitionRun('t:1', run.id, 'completed'); root.status = 'idle'
      expect(runtime.executionRun('root')).toMatchObject({ id: run.id, background: true })
      expect(runtime.authorizeMcp('child', 'old', 'v1')).toMatchObject({ runId: run.id })
      expect(runtime.authorizeRunMcp('t:1', run.id, 'old', 'v1')).toBe(true)
      expect(runtime.authorizeMcp('unrelated', 'old', 'v1')).toBeUndefined()
      const next = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 'root', query: 'new', selection: {}, mcpTools: [{ id: 'new', version: 'v2' }] }).run
      database.bindRunMessage('root', next.id, 2, 'next-message'); database.transitionRun('t:1', next.id, 'running'); turn = 2
      expect(runtime.authorizeMcp('child', 'new', 'v2')).toBeUndefined()
      expect(runtime.authorizeMcp('child', 'old', 'v1')).toMatchObject({ runId: run.id })
      runtime.childRuns.delete(child)
      runtime.bindChild(child)
      expect(runtime.authorizeMcp('child', 'old', 'v1')).toMatchObject({ runId: run.id })
      expect(runtime.authorizeMcp('child', 'new', 'v2')).toBeUndefined()
      child.status = 'idle'
      expect(runtime.authorizeMcp('child', 'old', 'v1')).toBeUndefined()
      expect(runtime.authorizeRunMcp('t:1', run.id, 'old', 'v1')).toBe(false)
    } finally { database.close() }
  })
  it('authorizes only the frozen owner, resource and revision', () => {
    const database = new WorkbenchDatabase(':memory:')
    try {
      const chat = database.createChat({ ownerId: 't:1', sessionId: 's1', selection: {} })
      const { run } = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's1', query: 'q', selection: {}, mcpTools: [{ id: 'personal:server:search', version: 'v1' }] })
      database.transitionRun('t:1', run.id, 'running')
      const runtime = new WorkbenchRuntime(new Context(), database, 't:1')
      runtime.agents = new Map([['s1', { id: 's1' }]])
      expect(runtime.authorizeRunMcp('t:1', run.id, 'personal:server:search', 'v1')).toBe(true)
      expect(runtime.authorizeRunMcp('t:2', run.id, 'personal:server:search', 'v1')).toBe(false)
      expect(runtime.authorizeRunMcp('t:1', 'missing', 'personal:server:search', 'v1')).toBe(false)
      expect(runtime.authorizeRunMcp('t:1', run.id, 'personal:server:search', 'v2')).toBe(false)
      expect(runtime.authorizeRunMcp('t:1', run.id, 'global:other:search', 'v1')).toBe(false)
      expect(runtime.authorizeMcp('s1', 'personal:server:search', 'v1')).toMatchObject({ runId: run.id, ownerId: 't:1' })
      expect(runtime.authorizeMcp('s1', 'personal:server:search', 'v2')).toBeUndefined()
      expect(runtime.authorizeMcp('s1', 'global:other:search', 'v1')).toBeUndefined()
      const other = new WorkbenchRuntime(new Context(), database, 't:2')
      expect(other.authorizeMcp('s1', 'personal:server:search', 'v1')).toBeUndefined()
      database.transitionRun('t:1', run.id, 'completed')
      expect(runtime.authorizeRunMcp('t:1', run.id, 'personal:server:search', 'v1')).toBe(false)
      expect(runtime.authorizeMcp('s1', 'personal:server:search', 'v1')).toBeUndefined()
    } finally { database.close() }
  })
})
