import { describe, expect, it } from 'vitest'
import { guardModelToolCalls, registerModelToolCallGuard } from '../src/model-tool-call-guard.js'

const tool = (index, id, name = 'lookup') => ({ type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: '{}' } })
const finish = kind => ({ type: 'finish', reason: { kind } })
async function collect(chunks) {
  let closed = false
  async function* source() { try { yield* chunks } finally { closed = true } }
  const result = []
  for await (const chunk of guardModelToolCalls(source())) result.push(chunk)
  return { result, closed }
}

describe('provider tool identity guard', () => {
  it('uses the native stream middleware for parent and child agents', () => {
    const registrations = []
    registerModelToolCallGuard({ on: (...args) => registrations.push(args) })
    expect(registrations[0][0]).toBe('llm/stream')
    expect(registrations[0][2]).toEqual({ global: true })
  })
  it.each([['', ''], ['', 'lookup'], ['valid-id', '']])('rejects invalid identity %s / %s before admitting a tool result', async (id, name) => {
    const { result, closed } = await collect([tool(0, id, name), tool(1, 'sibling'), finish('tool-calls')])
    expect(result.at(-1)).toEqual(expect.objectContaining({ type: 'finish', reason: expect.objectContaining({ kind: 'error', failure: expect.objectContaining({ code: 'SERVER' }) }) }))
    expect(closed).toBe(true)
  })
  it('rejects duplicate final call ids even when sibling tools are valid', async () => {
    const { result } = await collect([tool(0, 'same'), tool(1, 'same', 'second'), finish('tool-calls')])
    expect(result.at(-1).reason.kind).toBe('error')
  })
  it('accepts final identities that become available after empty streaming deltas', async () => {
    const chunks = [{type:'tool-call-delta',index:0,id:'',argumentsDelta:'{'}, tool(0,'a'), tool(1,'b'), finish('tool-calls')]
    expect((await collect(chunks)).result).toEqual(chunks)
  })
  it('checks delta-only protocols before a successful finish without buffering argument text', async () => {
    const valid = [{type:'tool-call-delta',index:0,id:'a',name:'lookup',argumentsDelta:'{}'},finish('tool-calls')]
    expect((await collect(valid)).result).toEqual(valid)
    const invalid = [{type:'tool-call-delta',index:0,id:'',argumentsDelta:'{}'},finish('tool-calls')]
    expect((await collect(invalid)).result.at(-1).reason.kind).toBe('error')
  })
  it.each(['aborted','error','max-tokens'])('preserves native %s handling for unfinished tool streams', async kind => {
    const chunks = [{type:'block-start',index:0,blockType:'tool-call'},tool(0,''),finish(kind)]
    expect((await collect(chunks)).result).toEqual(chunks)
  })
  it('rejects a malformed response even when the provider omits the finish chunk', async () => {
    expect((await collect([tool(0,'')])).result.at(-1).reason.kind).toBe('error')
  })
  it('matches the native assembler by ignoring late deltas for closed blocks', async () => {
    const chunks=[tool(0,'valid'),{type:'tool-call-delta',index:0,id:'',argumentsDelta:'late'},finish('tool-calls')]
    expect((await collect(chunks)).result).toEqual(chunks)
  })
})
