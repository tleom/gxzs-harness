import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { inject } from '../src/index.js'

const contexts = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

it('activates with the published Cordis service dependencies without the optional client catalog', async () => {
  const ctx = new Context(); contexts.push(ctx)
  const apply = vi.fn(scope => {
    for (const name of inject) expect(scope[name]).toBe(ctx[name])
    expect(scope.get('clientModules')).toBeUndefined()
  })
  const services = [...inject]
  expect(services).not.toContain('required')
  expect(services).not.toContain('optional')
  expect(inject).not.toContain('clientModules')
  const finalService = services.pop()
  for (const name of services) ctx.provide(name, { name })
  const probe = ctx.plugin({ name: 'workbench-injection-probe', inject, apply })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(apply).not.toHaveBeenCalled()
  await ctx.plugin({ name: 'final-required-service', apply: scope => { scope.provide(finalService, { name: finalService }) } })
  await probe.await()
  await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce())
})
