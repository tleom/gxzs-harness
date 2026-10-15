import { expect, it, vi } from 'vitest'
import { registerBrowserTool } from '../src/browser-tool.js'

function fixture(services = {}) {
  const agent = { id: 'native', session: { id: 'native' } }
  const chat = { id: '12345678-1234-1234-1234-123456789abc', sessionId: 'native', ownerId: 'owner' }
  const command = vi.fn(async value => value.action === 'snapshot' ? { url: 'https://example.com/', title: 'Example', text: 'Example', elements: [] } : undefined)
  const browser = { command, frame: { url: 'https://example.com/', title: 'Example' } }
  const browsers = { create: vi.fn(async () => {}), require: vi.fn(() => browser) }
  const runtime = { rootOf: () => agent, executionRun: () => ({ id: 'run', status: 'running', ownerId: 'owner' }), scheduler: { hasAdmission: () => true } }
  const database = { getChatBySession: () => chat, appendEvent: vi.fn() }
  const definition = registerBrowserTool({ get:key=>services[key], tools: { register: vi.fn() }, systemPrompt: { section: vi.fn(), getSectionOrder: () => 3000 } }, { browsers, runtime, database, ownerId: 'owner' })
  return { definition, browser, browsers, runtime, database, chat, exec: { agent, signal: new AbortController().signal } }
}

it('admits screenshots through native durable image storage only for a declared image-capable route', async () => {
  const attachment={attachmentId:'image-1',mediaType:'image/png',bytes:4,width:10,height:10}
  const saveImages=vi.fn(async()=>[attachment])
  const test=fixture({llm:{resolveModelInfo:vi.fn(async()=>({inputModalities:['text','image']}))},attachments:{saveImages}})
  test.exec.agent.options={provider:'provider',model:'vision-model'}
  test.browser.command.mockImplementation(async value=>value.action==='screenshot'
    ? {image:'cG5n',mediaType:'image/png'} : {url:'https://example.com',title:'Page',text:'Canvas',elements:[],revision:2})
  const result=await test.definition.execute({action:'screenshot'},test.exec)
  expect(saveImages).toHaveBeenCalledWith([{data:Buffer.from('png'),mediaType:'image/png',name:'browser-screenshot'}])
  expect(test.definition.output.render({},result)).toContainEqual({type:'image',attachment})
  expect(result.content).not.toContain('cG5n')
})

it('returns structure without creating image bytes for an unverified model route', async () => {
  const test=fixture()
  const value=await test.definition.execute({action:'screenshot'},test.exec)
  expect(test.browser.command.mock.calls.map(([request])=>request.action)).toEqual(['snapshot'])
  expect(JSON.parse(value.content).image_notice).toContain('未声明图片输入')
  expect(value.image_attachment).toBeUndefined()
})

it('carries its last observation revision to the next operation', async () => {
  const test=fixture()
  test.browser.command.mockResolvedValue({url:'https://example.com',title:'Page',revision:7})
  await test.definition.execute({action:'snapshot'},test.exec)
  await test.definition.execute({action:'click',selector:'#submit'},test.exec)
  expect(test.browser.command).toHaveBeenCalledWith({action:'element-click',selector:'#submit',expected_revision:7},test.exec.signal)
})

it('uses the root chat browser and returns a fresh observation after selector input', async () => {
  const test = fixture()
  const value = await test.definition.execute({ action: 'text', selector: '#search', text: '中文' }, test.exec)
  expect(test.browsers.create).toHaveBeenCalledWith({ ownerId: 'owner' }, { id: test.chat.id, chat_id: test.chat.id }, test.exec.signal)
  expect(test.browser.command.mock.calls.map(([value]) => value)).toEqual([{ action: 'element-text', selector: '#search', text: '中文' }, { action: 'snapshot' }])
  expect(value).toMatchObject({ browser_id: test.chat.id, url: 'https://example.com/', content: expect.stringContaining('Example') })
  expect(test.database.appendEvent).toHaveBeenCalledWith('owner', 'run', { event: 'workbench_browser_open', chat_id: test.chat.id, browser_id: test.chat.id })
})

it('returns the current snapshot URL and title when an SPA changed without an active sidebar watcher', async () => {
  const test = fixture()
  test.browser.command.mockResolvedValue({ url: 'https://example.com/new', title: 'Current page', text: 'Current content', elements: [] })
  const value = await test.definition.execute({ action: 'snapshot' }, test.exec)
  expect(value).toMatchObject({ url: 'https://example.com/new', title: 'Current page' })
  expect(JSON.parse(value.content)).toMatchObject({ text: 'Current content' })
})
it('reuses the chat browser for a new-page action', async () => {
  const test=fixture()
  test.browsers.currentId=()=>test.chat.id
  await test.definition.execute({action:'new_tab',url:'https://example.com/next'},test.exec)
  expect(test.browsers.create).toHaveBeenCalledWith({ownerId:'owner'},{id:test.chat.id,chat_id:test.chat.id},test.exec.signal)
  expect(test.browser.command).toHaveBeenCalledWith({action:'navigate',url:'https://example.com/next'},test.exec.signal)
})

it('validates action-dependent input before starting a worker or opening a tab', async () => {
  for (const args of [{action:'navigate'}, {action:'navigate',url:'file:///private'}, {action:'click',selector:''}]) {
    const test = fixture()
    await expect(test.definition.execute(args,test.exec)).rejects.toMatchObject({status:400})
    expect(test.browsers.create).not.toHaveBeenCalled()
    expect(test.database.appendEvent).not.toHaveBeenCalled()
  }
  const test = fixture()
  test.browsers.create.mockRejectedValue(new Error('worker unavailable'))
  await expect(test.definition.execute({action:'snapshot'},test.exec)).rejects.toThrow('worker unavailable')
  expect(test.database.appendEvent).not.toHaveBeenCalled()
})

it('rejects fenced, unadmitted and foreign activations before browser creation', async () => {
  for (const run of [{ id: 'run', ownerId: 'foreign', status: 'running' }, { id: 'run', ownerId: 'owner', status: 'completed' }, { id: 'run', ownerId: 'owner', status: 'running', stopConfirmation: { fenced: true } }]) {
    const test = fixture()
    test.runtime.executionRun = () => run
    await expect(test.definition.execute({ action: 'snapshot' }, test.exec)).rejects.toMatchObject({ status: 403 })
    expect(test.browsers.create).not.toHaveBeenCalled()
  }
  const test = fixture()
  test.runtime.scheduler.hasAdmission = () => false
  await expect(test.definition.execute({ action: 'snapshot' }, test.exec)).rejects.toMatchObject({ status: 403 })
  expect(test.browsers.create).not.toHaveBeenCalled()
})
