import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { sidebarTerminalSource } from '../../../scripts/prepare-sidebar-terminal.mjs'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const entry = require.resolve('@deepseek-ai/dsh-api-terminal-controller')
const original = await readFile(entry, 'utf8')
const patched = sidebarTerminalSource(original)
const standalone = patched.replace(/from "([^".][^"]*)"/g, (_all, name) => `from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)}`)
  .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(entry).href))
const { TerminalController } = await import('data:text/javascript;base64,' + Buffer.from(standalone).toString('base64'))

function fixture() {
  const owners = new Map(), completions = new Map()
  const controller = { lifetime: new AbortController(), config: { maxTerminals: 3 }, owners,
    dimensions: () => {}, requireOpen: () => {},
    owner(agent) {
      if (!owners.has(agent.id)) owners.set(agent.id, {terminals:new Map(),pending:new Map(),allocations:new Map(),closedIds:new Set(),lifetime:new AbortController()})
      return owners.get(agent.id)
    },
    spawn: vi.fn((agent, _owner, request) => new Promise((resolve, reject) => {
      completions.set(`${agent.id}/${request.id}`, {reject, resolve: () => resolve({info:{id:request.id,state:'running'},monitor(){},close:async()=>{}})})
    })),
  }
  const signal = new AbortController().signal
  const create = (chat, id) => TerminalController.prototype.create.call(controller, {id:chat}, {id,cols:80,rows:24}, signal)
  const close = (chat, id) => TerminalController.prototype.close.call(controller, {id:chat}, id)
  return { controller, owners, completions, create, close }
}

it('counts pending allocations atomically, joins retries, and allows three in every chat without a global cap', async () => {
  const t=fixture(), requests=[]
  for (const chat of ['a','b','c','d']) {
    for (const id of ['one','two','three']) requests.push(t.create(chat,id))
    await expect(t.create(chat,'four')).rejects.toMatchObject({code:'terminal/limit-reached'})
  }
  const duplicate=t.create('a','one')
  expect(t.controller.spawn).toHaveBeenCalledTimes(12)
  for (const completion of t.completions.values()) completion.resolve()
  await Promise.all(requests)
  expect(await duplicate).toEqual(await requests[0])
  for (const chat of ['a','b','c','d']) expect(t.owners.get(chat).terminals.size).toBe(3)
  await expect(t.create('a','four')).rejects.toMatchObject({code:'terminal/limit-reached'})
  let cleaned
  t.owners.get('a').terminals.get('one').close=()=>new Promise(resolve=>{cleaned=resolve})
  const closing=t.close('a','one')
  await vi.waitFor(()=>expect(cleaned).toBeTypeOf('function'))
  await expect(t.create('a','four')).rejects.toMatchObject({code:'terminal/limit-reached'})
  cleaned(); await closing
  const replacement=t.create('a','four');t.completions.get('a/four').resolve();await replacement
  expect(t.owners.get('b').terminals.size).toBe(3)
})

it('releases failed creation but counts failed cleanup and exited retained screens until closed', async () => {
  const t=fixture(), first=t.create('a','one')
  t.completions.get('a/one').reject(new Error('spawn failed'))
  await expect(first).rejects.toThrow('spawn failed')
  expect(t.owners.get('a').pending.size).toBe(0)
  t.owners.get('a').allocations.set('cleanup',{info:{id:'cleanup',state:'failed'}})
  t.owners.get('a').terminals.set('exited',{info:{id:'exited',state:'exited'},close:async()=>{}})
  const next=t.create('a','two')
  await expect(t.create('a','three')).rejects.toMatchObject({code:'terminal/limit-reached'})
  t.completions.get('a/two').resolve();await next
  await t.close('a','exited')
  const third=t.create('a','three');t.completions.get('a/three').resolve();await third
})

it('migrates old unlimited patches and keeps preparation idempotent', () => {
  const legacy=patched.replace('min(1).max(3).default(3)', 'min(0).default(0)')
    .replace('if (new Set([', 'if (this.config.maxTerminals > 0 && new Set([')
  expect(sidebarTerminalSource(legacy)).toBe(patched)
  expect(sidebarTerminalSource(patched)).toBe(patched)
  expect(() => TerminalController.Config({maxTerminals:0})).toThrow()
  expect(() => TerminalController.Config({maxTerminals:4})).toThrow()
  expect(TerminalController.Config({}).maxTerminals).toBe(3)
})
