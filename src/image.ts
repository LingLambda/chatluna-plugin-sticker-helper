/** Photon's node entry inlines its wasm, so no native build or worker is needed; stickers are small and batches rare. */
import { draw_text, PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon/node'
import { imageSize } from 'image-size'
import { GifReader } from 'omggif'

/** 4096×4096: decoding allocates 4 bytes per pixel, so larger headers are refused before Photon touches them. */
const MAX_PIXELS = 16_777_216
const THUMB_SIDE = 160
const CELL = 384
const GAP = 8
/** Rows of frames in one animated sticker's block. */
const FRAME_ROWS = 2
/** Between animated stickers' blocks, so each block's frames read as one sticker. */
const BLOCK_GAP = 40
/** Photon draws white Roboto; on a dark badge the digit stays legible over any sticker. */
const LABEL_SIZE = 40
const BADGE_WIDTH = 44
const BADGE_HEIGHT = 52
const BADGE_SHADE = 32

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

export interface ImageInfo {
  ext: string
  mediaType: string
  width: number
  height: number
}

/** Format and size from the header; undefined for unsupported formats, oversized files and oversized dimensions. */
export function probe(bytes: Uint8Array, maxBytes: number): ImageInfo | undefined {
  if (bytes.length === 0 || bytes.length > maxBytes) return undefined
  try {
    const header = imageSize(bytes)
    const ext = header.type
    const mediaType = ext === undefined ? undefined : MEDIA_TYPES[ext]
    if (ext === undefined || mediaType === undefined) return undefined
    if (header.width * header.height > MAX_PIXELS) return undefined
    return { ext, mediaType, width: header.width, height: header.height }
  } catch {
    // image-size throws on formats it cannot read.
    return undefined
  }
}

/** Long side at most 160, first frame of a GIF, transparency over white, JPEG. */
export function thumbnail(bytes: Uint8Array): Uint8Array {
  const pixels = decodeFitted(bytes, THUMB_SIDE)
  const sheet = new Uint8Array(pixels.width * pixels.height * 4).fill(255)
  draw(pixels, sheet, pixels.width, 0, 0)
  const image = new PhotonImage(sheet, pixels.width, pixels.height)
  try {
    return image.get_bytes_jpeg(80)
  } finally {
    image.free()
  }
}

/** Thrown by {@link grid} when one image cannot be decoded, so the caller can drop it and rebuild. */
export class GridImageError extends Error {
  constructor(
    readonly index: number,
    cause: unknown
  ) {
    super(`image ${index + 1} unreadable: ${String(cause)}`)
  }
}

/** GIF magic: `GIF8`. */
function isGif(bytes: Uint8Array): boolean {
  return bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
}

/** Frames in the file: 1 for anything but a GIF, and for a GIF omggif cannot parse. */
export function frameCount(bytes: Uint8Array): number {
  if (!isGif(bytes)) return 1
  try {
    return Math.max(1, new GifReader(bytes).numFrames())
  } catch {
    return 1
  }
}

/**
 * Static stickers in reading order on 384px cells with 8px white gutters, each scaled to fill its cell and numbered
 * from 1 on a dark badge in its top-left corner.
 */
export function grid(images: readonly Uint8Array[], columns: number): Uint8Array {
  const cells = images.map((bytes, index) => {
    try {
      // Small stickers are enlarged so the model sees them at the cell's full size.
      return [decodeFitted(bytes, CELL, true)]
    } catch (error) {
      throw new GridImageError(index, error)
    }
  })
  return compose(cells, { cell: CELL, perRow: columns, blockColumns: 1, blockRows: 1, blockGap: GAP })
}

/**
 * Animated stickers stacked top to bottom, each a block of `frames` evenly spaced frames (first and last included) on 2
 * rows, read left to right then top to bottom in time order, numbered from 1 on the block's first cell. A GIF with
 * fewer frames fills its block in order and leaves the rest blank. Cells shrink below 384px when the sheet would
 * otherwise exceed `maxSide` on either side.
 */
export function animatedGrid(images: readonly Uint8Array[], frames: number, maxSide: number): Uint8Array {
  const columns = Math.ceil(frames / FRAME_ROWS)
  const blocks = images.length
  const cell = Math.min(
    CELL,
    Math.floor((maxSide - (columns + 1) * GAP) / columns),
    Math.floor((maxSide - 2 * GAP - blocks * (FRAME_ROWS - 1) * GAP - (blocks - 1) * BLOCK_GAP) / (blocks * FRAME_ROWS))
  )
  const groups = images.map((bytes, index) => {
    try {
      return sampleFrames(bytes, frames, cell)
    } catch (error) {
      throw new GridImageError(index, error)
    }
  })
  return compose(groups, { cell, perRow: 1, blockColumns: columns, blockRows: FRAME_ROWS, blockGap: BLOCK_GAP })
}

interface Pixels {
  data: Uint8Array
  width: number
  height: number
}

/**
 * Lays sticker groups out on a white sheet. Each group is a block of `blockColumns` × `blockRows` cells filled in
 * reading order, its first cell carrying the group's number badge; blocks sit `perRow` to a row, `blockGap` apart
 * vertically. A static grid is 1×1 blocks several to a row; an animated sheet is one frame block per row.
 */
function compose(
  groups: readonly Pixels[][],
  layout: { cell: number; perRow: number; blockColumns: number; blockRows: number; blockGap: number }
): Uint8Array {
  const { cell, perRow, blockColumns, blockRows, blockGap } = layout
  const blockWidth = blockColumns * cell + (blockColumns - 1) * GAP
  const blockHeight = blockRows * cell + (blockRows - 1) * GAP
  const lines = Math.ceil(groups.length / perRow)
  const width = perRow * blockWidth + (perRow + 1) * GAP
  const height = lines * blockHeight + (lines - 1) * blockGap + 2 * GAP
  const sheet = new Uint8Array(width * height * 4).fill(255)
  const badges: { x: number; y: number }[] = []
  groups.forEach((group, index) => {
    const x = GAP + (index % perRow) * (blockWidth + GAP)
    const y = GAP + Math.floor(index / perRow) * (blockHeight + blockGap)
    group.forEach((pixels, slot) => {
      const left = x + (slot % blockColumns) * (cell + GAP) + Math.floor((cell - pixels.width) / 2)
      const top = y + Math.floor(slot / blockColumns) * (cell + GAP) + Math.floor((cell - pixels.height) / 2)
      draw(pixels, sheet, width, left, top)
    })
    badges.push({ x, y })
    for (let row = y; row < y + BADGE_HEIGHT; row++) {
      for (let column = x; column < x + BADGE_WIDTH; column++) {
        const at = (row * width + column) * 4
        sheet[at] = sheet[at + 1] = sheet[at + 2] = BADGE_SHADE
      }
    }
  })
  const image = new PhotonImage(sheet, width, height)
  try {
    badges.forEach(({ x, y }, index) => draw_text(image, String(index + 1), x + 8, y + 6, LABEL_SIZE))
    return image.get_bytes_jpeg(85)
  } finally {
    image.free()
  }
}

/**
 * `count` evenly spaced frames of a GIF, composited the way a viewer shows them (disposal 2 clears the frame's area, 3
 * restores what was under it), each scaled to fit `side` as it is picked. Anything else, or a single-frame GIF, yields
 * its one frame.
 */
function sampleFrames(bytes: Uint8Array, count: number, side: number): Pixels[] {
  const total = frameCount(bytes)
  if (total < 2) return [decodeFitted(bytes, side, true)]
  const reader = new GifReader(bytes)
  const { width, height } = reader
  const sampled = Math.min(count, total)
  const picked = Array.from({ length: sampled }, (_, slot) => Math.round((slot * (total - 1)) / (sampled - 1)))
  const canvas = new Uint8Array(width * height * 4)
  let saved: Uint8Array | undefined
  const frames: Pixels[] = []
  for (let index = 0, slot = 0; slot < sampled; index++) {
    const frame = reader.frameInfo(index)
    if (frame.disposal === 3) {
      saved ??= new Uint8Array(canvas.length)
      saved.set(canvas)
    }
    reader.decodeAndBlitFrameRGBA(index, canvas)
    if (index === picked[slot]) {
      // PhotonImage copies the canvas into wasm memory, so the canvas stays free to draw on.
      frames.push(fitPixels({ data: canvas, width, height }, side))
      slot++
    }
    if (frame.disposal === 2) {
      for (let y = frame.y; y < Math.min(height, frame.y + frame.height); y++) {
        canvas.fill(0, (y * width + frame.x) * 4, (y * width + Math.min(width, frame.x + frame.width)) * 4)
      }
    } else if (frame.disposal === 3 && saved !== undefined) canvas.set(saved)
  }
  return frames
}

/** RGBA of the first frame, scaled so the long side fits `side`; enlarged only with `upscale`. */
function decodeFitted(bytes: Uint8Array, side: number, upscale = false): Pixels {
  const image = PhotonImage.new_from_byteslice(bytes)
  try {
    return scaled(image, side, upscale)
  } finally {
    image.free()
  }
}

/** Raw RGBA scaled so the long side fits `side`, small frames enlarged. */
function fitPixels(pixels: Pixels, side: number): Pixels {
  const image = new PhotonImage(pixels.data, pixels.width, pixels.height)
  try {
    return scaled(image, side, true)
  } finally {
    image.free()
  }
}

function scaled(image: PhotonImage, side: number, upscale: boolean): Pixels {
  const width = image.get_width()
  const height = image.get_height()
  const fit = side / Math.max(width, height)
  const scale = upscale ? fit : Math.min(1, fit)
  if (scale === 1) return { data: image.get_raw_pixels(), width, height }
  const resized = resize(
    image,
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
    SamplingFilter.Lanczos3
  )
  try {
    return { data: resized.get_raw_pixels(), width: resized.get_width(), height: resized.get_height() }
  } finally {
    resized.free()
  }
}

/** Copy RGBA pixels onto the white sheet at (left, top), blending transparency onto white since JPEG has no alpha. */
function draw(pixels: Pixels, sheet: Uint8Array, stride: number, left: number, top: number) {
  const { data, width, height } = pixels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      const to = ((top + y) * stride + left + x) * 4
      const alpha = data[from + 3]! / 255
      for (let channel = 0; channel < 3; channel++) {
        sheet[to + channel] = Math.round(data[from + channel]! * alpha + 255 * (1 - alpha))
      }
    }
  }
}
