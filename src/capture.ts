import type { Context } from 'cordis'
import type { h, Session } from '@satorijs/core'
import type {} from '@cordisjs/plugin-http'
import type {} from '@chatluna/chat'
import { httpFetch } from '@chatluna/utils'
import type { BatchRunner } from './batch'
import type { Config } from './index'
import { MIB, type StickerStore } from './store'

const IMAGE_TYPES: Record<string, true> = { img: true, image: true, mface: true, sticker: true }
const DOWNLOAD_TIMEOUT = 15_000

function stringAttr(element: h, key: string): string | undefined {
  const value: unknown = element.attrs[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The bytes behind an image source: an inline base64 data URI, or an http(s) URL fetched once with a 15 s timeout and
 * cut off past `maxBytes`. Undefined for other schemes, HTTP errors and failed or oversized downloads.
 */
export async function downloadImage(ctx: Context, src: string, maxBytes: number): Promise<Buffer | undefined> {
  const inline = /^data:[^,]*;base64,/i.exec(src)
  if (inline) return Buffer.from(src.slice(inline[0].length), 'base64')
  if (!/^https?:\/\//i.test(src)) {
    ctx.logger.debug('skipped image with unsupported source %s', src.slice(0, 64))
    return undefined
  }
  try {
    const response = await httpFetch(ctx.http)(src, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) })
    if (!response.ok) {
      ctx.logger.debug('image download answered HTTP %d', response.status)
      return undefined
    }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) return undefined
    // Content-Length can be absent or wrong, so the cap is enforced while reading; leaving the loop cancels the body.
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength
      if (size > maxBytes) return undefined
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } catch (error) {
    ctx.logger.debug('image download failed: %s', error)
    return undefined
  }
}

/**
 * Collects images from raw platform messages, including group messages that never wake the bot. The observer's copy of
 * a message is already transformed and has lost the sticker attributes, so this listens to `message` itself.
 */
export function applyCapture(ctx: Context, config: Config, store: StickerStore, runner: BatchRunner) {
  const maxBytes = config.maxFileSize * MIB

  const capture = async (session: Session) => {
    if (session.userId === session.selfId) return
    const elements = (session.elements ?? []).filter((element) => IMAGE_TYPES[element.type] === true)
    if (elements.length === 0) return
    const presetId = ctx.chat.binding(session).preset.preset
    if (presetId === undefined || presetId === '') {
      ctx.logger.debug('skipped images from %s: the conversation has no preset', session.channelId)
      return
    }
    const seen = new Set<string>()
    // Only top-level elements: stickers inside a quote were counted when first sent.
    for (const element of elements) {
      // Same test as @chatluna/transform's stickerNameOf; Satori camelizes `sub_type` to `subType`.
      const marked =
        element.type === 'mface' || element.type === 'sticker' || [1, '1', 'sticker'].includes(element.attrs['subType'])
      if (config.collect === 'sticker' && !marked) continue
      const src = stringAttr(element, 'src') ?? stringAttr(element, 'url')
      if (src === undefined) continue
      const bytes = await downloadImage(ctx, src, maxBytes)
      if (bytes === undefined) continue
      const summary = stringAttr(element, 'summary') ?? stringAttr(element, 'name') ?? ''
      const becamePending = await store.ingest(bytes, { marked, summary }, async (hash) => {
        if (seen.has(hash)) return false
        seen.add(hash)
        return (await store.record(presetId, hash, 'collected')).becamePending
      })
      if (becamePending === true && (await runner.gridReady(presetId))) {
        void runner.run({ full: true })
      }
    }
  }

  ctx.on('message', (session) => {
    void capture(session).catch((error) => ctx.logger.warn('capture failed: %s', error))
  })
}
