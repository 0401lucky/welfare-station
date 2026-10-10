export const FEEDBACK_IMAGE_LIMIT = 3
export const FEEDBACK_IMAGE_BYTES = 5 * 1024 * 1024
export const FEEDBACK_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp'

const unsupported = '仅支持静态 JPG、PNG、WebP 图片。'
const corrupt = '图片损坏或无法读取，请重新选择。'
const animated = '暂不支持动图，请选择静态 JPG、PNG 或 WebP。'
const bytesEqual = (data: Uint8Array, values: number[]) => values.every((byte, index) => data[index] === byte)
const chunkName = (data: Uint8Array, offset: number) => String.fromCharCode(...data.subarray(offset, offset + 4))
function checkDimensions(width: number, height: number) {
  if (!width || !height) throw new Error(corrupt)
  if (width > 8192 || height > 8192 || width * height > 20_000_000) throw new Error('图片尺寸过大：每边最多 8192 像素，总计最多 2000 万像素。')
}

/** Inspect the container before decoding, since browsers display animated inputs. */
export function feedbackImageType(data: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (bytesEqual(data, [0xff, 0xd8, 0xff])) {
    let offset = 2
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) throw new Error(corrupt)
      while (data[offset] === 0xff) offset++
      const marker = data[offset++]
      if (marker === 0xda || marker === 0xd9 || offset + 2 > data.length) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      const size = view.getUint16(offset)
      if (size < 2 || offset + size > data.length) throw new Error(corrupt)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (size < 7) throw new Error(corrupt)
        checkDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3))
        return 'image/jpeg'
      }
      offset += size
    }
    throw new Error(corrupt)
  }
  if (bytesEqual(data, [137, 80, 78, 71, 13, 10, 26, 10])) {
    let offset = 8
    let header = false
    while (offset + 12 <= data.length) {
      const size = view.getUint32(offset)
      const kind = chunkName(data, offset + 4)
      if (offset + size + 12 > data.length) throw new Error(corrupt)
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) throw new Error(animated)
      if (!header && (kind !== 'IHDR' || size !== 13)) throw new Error(corrupt)
      if (kind === 'IHDR') checkDimensions(view.getUint32(offset + 8), view.getUint32(offset + 12))
      header = true
      if (kind === 'IEND' && size === 0) return 'image/png'
      offset += size + 12
    }
    throw new Error(corrupt)
  }
  if (data.length >= 12 && chunkName(data, 0) === 'RIFF' && chunkName(data, 8) === 'WEBP') {
    const end = view.getUint32(4, true) + 8
    if (end !== data.length) throw new Error(corrupt)
    let offset = 12
    let pixels = false
    while (offset + 8 <= end) {
      const size = view.getUint32(offset + 4, true)
      const kind = chunkName(data, offset)
      if (offset + 8 + size > end) throw new Error(corrupt)
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && size > 0 && (data[offset + 8] & 2))) throw new Error(animated)
      const payload = offset + 8
      if (kind === 'VP8X') {
        if (size !== 10) throw new Error(corrupt)
        const uint24 = (at: number) => data[at] + data[at + 1] * 256 + data[at + 2] * 65536 + 1
        checkDimensions(uint24(payload + 4), uint24(payload + 7))
      }
      if (kind === 'VP8 ') {
        if (size < 10) throw new Error(corrupt)
        checkDimensions(view.getUint16(payload + 6, true) & 0x3fff, view.getUint16(payload + 8, true) & 0x3fff)
      }
      if (kind === 'VP8L') {
        if (size < 5) throw new Error(corrupt)
        const bits = view.getUint32(payload + 1, true)
        checkDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
      }
      if (kind === 'VP8 ' || kind === 'VP8L') pixels = true
      offset += 8 + size + (size % 2)
    }
    if (!pixels || offset !== end) throw new Error(corrupt)
    return 'image/webp'
  }
  throw new Error(unsupported)
}

function readFile(file: File): Promise<ArrayBuffer> {
  if (file.arrayBuffer) return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(new Error(corrupt))
    reader.readAsArrayBuffer(file)
  })
}

async function dimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  }
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = () => reject(new Error(corrupt))
      image.src = url
    })
  } finally { URL.revokeObjectURL(url) }
}

export async function validateFeedbackImage(file: File): Promise<void> {
  if (file.size > FEEDBACK_IMAGE_BYTES) throw new Error('每张图片最多 5 MB。')
  if (!file.size) throw new Error(corrupt)
  const bytes = new Uint8Array(await readFile(file))
  const mime = feedbackImageType(bytes)
  let size: { width: number; height: number }
  try { size = await dimensions(new Blob([bytes], { type: mime })) }
  catch { throw new Error(corrupt) }
  checkDimensions(size.width, size.height)
}
