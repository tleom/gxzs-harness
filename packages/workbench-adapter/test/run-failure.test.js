import { expect, it } from 'vitest'
import { runFailure, presentRunEvent, goalFailureReason, resumeGoalSelection } from '../src/run-failure.js'

const rejected = '400 data: {"error":{"code":"data_inspection_failed","message":"Input text data may contain inappropriate content."},"id":"request-1"}'
it('classifies the actual provider input rejection while retaining ordinary native errors', () => {
  expect(runFailure({ code: 'INVALID_REQUEST', message: rejected })).toMatchObject({ code: 'data_inspection_failed', message: expect.stringContaining('相同上下文') })
  expect(runFailure('400 bad request')).toMatchObject({ message: '400 bad request' })
  expect(runFailure('tool said data_inspection_failed')).toMatchObject({ message: 'tool said data_inspection_failed', code: undefined })
  expect(runFailure(rejected.replace('Input text', 'Output text')).message).toContain('本次输出')
  expect(runFailure(undefined)).toBeUndefined()
  const output = presentRunEvent({ event: 'workbench_end', error: rejected.replace('Input text', 'Output text') })
  expect(presentRunEvent(output)).toEqual(output)
})
it('formats old persisted terminal events consistently without rewriting their original record', () => {
  const event = { event: 'workbench_end', error: rejected, _id: '5-0', status: 'failed' }
  expect(presentRunEvent(event)).toMatchObject({ _id: '5-0', error_code: 'data_inspection_failed', error: expect.stringContaining('模型服务拒绝') })
  expect(event.error).toBe(rejected)
  expect(goalFailureReason({ phase: 'active', activation: 'disarmed' }, { status: 'failed', error: rejected })).toContain('模型服务拒绝')
  expect(goalFailureReason({ phase: 'paused' }, { status: 'failed', error: rejected })).toBeNull()
})
it('uses current model preferences on goal resume while preserving frozen resources', () => {
  expect(resumeGoalSelection({ model: 'old/model', model_parameters: { reasoning_effort: 'off' }, resource_context: 'Original resources' },
    { model: 'selected/model', model_parameters: { reasoning_effort: 'high' } })).toEqual({ model: 'selected/model', model_parameters: { reasoning_effort: 'high' }, resource_context: 'Original resources', command: 'goal' })
})
