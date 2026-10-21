import { createRequire } from 'node:module'
import { exceedsImageDecodeBudget, IMAGE_DECODE_BUDGET_MESSAGE } from './image-policy.js'
import { serializeAttachmentAdmission } from './image-normalizer.js'

const nativeRequire = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const { LocalAttachmentStore, prepareImageFile, commitPreparedImageFile } = nativeRequire('@deepseek-ai/dsh-attachment-local')
const { AttachmentError } = nativeRequire('@deepseek-ai/dsh-attachment')
const sharp = createRequire(nativeRequire.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')

/** Keep native storage and error contracts, including images read by tools. */
export default class WorkbenchAttachmentStore extends LocalAttachmentStore {
  constructor(ctx, config) {
    super(ctx, config)
    // Native durable variants own reuse. One-use uploads must not retain
    // libvips decode graphs from previous source paths in the Host process.
    sharp.cache(false)
  }
  async checkDecodeBudget(input) {
    if (!(input?.data instanceof Uint8Array) || input.data.byteLength > this.imageLimits.maxImageBytes) return
    let metadata
    try {
      const bytes = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength)
      metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: this.imageLimits.maxImagePixels }).metadata()
    } catch { return } // Native admission retains its own malformed-image errors.
    // read_image rewrites IMAGE_TOO_MANY_PIXELS using the ordinary 64 MP cap.
    // Keep this stricter decoder budget and its actionable message distinct.
    if (exceedsImageDecodeBudget(metadata)) throw new AttachmentError(IMAGE_DECODE_BUDGET_MESSAGE, 'IMAGE_DECODE_BUDGET_EXCEEDED')
  }
  async prepareWithinBudget(input) {
    await this.checkDecodeBudget(input)
    return this.compression.run(async () => {
      let policy = this.normalizationPolicy
      for (;;) {
        const prepared = await prepareImageFile(input, this.imageLimits, policy)
        if (prepared.data.byteLength <= policy.maxBytes) return prepared
        // Native encoding's byte target is best-effort. Retain native codecs,
        // references and clean small-image passthrough, reducing pixels only
        // when its actual output exceeds the configured storage byte cap.
        if (policy.maxPixels === 1) throw new AttachmentError('图片规范化结果超过大小限制，请缩小后重试', 'IMAGE_TOO_LARGE')
        policy = { ...policy, maxPixels: Math.max(1, Math.floor(Math.min(policy.maxPixels,
          prepared.ref.width * prepared.ref.height) * 0.5625)) }
      }
    })
  }
  async validateImage(input) {
    return serializeAttachmentAdmission(async () => {
      await this.prepareWithinBudget(input)
    })
  }
  async saveImage(input) {
    return serializeAttachmentAdmission(async () => {
      return commitPreparedImageFile(this.root, await this.prepareWithinBudget(input))
    })
  }
  async saveImages(inputs) {
    return serializeAttachmentAdmission(async () => {
      this.validateImageBatch(inputs)
      const prepared = []
      for (const input of inputs) prepared.push(await this.prepareWithinBudget(input))
      const refs = []
      for (const image of prepared) refs.push(await commitPreparedImageFile(this.root, image))
      return refs
    })
  }
}
