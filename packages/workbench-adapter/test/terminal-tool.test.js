import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { sidebarTerminalSource } from '../../../scripts/prepare-sidebar-terminal.mjs'
import { registerTerminalTool } from '../src/terminal-tool.js'
import { TerminalUplink } from '../src/terminal-uplink.js'

const id = '12345678-1234-1234-1234-123456789abc'
function fixture() {
  const agent = { id: 'native', session: { id: 'native' } }
  const chat = { id: 'chat', sessionId: 'native', ownerId: 'owner' }
  const info = { id, title: 'bash', state: 'running' }
  const native = { list: vi.fn(() => [info]), create: vi.fn(async (_agent,request) => ({...info,id:request.id})),
    writeFromAgent: vi.fn(async () => {}), inspectForAgent: vi.fn(async () => ({info,screen:'ready\n$ ',truncated:false})), close: vi.fn(async () => {}) }
  const runtime = { rootOf: () => agent, executionRun: () => ({id:'run',ownerId:'owner',status:'running'}),scheduler:{hasAdmission:()=>true} }
  const database = { getChatBySession: () => chat, appendEvent: vi.fn() }
  const definition = registerTerminalTool({tools:{register:vi.fn()},systemPrompt:{section:vi.fn(),getSectionOrder:()=>3000}}, {native,runtime,database,ownerId:'owner'})
  return {native,runtime,database,definition,agent,exec:{agent,signal:new AbortController().signal}}
}
it('reuses the root chat PTY, preserves raw input and opens the same sidebar terminal', async () => {
  const test = fixture()
  const result = await test.definition.execute({action:'write',data:'printf "中文\\n"\r',wait_ms:0},test.exec)
  expect(test.native.create).not.toHaveBeenCalled()
  expect(test.native.writeFromAgent).toHaveBeenCalledWith(test.agent,id,'printf "中文\\n"\r',test.exec.signal)
  expect(test.database.appendEvent).toHaveBeenCalledWith('owner','run',{event:'workbench_terminal_open',chat_id:'chat',terminal_id:id})
  expect(result).toMatchObject({terminal_id:id,state:'running',screen:'ready\n$ '})
  await test.definition.execute({action:'key',key:'Control+C',wait_ms:0},test.exec)
  expect(test.native.writeFromAgent).toHaveBeenLastCalledWith(test.agent,id,'\x03',test.exec.signal)
})
it('creates one bounded native PTY when no terminal exists and returns its actual identity', async () => {
  const test=fixture();test.native.list.mockReturnValue([])
  const result=await test.definition.execute({action:'open',wait_ms:0},test.exec)
  expect(test.native.create).toHaveBeenCalledWith(test.agent,{id:result.terminal_id,cols:80,rows:24},test.exec.signal)
  expect(result.terminal_id).toMatch(/^[a-f\d-]{36}$/)
  expect(test.native.writeFromAgent).not.toHaveBeenCalled()
})
it('reopens an exited terminal as a usable shell for the model', async()=>{
  const test=fixture();test.native.list.mockReturnValue([{id,title:'bash',state:'exited'}])
  const result=await test.definition.execute({action:'open',wait_ms:0},test.exec)
  expect(test.native.close).not.toHaveBeenCalled()
  expect(test.native.create).toHaveBeenCalledOnce()
  expect(result.terminal_id).not.toBe(id)
  expect(result.state).toBe('running')
})
it('opens additional terminals and reuses only an explicitly selected terminal id', async()=>{
  const test=fixture()
  const first=await test.definition.execute({action:'open',wait_ms:0},test.exec)
  const second=await test.definition.execute({action:'open',wait_ms:0},test.exec)
  expect(first.terminal_id).not.toBe(second.terminal_id)
  expect(test.native.create).toHaveBeenCalledTimes(2)
  expect(test.native.close).not.toHaveBeenCalled()
  const attached=await test.definition.execute({action:'open',terminal_id:id,wait_ms:0},test.exec)
  expect(attached.terminal_id).toBe(id)
  expect(test.native.create).toHaveBeenCalledTimes(2)
})
it('rejects foreign terminal IDs and invalid input before allocating, writing or opening a tab', async () => {
  for (const args of [{action:'write'}, {action:'key',key:'__proto__'}, {action:'read',wait_ms:2001}, {action:'read',terminal_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}]) {
    const test=fixture()
    await expect(test.definition.execute(args,test.exec)).rejects.toBeTruthy()
    expect(test.native.create).not.toHaveBeenCalled()
    expect(test.native.writeFromAgent).not.toHaveBeenCalled()
    expect(test.database.appendEvent).not.toHaveBeenCalled()
  }
  for (const run of [{ownerId:'foreign',status:'running'}, {ownerId:'owner',status:'completed'}, {ownerId:'owner',status:'running',stopConfirmation:{fenced:true}}]) {
    const test=fixture();test.runtime.executionRun=()=>run
    await expect(test.definition.execute({action:'open',wait_ms:0},test.exec)).rejects.toMatchObject({status:403})
    expect(test.native.inspectForAgent).not.toHaveBeenCalled()
  }
  const test=fixture();test.runtime.scheduler.hasAdmission=()=>false
  await expect(test.definition.execute({action:'open',wait_ms:0},test.exec)).rejects.toMatchObject({status:403})
})
it('does not leave a tab event after aborted allocation or replay input after cancellation', async () => {
  const test=fixture(),abort=new AbortController()
  test.native.list.mockReturnValue([])
  test.native.create.mockImplementation(async (_agent,request)=>{abort.abort();return {id:request.id,title:'bash'}})
  await expect(test.definition.execute({action:'open',wait_ms:0},{...test.exec,signal:abort.signal})).rejects.toBeTruthy()
  expect(test.native.writeFromAgent).not.toHaveBeenCalled()
  expect(test.database.appendEvent).not.toHaveBeenCalled()
})
it('keeps the native UI attachment writable while the Agent observes and writes the same real screen', async () => {
  const require=createRequire(new URL('../../../profiles/workbench/package.json',import.meta.url))
  const entry=require.resolve('@deepseek-ai/dsh-api-terminal-controller')
  const original=await readFile(entry,'utf8')
  const patched=sidebarTerminalSource(original)
  expect(sidebarTerminalSource(patched)).toBe(patched)
  expect(()=>sidebarTerminalSource('upstream changed')).toThrow('contract changed')
  const standalone=patched.replace(/from "([^".][^"]*)"/g,(_all,name)=>`from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)}`)
    .replaceAll('import.meta.url',JSON.stringify(pathToFileURL(entry).href))
    .replace('export { TerminalController, TerminalController as default };','export { BrowserTerminal, TerminalController };')
  const {BrowserTerminal,TerminalController}=await import('data:text/javascript;base64,'+Buffer.from(standalone).toString('base64'))
  let output, finish
  const handle={write:vi.fn(async()=>{}),output:{async *[Symbol.asyncIterator](){yield await new Promise(resolve=>{output=resolve})}},done:new Promise(resolve=>{finish=resolve}),terminate:async()=>{finish({exitCode:0})}}
  const terminal=new BrowserTerminal(handle,{id,title:'bash',cols:80,rows:24,state:'running'},100,1024*1024)
  const abort=new AbortController()
  const uplink=new TerminalUplink({maxBytes:65536,signal:abort.signal,abort:reason=>abort.abort(reason)})
  const ui=terminal.attach(uplink,{maxInputBytes:32768,maxCols:500,maxRows:200},abort.signal)[Symbol.asyncIterator]()
  expect((await ui.next()).value.writable).toBe(true)
  output(Buffer.from('ready\r\n$ '))
  expect((await ui.next()).value.type).toBe('output')
  const before=await terminal.inspectForAgent(abort.signal)
  expect(before.info.state).toBe('running')
  expect(before.screen).toContain('ready')
  terminal.screen.resize(80, 120)
  const tall=await terminal.inspectForAgent(abort.signal)
  expect(tall.screen).toContain('ready')
  expect(tall.truncated).toBe(false)
  await terminal.writeFromAgent('echo ai\r',abort.signal)
  const writing=uplink.send({type:'write',data:'echo user\r'})
  const ack=(await ui.next()).value
  expect(ack).toEqual({type:'ack',sequence:1})
  uplink.acknowledge(ack)
  await writing
  expect(handle.write.mock.calls.map(([data])=>data)).toEqual(['echo ai\r','echo user\r'])
  const cancelled=new AbortController();cancelled.abort()
  await expect(terminal.writeFromAgent('echo stopped\r',cancelled.signal)).rejects.toBeTruthy()
  expect(handle.write).toHaveBeenCalledTimes(2)
  finish({exitCode:0})
  abort.abort();await ui.return();await terminal.close()
  const owner=()=>({terminals:new Map(),pending:new Map(),allocations:new Map(),closedIds:new Set(),lifetime:new AbortController()})
  const a=owner(),b=owner();a.terminals.set('one',{});b.terminals.set('other',{})
  const allocation={info:{id:'new'},monitor:vi.fn()}
  const controller={lifetime:new AbortController(),config:{maxTerminals:1},owners:new Map([['a',a],['b',b]]),
    owner:()=>b,dimensions:()=>{},requireOpen:()=>{},spawn:vi.fn(async()=>allocation)}
  const signal=new AbortController().signal
  await expect(TerminalController.prototype.create.call(controller,{}, {id:'new',cols:80,rows:24},signal)).rejects.toMatchObject({code:'terminal/limit-reached'})
  expect(controller.spawn).not.toHaveBeenCalled()
  b.terminals.delete('other')
  await TerminalController.prototype.create.call(controller,{}, {id:'new',cols:80,rows:24},signal)
  expect(controller.spawn).toHaveBeenCalledOnce()
  controller.config.maxTerminals=3
  for(let i=0;i<12;i++) b.terminals.set(`existing-${i}`,{})
  await expect(TerminalController.prototype.create.call(controller,{}, {id:'fourth',cols:80,rows:24},signal)).rejects.toMatchObject({code:'terminal/limit-reached'})
  expect(controller.spawn).toHaveBeenCalledOnce()
  expect(patched).toContain('maxTerminals: z.number().step(1).min(1).max(3).default(3)')
})

it('preserves native exit and failure information when observing a retained terminal', async () => {
  const test=fixture()
  for (const info of [{id,title:'bash',state:'exited',exitCode:7}, {id,title:'bash',state:'failed',error:'PTY disconnected'}]) {
    test.native.inspectForAgent.mockResolvedValue({info,screen:'last screen',truncated:true})
    const value=await test.definition.execute({action:'read',terminal_id:id,wait_ms:0},test.exec)
    expect(value).toMatchObject({state:info.state,truncated:true,...(info.error?{error:info.error}:{exitCode:7})})
  }
})

it('reads the terminal selected by a sidebar reference without substituting another PTY', async () => {
  const test=fixture()
  const value=await test.definition.execute({action:'read',terminal_id:id,wait_ms:0},test.exec)
  expect(value.screen).toBe('ready\n$ ')
  expect(test.native.inspectForAgent).toHaveBeenCalledWith(test.agent,id,test.exec.signal)
  expect(test.native.create).not.toHaveBeenCalled()
  test.native.list.mockReturnValue([])
  await expect(test.definition.execute({action:'read',terminal_id:id,wait_ms:0},test.exec)).rejects.toMatchObject({status:404})
  expect(test.native.create).not.toHaveBeenCalled()
})

it.each(['read', 'write', 'key', 'close'])('does not allocate a terminal implicitly for %s', async action => {
  const test = fixture(); test.native.list.mockReturnValue([])
  await expect(test.definition.execute({action,data:'echo no\r',key:'Enter',wait_ms:0},test.exec)).rejects.toMatchObject({status:404})
  expect(test.native.create).not.toHaveBeenCalled()
  expect(test.database.appendEvent).not.toHaveBeenCalled()
})

it('does not substitute a new shell for an explicitly selected exited terminal', async () => {
  const test=fixture();test.native.list.mockReturnValue([{id,title:'bash',state:'exited'}])
  await expect(test.definition.execute({action:'open',terminal_id:id,wait_ms:0},test.exec)).rejects.toMatchObject({status:409})
  expect(test.native.create).not.toHaveBeenCalled()
})

it('reuses the latest running terminal at capacity without closing or writing to it', async () => {
  const test=fixture()
  const running={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',title:'bash',state:'running'}
  test.native.list.mockReturnValue([{id,state:'running'},running,{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',state:'exited'}])
  const value=await test.definition.execute({action:'open',wait_ms:0},test.exec)
  expect(value.terminal_id).toBe(running.id)
  expect(test.native.create).not.toHaveBeenCalled()
  expect(test.native.close).not.toHaveBeenCalled()
  expect(test.native.writeFromAgent).not.toHaveBeenCalled()
  expect(test.native.inspectForAgent).toHaveBeenCalledWith(test.agent,running.id,test.exec.signal)
})

it('returns an exited screen when all three terminals have exited without discarding them', async () => {
  const test=fixture()
  const infos=[{id,state:'exited'},{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',state:'exited'},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',state:'exited'}]
  test.native.list.mockReturnValue(infos)
  test.native.inspectForAgent.mockResolvedValue({info:infos[2],screen:'saved output',truncated:false})
  const value=await test.definition.execute({action:'open',wait_ms:0},test.exec)
  expect(value).toMatchObject({terminal_id:infos[2].id,state:'exited',screen:'saved output'})
  expect(test.native.create).not.toHaveBeenCalled()
  expect(test.native.close).not.toHaveBeenCalled()
})

it('reuses after concurrent allocation fills capacity and preserves other creation failures', async () => {
  const test=fixture()
  test.native.list.mockReturnValueOnce([]).mockReturnValue([{id,state:'running'}])
  test.native.create.mockRejectedValueOnce(Object.assign(new Error('limit'),{code:'terminal/limit-reached'}))
  await expect(test.definition.execute({action:'open',wait_ms:0},test.exec)).resolves.toMatchObject({terminal_id:id})
  expect(test.native.close).not.toHaveBeenCalled()
  test.native.list.mockReturnValue([])
  test.native.create.mockRejectedValueOnce(new Error('transport failed'))
  await expect(test.definition.execute({action:'open',wait_ms:0},test.exec)).rejects.toThrow('transport failed')
})

it('skips a closing terminal at capacity and opens only the successfully observed terminal',async()=>{
  const test=fixture()
  const infos=[{id,state:'running'},{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',state:'running'},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',state:'running'}]
  test.native.list.mockReturnValue(infos)
  test.native.inspectForAgent.mockRejectedValueOnce(Object.assign(new Error('closing'),{code:'terminal/unavailable'}))
  const value=await test.definition.execute({action:'open',wait_ms:0},test.exec)
  expect(value.terminal_id).toBe(infos[1].id)
  expect(test.native.inspectForAgent.mock.calls.map(call=>call[1])).toEqual([infos[2].id,infos[1].id])
  expect(test.database.appendEvent).toHaveBeenCalledExactlyOnceWith('owner','run',{event:'workbench_terminal_open',chat_id:'chat',terminal_id:infos[1].id})
  expect(test.native.create).not.toHaveBeenCalled()
  expect(test.native.close).not.toHaveBeenCalled()
  expect(test.native.writeFromAgent).not.toHaveBeenCalled()
})

it('does not open stale tabs or substitute explicit targets when a terminal becomes unavailable',async()=>{
  const test=fixture()
  test.native.list.mockReturnValue([{id,state:'running'},{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',state:'running'},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',state:'exited'}])
  test.native.inspectForAgent.mockRejectedValue(Object.assign(new Error('closing'),{code:'terminal/unavailable'}))
  await expect(test.definition.execute({action:'open',wait_ms:0},test.exec)).rejects.toMatchObject({status:409})
  expect(test.native.inspectForAgent).toHaveBeenCalledTimes(3)
  test.native.inspectForAgent.mockClear()
  await expect(test.definition.execute({action:'open',terminal_id:id,wait_ms:0},test.exec)).rejects.toMatchObject({code:'terminal/unavailable'})
  expect(test.native.inspectForAgent).toHaveBeenCalledOnce()
  expect(test.database.appendEvent).not.toHaveBeenCalled()
  expect(test.native.create).not.toHaveBeenCalled()
})
