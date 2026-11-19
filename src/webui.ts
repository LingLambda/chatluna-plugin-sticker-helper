import type { Context } from 'cordis'
import Schema from 'schemastery'
import { zipSync } from 'fflate'
import { ApiError } from '@chatluna/server'
import { requireActionLevel } from '@chatluna/ui-server'
import type {} from '@chatluna/permission'
import type {} from '@chatluna/preset'
import type { BatchRunner } from './batch'
import type { Config } from './index'
import type { StickerStore } from './store'
import {
  STICKER_STATUSES,
  type StickerEntriesParams,
  type StickerPresetView,
  type StickerStatus,
  type StickerView
} from './types'

const MAX_DOWNLOAD = 100 * 1024 * 1024
const HASHES = Schema.array(Schema.string()).min(1)

const EMPTY_COUNTS: Readonly<Record<StickerStatus, number>> = {
  collecting: 0,
  pending: 0,
  processing: 0,
  fit: 0,
  unfit: 0,
  failed: 0
}

function today(): string {
  const date = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

export function applyWebUI(ctx: Context, config: Config, store: StickerStore, runner: BatchRunner) {
  ctx.chatluna_webui.addEntry({ baseUrl: import.meta.url, source: '../client/index.ts', bundle: '../dist/client.js' })
  const refreshOn = ['sticker-helper/change']

  ctx.chatluna_webui.state('sticker.presets', {
    get: async () => {
      const presets = new Map<string, StickerPresetView>()
      for (const record of ctx.presets.list()) {
        presets.set(record.id, { id: record.id, name: record.name, missing: false, counts: { ...EMPTY_COUNTS } })
      }
      for (const row of await store.statusRows()) {
        let view = presets.get(row.presetId)
        if (view === undefined) {
          view = { id: row.presetId, name: row.presetId, missing: true, counts: { ...EMPTY_COUNTS } }
          presets.set(row.presetId, view)
        }
        view.counts[row.status] += 1
      }
      return {
        presets: [...presets.values()],
        running: runner.running,
        mode: config.mode,
        gridSize: config.gridSize,
        threshold: config.threshold
      }
    },
    refreshOn: [...refreshOn, 'presets/change']
  })

  ctx.chatluna_webui.state('sticker.entries', {
    params: Schema.object({
      presetId: Schema.string().required(),
      status: Schema.union([...STICKER_STATUSES, 'all'] as const).default('all'),
      query: Schema.string().default(''),
      offset: Schema.natural().default(0),
      limit: Schema.natural().max(200).default(60)
    }),
    get: async (params: StickerEntriesParams) => {
      const query = (params.query ?? '').trim().toLowerCase()
      const rows = (await store.list(params.presetId, params.status ?? 'all')).filter(
        (row) =>
          query === '' || row.title.toLowerCase().includes(query) || row.description.toLowerCase().includes(query)
      )
      const offset = params.offset ?? 0
      const page = rows.slice(offset, offset + (params.limit ?? 60))
      const items: StickerView[] = []
      for (const row of page) {
        items.push({
          hash: row.hash,
          status: row.status,
          count: row.count,
          title: row.title,
          description: row.description,
          scenes: row.scenes,
          reason: row.reason,
          source: row.source,
          marked: row.image?.marked ?? false,
          summary: row.image?.summary ?? '',
          mediaType: row.image?.mediaType ?? '',
          thumb: await store.thumbUri(row.hash),
          updatedAt: row.updatedAt
        })
      }
      return { total: rows.length, items }
    },
    refreshOn
  })

  ctx.chatluna_webui.action(
    'sticker.image',
    { input: Schema.object({ hash: Schema.string().required() }) },
    async ({ hash }) => {
      const dataUri = await store.dataUri(hash)
      if (dataUri === undefined) throw new ApiError('NOT_FOUND', `image ${hash} not found`)
      return { dataUri }
    }
  )

  ctx.chatluna_webui.action(
    'sticker.upload',
    {
      input: Schema.object({
        presetId: Schema.string().required(),
        files: Schema.array(Schema.object({ name: Schema.string().required(), content: Schema.string().required() }))
          .min(1)
          .max(50)
          .required()
      })
    },
    async ({ presetId, files }, action) => {
      await requireActionLevel(ctx, action, 4)
      let added = 0
      let skipped = 0
      for (const file of files) {
        const recorded = await store.ingest(Buffer.from(file.content, 'base64'), { marked: true, summary: '' }, (hash) =>
          store.record(presetId, hash, 'uploaded')
        )
        if (recorded === undefined) {
          skipped++
          continue
        }
        added++
      }
      if (await runner.gridReady(presetId)) void runner.run({ full: true, presetId })
      return { added, skipped }
    }
  )

  ctx.chatluna_webui.action(
    'sticker.update',
    {
      input: Schema.object({
        presetId: Schema.string().required(),
        hash: Schema.string().required(),
        title: Schema.string(),
        description: Schema.string(),
        scenes: Schema.string(),
        status: Schema.union(['fit', 'unfit'] as const)
      })
    },
    async ({ presetId, hash, ...patch }, action) => {
      await requireActionLevel(ctx, action, 4)
      if (patch.title !== undefined && patch.title.trim() === '') {
        throw new ApiError('INVALID_ARGUMENT', 'title cannot be empty')
      }
      const outcome = await store.update(presetId, hash, patch)
      if (outcome === 'missing') throw new ApiError('NOT_FOUND', `sticker ${hash} not found in preset ${presetId}`)
      if (outcome === 'conflict') throw new ApiError('CONFLICT', `title already used: ${patch.title?.trim()}`)
    }
  )

  ctx.chatluna_webui.action(
    'sticker.delete',
    { input: Schema.object({ presetId: Schema.string().required(), hashes: HASHES.required() }) },
    async ({ presetId, hashes }, action) => {
      await requireActionLevel(ctx, action, 4)
      await store.remove(presetId, hashes)
    }
  )

  ctx.chatluna_webui.action(
    'sticker.copy',
    {
      input: Schema.object({
        from: Schema.string().required(),
        to: Schema.string().required(),
        hashes: HASHES.required()
      })
    },
    async ({ from, to, hashes }, action) => {
      await requireActionLevel(ctx, action, 4)
      if (from === to) throw new ApiError('INVALID_ARGUMENT', 'source and target preset are the same')
      let queued = 0
      let skipped = 0
      for (const hash of await store.hasEntries(from, hashes)) {
        const recorded = await store.withImage(hash, () => store.record(to, hash, 'copied'))
        if (recorded?.becamePending === true) queued++
        else skipped++
      }
      skipped += hashes.length - queued - skipped
      return { queued, skipped }
    }
  )

  ctx.chatluna_webui.action(
    'sticker.requeue',
    { input: Schema.object({ presetId: Schema.string().required(), hashes: HASHES.required() }) },
    async ({ presetId, hashes }, action) => {
      await requireActionLevel(ctx, action, 4)
      await store.requeue(presetId, hashes)
    }
  )

  ctx.chatluna_webui.action(
    'sticker.run',
    { input: Schema.object({ presetId: Schema.string() }) },
    async ({ presetId }, action) => {
      await requireActionLevel(ctx, action, 4)
      const started = !runner.running
      void runner.run({ full: false, presetId })
      return { started }
    }
  )

  ctx.chatluna_webui.action(
    'sticker.download',
    { input: Schema.object({ presetId: Schema.string().required(), hashes: Schema.array(Schema.string()) }) },
    async ({ presetId, hashes }, action) => {
      await requireActionLevel(ctx, action, 4)
      const wanted = hashes === undefined || hashes.length === 0 ? undefined : new Set(hashes)
      const rows = (await store.list(presetId)).filter((row) => wanted === undefined || wanted.has(row.hash))
      if (rows.length === 0) throw new ApiError('NOT_FOUND', 'no stickers to download')
      const total = rows.reduce((sum, row) => sum + (row.image?.size ?? 0), 0)
      if (total > MAX_DOWNLOAD) throw new ApiError('INVALID_ARGUMENT', 'selection too large')
      const files: Record<string, Uint8Array> = {}
      const manifest: Record<string, string>[] = []
      for (const row of rows) {
        const file = await store.readFile(row.hash)
        if (file === undefined) continue
        const name = `${(row.title || row.hash.slice(0, 12)).replace(/[\\/:*?"<>|]/g, '_')}.${file.ext}`
        files[name] = file.bytes
        manifest.push({
          file: name,
          hash: row.hash,
          title: row.title,
          description: row.description,
          scenes: row.scenes,
          status: row.status,
          reason: row.reason
        })
      }
      files['stickers.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2))
      const zip = zipSync(files, { level: 0 })
      return { filename: `stickers-${presetId}-${today()}.zip`, data: Buffer.from(zip).toString('base64') }
    }
  )
}
