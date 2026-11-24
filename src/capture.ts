import type { Context } from 'cordis'
import type { h, Session } from '@satorijs/core'
import type {} from '@cordisjs/plugin-http'
import type {} from '@chatluna/chat'
import { Schema } from '@chatluna/schema'
import type {} from '@chatluna/ui-schema-registry'
import { httpFetch } from '@chatluna/utils'
import type { BatchRunner } from './batch'
import type { Config } from './index'
import { MIB, type StickerStore } from './store'

const IMAGE_TYPES: Record<string, true> = { img: true, image: true, mface: true, sticker: true }
const DOWNLOAD_TIMEOUT = 15_000
/** One sighting per sender, image and conversation: other bots in the same channel see the same message. */
const SIGHTING_WINDOW = 60_000

export const STICKER_ROUTE_SCHEMA = Schema.object({
  collect: Schema.union([
    Schema.const('sticker').description('仅表情'),
    Schema.const('all').description('所有图片'),
    Schema.const('off').description('不收集')
  ])
    .default('sticker')
    .label('收集范围')
    .description('在匹配的会话中收集哪些图片：只收集平台标记为表情的图片、所有图片，或不收集。')
})

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
 * Whether and what to collect comes from the `sticker` routing namespace; the same sighting seen by several bots counts
 * once.
 */
export function applyCapture(ctx: Context, config: Config, store: StickerStore, runner: BatchRunner) {
  const maxBytes = config.maxFileSize * MIB

  ctx.inject(['schemas'], (ctx) => {
    ctx.schemas.section({
      surface: 'routing',
      key: 'sticker',
      id: 'sticker',
      title: '表情包',
      tab: 'rules.plugins',
      schema: STICKER_ROUTE_SCHEMA,
      applies: 'live',
      plugin: 'chatluna-plugin-sticker-helper'
    })
  })

  const sightings = new Map<string, number>()
  /** Insertion order is time order: stale keys are dropped before a re-insert, so the sweep stops at the first fresh one. */
  const firstSighting = (key: string): boolean => {
    const now = Date.now()
    for (const [stale, at] of sightings) {
      if (at > now - SIGHTING_WINDOW) break
      sightings.delete(stale)
    }
    if (sightings.has(key)) return false
    sightings.set(key, now)
    return true
  }

  const capture = async (session: Session) => {
    if (ctx.get('satori')?.bots.some((bot) => bot.platform === session.platform && bot.selfId === session.userId)) {
      return
    }
    const elements = (session.elements ?? []).filter((element) => IMAGE_TYPES[element.type] === true)
    if (elements.length === 0) return
    const binding = ctx.chat.binding(session)
    const presetId = binding.preset.preset
    if (presetId === undefined || presetId === '') {
      ctx.logger.debug('skipped images from %s: the conversation has no preset', session.channelId)
      return
    }
    const { collect } = STICKER_ROUTE_SCHEMA.parse(structuredClone(binding.resolution.values['sticker'] ?? {}))
    if (collect === 'off') return
    // Only top-level elements: stickers inside a quote were counted when first sent.
    for (const element of elements) {
      // Same test as @chatluna/transform's stickerNameOf; Satori camelizes `sub_type` to `subType`.
      const marked =
        element.type === 'mface' || element.type === 'sticker' || [1, '1', 'sticker'].includes(element.attrs['subType'])
      if (collect === 'sticker' && !marked) continue
      const src = stringAttr(element, 'src') ?? stringAttr(element, 'url')
      if (src === undefined) continue
      const bytes = await downloadImage(ctx, src, maxBytes)
      if (bytes === undefined) continue
      const summary = stringAttr(element, 'summary') ?? stringAttr(element, 'name') ?? ''
      const becamePending = await store.ingest(bytes, { marked, summary }, async (hash) => {
        const key = `${presetId}\0${session.platform}\0${session.channelId}\0${session.userId}\0${hash}`
        if (!firstSighting(key)) return false
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
