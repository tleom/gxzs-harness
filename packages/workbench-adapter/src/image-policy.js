// Progressive JPEG and interlaced PNG retain full-frame decoder state even
// when the requested output is small. Bound them before raster decoding.
export const MAX_PROGRESSIVE_IMAGE_PIXELS = 16_000_000
export const IMAGE_DECODE_BUDGET_MESSAGE = '渐进式或隔行图片最多 1600 万像素，请缩小后重试'
export const exceedsImageDecodeBudget = metadata => metadata.isProgressive === true
  && metadata.width * metadata.height > MAX_PROGRESSIVE_IMAGE_PIXELS
