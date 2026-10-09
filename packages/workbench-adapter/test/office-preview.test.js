import { describe, expect, it, vi } from 'vitest'
import { nativeOfficePreview } from '../src/office-preview.js'

function fixture(convert) {
  const fileManager = { operate: vi.fn(async ({ operation }) => operation === 'stat'
    ? {kind:'file',size:3,version:'v1'} : {data:'YWJj',version:'v1'}) }
  return {owner:{ownerId:'owner'},path:'conversations/test.docx',fileManager,converter:{convert},signal:new AbortController().signal}
}
describe('native Office preview boundary', () => {
  it('authorizes before admission and defers the source read to the native queue', async () => {
    const pdf = Buffer.from('%PDF-1.7')
    const args = fixture(vi.fn(async (request, signal) => {
      expect(args.fileManager.operate).toHaveBeenCalledTimes(1)
      expect(request.source.key).toBe(JSON.stringify(['owner',args.path]))
      expect(request.source.bytes).toBe(3)
      expect(signal).toBe(args.signal)
      const source=await request.source.read(signal,3)
      expect(source.bytes.toString()).toBe('abc')
      expect(source.version).toBe('v1')
      return {pdf}
    }))
    expect(await nativeOfficePreview(args)).toBe(pdf)
  })
  it('does not read or convert formats owned by the existing custom preview', async () => {
    const args=fixture(vi.fn()); args.path='document.odt'
    expect(await nativeOfficePreview(args)).toBeUndefined()
    expect(args.fileManager.operate).not.toHaveBeenCalled()
  })
  it('does not convert inaccessible files', async () => {
    const args=fixture(vi.fn()); args.fileManager.operate.mockRejectedValue({status:403})
    await expect(nativeOfficePreview(args)).rejects.toMatchObject({status:403})
    expect(args.converter.convert).not.toHaveBeenCalled()
  })
  it.each([['source-changed',409],['busy',429],['timeout',504],['unavailable',503]])('maps native %s failures without exposing diagnostics', async (code,status) => {
    const args=fixture(vi.fn().mockRejectedValue({code,message:'internal diagnostics'}))
    await expect(nativeOfficePreview(args)).rejects.toMatchObject({status})
  })
  it('enforces the admitted source capacity', async () => {
    const args=fixture(vi.fn(async request => {
      await request.source.read(args.signal,2)
      throw new Error('unreachable')
    }))
    await expect(nativeOfficePreview(args)).rejects.toMatchObject({status:413})
  })
})
