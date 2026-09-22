import { describe, expect, it, vi } from 'vitest'
import { MigrationImporter } from '../src/migration.js'
import { WorkbenchDatabase } from '../src/persistence.js'

const chatId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const workspaceId = '33333333-3333-4333-8333-333333333333'

function bundle() {
  return {
    version: 1, source_id: 'batch-1', owner_id: 'tenant:1',
    workspace: { id: workspaceId, tree_version: 'tree-v1', files: 3, bytes: 10, samples: [] },
    chats: [{
      id: chatId, title: '旧对话', pinned: true, favorited: false, created_at: 1, updated_at: 2,
      selection: { model: 'p/m', tools: [], skills: [], knowledge: [], model_parameters: {}, tool_parameters: {} },
      runs: [{
        id: runId, query: '旧问题', status: 'completed', created_at: 1, updated_at: 2, parent_run_id: null,
        events: [{ event: 'workbench_activity', data: { kind: 'text', text: '旧回答' } }],
      }],
    }],
  }
}

function setup() {
  const database = new WorkbenchDatabase(':memory:')
  const append = vi.fn(() => ({ seq: append.mock.calls.length - 1 }))
  const session = { append }
  let created = false
  const sessions = { create: vi.fn(async () => { created = true; return { sessionId: `session-${chatId}` } }) }
  const agents = { get: vi.fn(() => created ? { session } : undefined) }
  const fileManager = { workspaceId, operate: vi.fn(async () => ({ kind: 'directory', version: 'tree-v1', items: 3, size: 10, files: [] })) }
  const importer = new MigrationImporter({ database, sessions, agents, fileManager, ownerId: 'tenant:1', workspace: '/workspace' })
  return { database, append, sessions, fileManager, importer }
}

describe('legacy workbench migration', () => {
  it('imports deterministic DSH history and adapter journal', async () => {
    const state = setup()
    try {
      const result = await state.importer.import(bundle())
      expect(result).toMatchObject({ source_id: 'batch-1', workspace: { id: workspaceId, tree_version: 'tree-v1' } })
      expect(state.sessions.create).toHaveBeenCalledWith({ sessionId: `session-${chatId}`, cwd: `/workspace/conversations/${chatId}` })
      expect(state.append.mock.calls.map(([type]) => type)).toEqual(['turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
      expect(state.database.getChat('tenant:1', chatId)).toMatchObject({ title: '旧对话', pinned: true })
      expect(state.database.getRun('tenant:1', runId)).toMatchObject({ query: '旧问题', status: 'completed' })
      expect(state.database.allEvents('tenant:1', runId)[0]).toMatchObject({ event: 'workbench_activity' })
    } finally { state.database.close() }
  })

  it('is idempotent for the same digest and rejects changed reuse', async () => {
    const state = setup()
    try {
      const first = await state.importer.import(bundle())
      const second = await state.importer.import(bundle())
      expect(second).toEqual(first)
      expect(state.sessions.create).toHaveBeenCalledOnce()
      const changed = bundle(); changed.chats[0].title = '篡改'
      await expect(state.importer.import(changed)).rejects.toMatchObject({ status: 409 })
    } finally { state.database.close() }
  })

  it('rejects owner, workspace and tree-version mismatches before import', async () => {
    const state = setup()
    try {
      const wrongOwner = bundle(); wrongOwner.owner_id = 'other:1'
      await expect(state.importer.import(wrongOwner)).rejects.toMatchObject({ status: 400 })
      const wrongWorkspace = bundle(); wrongWorkspace.workspace.id = '44444444-4444-4444-8444-444444444444'
      await expect(state.importer.import(wrongWorkspace)).rejects.toMatchObject({ status: 409 })
      state.fileManager.operate.mockResolvedValueOnce({ kind: 'directory', version: 'changed', items: 3, size: 10, files: [] })
      await expect(state.importer.import(bundle())).rejects.toMatchObject({ status: 409 })
      expect(state.sessions.create).not.toHaveBeenCalled()
    } finally { state.database.close() }
  })
})
