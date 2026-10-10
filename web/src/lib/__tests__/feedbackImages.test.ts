import { describe, expect, it } from 'vitest'
import { feedbackImageType } from '../feedbackImages'

const png = () => Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=='), character => character.charCodeAt(0))
function webp(chunk: string, body: number[]) {
  const data = new Uint8Array(20 + body.length + (body.length % 2))
  const view = new DataView(data.buffer)
  data.set(Array.from('RIFF', c => c.charCodeAt(0)))
  view.setUint32(4, data.length - 8, true)
  data.set(Array.from('WEBP' + chunk, c => c.charCodeAt(0)), 8)
  view.setUint32(16, body.length, true)
  data.set(body, 20)
  return data
}

describe('反馈图片容器与解码前边界', () => {
  it('识别 PNG 和静态 WebP，而 GIF、SVG、损坏容器与动画被拒绝', () => {
    expect(feedbackImageType(png())).toBe('image/png')
    expect(feedbackImageType(webp('VP8L', [47, 0, 0, 0, 0]))).toBe('image/webp')
    for (const text of ['GIF89a', '<svg></svg>']) expect(() => feedbackImageType(new TextEncoder().encode(text))).toThrow('仅支持静态')
    expect(() => feedbackImageType(png().slice(0, 36))).toThrow('图片损坏')
    expect(() => feedbackImageType(webp('VP8X', [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow('动图')
    expect(() => feedbackImageType(webp('ANIM', [0, 0]))).toThrow('动图')
  })

  it('PNG、JPEG 和 WebP 在调用原生解码器前即拒绝过大尺寸', () => {
    const data = png()
    new DataView(data.buffer).setUint32(16, 8193)
    expect(() => feedbackImageType(data)).toThrow('8192')
    const tooManyPixels = png()
    const view = new DataView(tooManyPixels.buffer)
    view.setUint32(16, 5000); view.setUint32(20, 5000)
    expect(() => feedbackImageType(tooManyPixels)).toThrow('2000 万')
    const jpeg = new Uint8Array([255, 216, 255, 192, 0, 7, 8, 0, 1, 32, 1, 255, 217])
    expect(() => feedbackImageType(jpeg)).toThrow('8192')
    expect(() => feedbackImageType(webp('VP8X', [0, 0, 0, 0, 0, 32, 0, 0, 0, 0]))).toThrow('8192')
  })
})
