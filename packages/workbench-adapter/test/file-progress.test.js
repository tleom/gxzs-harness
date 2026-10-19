import { expect, it, vi } from 'vitest'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { fileToolPreparation } from '../src/display-events.js'
import { createSessionWindowPresenter, presentSessionWindow } from '../src/client/index.js'

const run = { id: 'run' }
const collect = (name, parts, times = parts.map((_, index) => index * 1000)) => {
  const calls = new Map()
  return parts.map((argumentsDelta, index) => fileToolPreparation(run, calls, {
    type: 'tool-call-delta', index: 0,
    ...(index === 0 ? { name, id: 'file' } : {}), argumentsDelta,
  }, times[index]))
}

it('decodes split escapes and CRLF without rescanning or counting the JSON encoding as lines', () => {
  const events = collect('write', ['{"file_path":"/workspace/鳄鱼.html","content":"first\\',
    'r\\nsecond\\u00', '0athird\\n', '"}'])
  expect(events.slice(0, 3).map(item => item.file_progress)).toEqual([
    { path: '/workspace/鳄鱼.html', added: 1, removed: 0 },
    { path: '/workspace/鳄鱼.html', added: 2, removed: 0 },
    { path: '/workspace/鳄鱼.html', added: 3, removed: 0 },
  ])
  expect(events[3]).toBeUndefined()
  expect(JSON.stringify(events)).not.toContain('first')
})

it('counts both sides of an edit and tolerates a filename arriving after content', () => {
  const events = collect('edit', ['{"old_string":"first\\n', 'second","new_string":"next',
    '\\nlast","file_path":"/workspace/da', 'ta.js"}'])
  expect(events.map(item => item.file_progress)).toEqual([
    { path: '', added: 0, removed: 1 },
    { path: '', added: 1, removed: 2 },
    { path: '', added: 2, removed: 2 },
    { path: '/workspace/data.js', added: 2, removed: 2 },
  ])
})

it('coalesces frequent chunks using event time, preserves all lines, and skips unchanged single-line growth', () => {
  const events = collect('write', ['{"path":"a.js","content":"first', '\\nsecond',
    '\\nthird', '\\nfourth', ' more'], [0, 100, 900, 1000, 2000])
  expect(events[0].file_progress.added).toBe(1)
  expect(events[1]).toBeUndefined()
  expect(events[2]).toBeUndefined()
  expect(events[3].file_progress.added).toBe(4)
  expect(events[4]).toBeUndefined()
})

it('retains arguments that precede the tool name, and ignores unrelated tools', () => {
  const calls = new Map()
  expect(fileToolPreparation(run, calls, {type:'tool-call-delta',index:0,argumentsDelta:'{"content":"a\\nb"'})).toBeUndefined()
  expect(fileToolPreparation(run, calls, {type:'tool-call-delta',index:0,id:'f',name:'write',argumentsDelta:',"path":"a.js"}'}).file_progress)
    .toEqual({path:'a.js',added:2,removed:0})
  expect(fileToolPreparation(run, calls, {type:'tool-call-delta',index:1,id:'g',name:'grep',argumentsDelta:'{"pattern":"x"}'})).toBeUndefined()
  expect(calls.get(1).args).toBeUndefined()
})

it('publishes bounded summaries for a large stream and restores the same counts in the native browser projection', () => {
  const argumentsText = JSON.stringify({file_path:'/workspace/large.html',content:'line\n'.repeat(100_000)})
  const parts = argumentsText.match(/.{1,2000}/gs)
  const expected = collect('write', parts).filter(Boolean).map(item=>item.file_progress)
  expect(expected.at(-1)).toEqual({path:'/workspace/large.html',added:100_000,removed:0})
  expect(Math.max(...expected.map(item=>JSON.stringify(item).length))).toBeLessThan(100)
  const entries = parts.map((argumentsDelta,index)=>({event:{type:'assistant/live-chunk',seq:index,time:index*1000,
    data:{turn:1,step:1,attemptId:'a',chunk:{type:'tool-call-delta',index:0,...(index===0?{id:'file',name:'write'}:{}),argumentsDelta}}}}))
  const runs = presentSessionWindow(entries,{sessionId:'s',chatId:'c',running:true})
  expect(runs[0].events.map(item=>item.data.file_progress)).toEqual(expected)
})

it('decodes only appended file chunks in a mounted native detail and resets replaced prefixes',()=>{
 const context={sessionId:'s',chatId:'c',running:true};
 const text=JSON.stringify({path:'large.html',content:'line\n'.repeat(10000)});
 const entries=text.match(/.{1,1000}/gs).map((argumentsDelta,index)=>({event:{type:'assistant/live-chunk',seq:index,time:index*1000,data:{turn:1,step:1,attemptId:'a',chunk:{type:'tool-call-delta',index:0,...(index===0?{id:'file',name:'write'}:{}),argumentsDelta}}}}));
 const expected=presentSessionWindow(entries,context);
 const append=vi.spyOn(PartialArguments.prototype,'append');
 try{
  const project=createSessionWindowPresenter();let result;
  for(let size=1;size<=entries.length;size++)result=project(entries.slice(0,size),context);
  expect(result).toEqual(expected);
  expect(append).toHaveBeenCalledTimes(entries.length);
  project(entries,{...context,running:false});
  expect(append).toHaveBeenCalledTimes(entries.length);
  const rewound=entries.slice(0,2);
  expect(project(rewound,context)).toEqual(presentSessionWindow(rewound,context));
  const replacement=[...entries];replacement[1]={event:{...replacement[1].event,data:{...replacement[1].event.data,chunk:{...replacement[1].event.data.chunk,argumentsDelta:'replacement'}}}};
  expect(project(replacement,context)).toEqual(presentSessionWindow(replacement,context));
  const second=createSessionWindowPresenter();
  expect(second(entries,{...context,sessionId:'other'})).toEqual(presentSessionWindow(entries,{...context,sessionId:'other'}));
 }finally{append.mockRestore();}
});
