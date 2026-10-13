import { expect, it, vi } from 'vitest'
import { registerBrowserTool } from '../src/browser-tool.js'

function fixture() {
  const agent = { id: 'native', session: { id: 'native' } }
  const chat = { id: '12345678-1234-1234-1234-123456789abc', sessionId: 'native', ownerId: 'owner' }
  const command = vi.fn(async value => value.action === 'snapshot' ? '{"text":"Example","elements":[]}' : undefined)
  const browser = { command, frame: { url: 'https://example.com/', title: 'Example' } }
  const browsers = { create: vi.fn(async () => {}), require: vi.fn(() => browser) }
  const runtime = { rootOf: () => agent, executionRun: () => ({ id: 'run', status: 'running', ownerId: 'owner' }), scheduler: { hasAdmission: () => true } }
  const database = { getChatBySession: () => chat, appendEvent: vi.fn() }
  const definition = registerBrowserTool({ tools: { register: vi.fn() }, systemPrompt: { section: vi.fn(), getSectionOrder: () => 3000 } }, { browsers, runtime, database, ownerId: 'owner' })
  return { definition, browser, browsers, runtime, database, chat, exec: { agent, signal: new AbortController().signal } }
}

it('uses the root chat browser and returns a fresh observation after selector input', async () => {
  const test = fixture()
  const value = await test.definition.execute({ action: 'text', selector: '#search', text: '中文' }, test.exec)
  expect(test.browsers.create).toHaveBeenCalledWith({ ownerId: 'owner' }, { id: test.chat.id, chat_id: test.chat.id }, test.exec.signal)
  expect(test.browser.command.mock.calls.map(([value]) => value)).toEqual([{ action: 'element-text', selector: '#search', text: '中文' }, { action: 'snapshot' }])
  expect(value).toMatchObject({ browser_id: test.chat.id, url: 'https://example.com/', content: expect.stringContaining('Example') })
  expect(test.database.appendEvent).toHaveBeenCalledWith('owner', 'run', { event: 'workbench_browser_open', chat_id: test.chat.id })
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
