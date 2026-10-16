import { afterAll, beforeAll, expect, it } from 'vitest'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { argumentStreamPaths, assertDshArgumentConsumer, prepareArgumentStream } from '../../../scripts/prepare-dsh-stream-arguments.mjs'

let original, prepared, consumerSource, stream, parseCount, toStreamChunks
const temporary = []
beforeAll(async () => {
  const paths = await argumentStreamPaths(fileURLToPath(new URL('../../../profiles/workbench/', import.meta.url)))
  original = await readFile(paths.provider, 'utf8')
  prepared = prepareArgumentStream(original)
  consumerSource = await readFile(paths.consumer, 'utf8')
  const provider = join(dirname(paths.provider), `gxzs-test-${randomUUID()}.js`)
  const consumer = join(dirname(paths.consumer), `gxzs-test-${randomUUID()}.js`)
  temporary.push(provider, consumer)
  await writeFile(provider, prepared.replace('import { parseStreamingJson } from "../utils/json-parse.js";',
    'import { parseStreamingJson as originalParse } from "../utils/json-parse.js";\nlet calls=0; function parseStreamingJson(value){calls++;return originalParse(value)}; export const parseCount=()=>calls;'))
  await writeFile(consumer, consumerSource+'\nexport { toStreamChunks };\n')
  ;({ stream, parseCount } = await import(pathToFileURL(provider).href))
  ;({ toStreamChunks } = await import(pathToFileURL(consumer).href))
})
afterAll(async () => { await Promise.all(temporary.map(path => unlink(path))) })

const model = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://fixture.invalid/v1',
  reasoning: false, input: ['text'], contextWindow: 1_000_000, maxTokens: 128_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'exercise arguments' }], timestamp: 0 }] }
function fetchStream(argumentsByTool, { signal, stopEarly = false, pauseAt } = {}) {
  const frames = []
  const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  argumentsByTool.forEach((_,index) => frames.push(frame({ tool_calls: [{ index, id: `tool-${index}`, type: 'function', function: { name: 'write', arguments: '' } }] })))
  for (let offset=0;offset<Math.max(...argumentsByTool.map(s=>s.length));offset+=64)
    argumentsByTool.forEach((value,index)=>{if(offset<value.length)frames.push(frame({ tool_calls: [{ index, function: { arguments: value.slice(offset,offset+64) } }] }))})
  if (!stopEarly) frames.push(frame({},'tool_calls'))
  frames.push('data: [DONE]\n\n')
  let i=0
  return async () => new Response(new ReadableStream({ async pull(controller) {
    // Model a network gap so cancellation occurs before the producer finishes.
    if(i===pauseAt)await new Promise(resolve=>setTimeout(resolve,20))
    if(signal?.aborted){controller.error(signal.reason);return}
    if(i===frames.length){controller.close();return}
    controller.enqueue(new TextEncoder().encode(frames[i++]))
  } }), { headers: { 'content-type': 'text/event-stream' } })
}
async function run(values, options={}) {
  const before = parseCount()
  const chunks = []
  const events=stream(model,context,{ apiKey:'fixture-only',maxRetries:0,fetch:fetchStream(values,options),signal:options.signal })
  for await(const chunk of toStreamChunks(events,model.contextWindow,options.signal,model.id)) chunks.push(chunk)
  return { chunks, parses: parseCount()-before }
}
const hash=value=>createHash('sha256').update(value).digest('hex')

it('guards the installed producer and native consumer and applies idempotently', () => {
  assertDshArgumentConsumer(consumerSource)
  expect(prepareArgumentStream(prepared)).toBe(prepared)
  expect(() => prepareArgumentStream(prepared.replace('const finishBlock = (block) => {','const changed = (block) => {'))).toThrow('contract changed')
  expect(() => assertDshArgumentConsumer(consumerSource.replace('argumentsDelta: event.delta','argumentsDelta: event.partial.arguments'))).toThrow('consumer changed')
})
it('preserves every raw delta and final native arguments for two interleaved large tools', async () => {
  const objects=[{path:'a.txt',content:'中文\\"\n'.repeat(40_000)},{path:'b.txt',content:'b'.repeat(300_000)}]
  const values=objects.map(value=>JSON.stringify(value))
  const { chunks,parses }=await run(values)
  expect(parses).toBe(2)
  for(let i=0;i<values.length;i++){
    const delta=chunks.filter(c=>c.type==='tool-call-delta'&&c.index===i).map(c=>c.argumentsDelta).join('')
    expect(hash(delta)).toBe(hash(values[i]))
    const block=chunks.find(c=>c.type==='block-end'&&c.index===i).block
    expect(block.id).toBe(`tool-${i}`)
    expect(hash(JSON.stringify(JSON.parse(block.arguments)))).toBe(hash(values[i]))
  }
  expect(chunks.at(-1).type).toBe('finish')
  expect(chunks.at(-1).reason.kind).not.toBe('error')
},10_000)
it('retains the upstream final repair behavior for malformed escapes and raw control characters', async () => {
  const raw='{"path":"a.txt","content":"line1\nline2\\q"}'
  const {chunks,parses}=await run([raw])
  expect(parses).toBe(1)
  const block=chunks.find(c=>c.type==='block-end').block
  expect(JSON.parse(block.arguments)).toEqual({path:'a.txt',content:'line1\nline2\\q'})
})
it('does not turn a prematurely closed stream into a successful tool request', async () => {
  const {chunks}=await run(['{"path":"a.txt","content":"short"}'],{stopEarly:true})
  expect(chunks.at(-1)).toMatchObject({type:'finish',reason:{kind:'error'}})
})
it('preserves cancellation instead of emitting a successful tool completion', async () => {
  const controller=new AbortController();controller.abort(new Error('cancel test'))
  const {chunks}=await run(['{"path":"a.txt"}'],{signal:controller.signal})
  expect(chunks.at(-1)).toMatchObject({type:'finish',reason:{kind:'aborted'}})
})
it('preserves native abort while a large argument is still streaming', async () => {
  const controller=new AbortController(),before=parseCount(),chunks=[]
  const values=[JSON.stringify({path:'large.txt',content:'x'.repeat(200_000)})]
  const events=stream(model,context,{apiKey:'fixture-only',maxRetries:0,fetch:fetchStream(values,{signal:controller.signal,pauseAt:120}),signal:controller.signal})
  let received=0
  for await(const chunk of toStreamChunks(events,model.contextWindow,controller.signal,model.id)){
    chunks.push(chunk)
    if(chunk.type==='tool-call-delta'&&++received===100)controller.abort(new Error('cancel in flight'))
  }
  expect(received).toBeGreaterThanOrEqual(100)
  expect(received).toBeLessThan(Math.ceil(values[0].length/64))
  // Upstream may finalize the partial block before publishing its abort; the
  // native terminal outcome, not that partial block, controls execution.
  expect(parseCount()-before).toBeLessThanOrEqual(1)
  expect(chunks.at(-1)).toMatchObject({type:'finish',reason:{kind:'aborted'}})
})
