import type { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import type {} from '@chatluna/ai-runtime/ops'
import type {} from '@chatluna/core'
import type {} from '@chatluna/preset'
import type { Config } from './index'
import { animatedGrid, grid, GridImageError } from './image'
import type { CatalogItem, StickerStore } from './store'
import type { StickerEntryRow } from './types'

const GRID_RESULT = Schema.object({
  stickers: Schema.array(
    Schema.object({
      index: Schema.natural().required(),
      title: Schema.string().required(),
      description: Schema.string().required(),
      scenes: Schema.string().required(),
      fit: Schema.boolean().required(),
      reason: Schema.string().required()
    })
  ).required()
})

interface GridSticker {
  index: number
  title: string
  description: string
  scenes: string
  fit: boolean
  reason: string
}

const NO_PERSONA = '(no persona text; mark every sticker fit)'

const STILL_LAYOUT = (count: number) =>
  `The image is a grid of ${count} stickers numbered 1 to ${count} in reading order (left to right, top to bottom); each cell's number is drawn in its top-left corner.`

const ANIMATED_LAYOUT = (count: number, frames: number) => {
  const block = `up to ${frames} frames sampled evenly from the animation on ${frames / 2} columns × 2 rows, in time order left to right along the top row, then left to right along the bottom row`
  const layout =
    count === 1
      ? `The image is one animated sticker (GIF), numbered 1 on the dark badge in its top-left corner, shown as ${block}.`
      : `The image holds ${count} animated stickers (GIFs) as blocks stacked top to bottom, separated by wide white gaps and numbered 1 to ${count} on the dark badge in each block's top-left corner. Each block shows ${block}.`
  return `${layout} Read the frames as one moving sticker and describe the motion and how it changes, not a single frame.`
}

function systemPrompt(layout: string, persona: string): string {
  return `You catalog chat stickers for a chat persona. ${layout}
For every sticker return:
- index: its number.
- title: at most 8 Chinese characters naming the sticker's core content (subject + action, emotion or caption), e.g. 小猪说天气真好, 害怕, 丛雨难过.
- description: a detailed description — who or what is shown, expression, action, any caption text quoted verbatim, art style.
- scenes: the chat situations where sending it fits.
- fit: whether this persona would plausibly send this sticker, judged by its personality, tone and identity.
- reason: one sentence explaining fit.
Write title, description, scenes and reason in Chinese.

Persona:
<persona>
${persona === '' ? NO_PERSONA : persona}
</persona>`
}

type RunOptions = { full: boolean; presetId?: string | undefined }

/**
 * Catalogs pending stickers a grid at a time. One run at a time: a trigger during a run is queued, merged with any
 * other queued trigger, and runs once the current run ends, since the current run fixed its presets when it started.
 */
export class BatchRunner {
  private current: Promise<void> | undefined
  private queued: RunOptions | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly store: StickerStore
  ) {}

  get running(): boolean {
    return this.current !== undefined
  }

  /**
   * `full` processes complete grids only; otherwise every pending sticker, the last grid possibly short. Resolves when
   * the run in progress ends.
   */
  run(options: RunOptions): Promise<void> {
    if (this.current !== undefined) {
      const queued = this.queued
      this.queued =
        queued === undefined
          ? { ...options }
          : {
              full: queued.full && options.full,
              presetId: queued.presetId === options.presetId ? options.presetId : undefined
            }
      return this.current
    }
    this.current = this.execute(options)
      .catch((error) => this.ctx.logger.warn('sticker batch failed: %s', error))
      .finally(() => {
        this.current = undefined
        const next = this.queued
        this.queued = undefined
        if (next === undefined) this.store.changed()
        else void this.run(next)
      })
    this.store.changed()
    return this.current
  }

  private async execute(options: RunOptions) {
    const presetIds = options.presetId === undefined ? await this.store.presetIdsWithPending() : [options.presetId]
    for (const presetId of presetIds) {
      const persona = this.persona(presetId)
      if (persona === undefined) {
        this.ctx.logger.warn('preset %s not found, stickers stay pending', presetId)
        continue
      }
      // Still stickers and animated ones (one frame strip per row) never share a sheet.
      for (const animated of [false, true]) {
        const size = animated ? this.config.gifPerGrid : this.config.gridSize
        // Entries a failed grid sends back go behind the rest; the budget stops this run from taking them again.
        const counts = await this.store.pendingCounts(presetId)
        let budget = animated ? counts.animated : counts.still
        while (budget > 0) {
          const batch = await this.store.takePending(presetId, animated, size, options.full)
          if (batch.length === 0) break
          try {
            await this.processGrid(presetId, persona, batch, animated)
          } catch (error) {
            this.ctx.logger.warn('sticker grid of preset %s failed: %s', presetId, error)
            await this.store.retry(
              presetId,
              batch.map((entry) => entry.hash),
              String(error)
            )
          }
          budget -= batch.length
        }
      }
    }
  }

  /** Whether a preset has a full sheet of either kind waiting, which starts a run at once. */
  async gridReady(presetId: string): Promise<boolean> {
    const counts = await this.store.pendingCounts(presetId)
    return counts.still >= this.config.gridSize || counts.animated >= this.config.gifPerGrid
  }

  /** The preset's system text, the persona the stickers are judged against; undefined when the preset is gone. */
  private persona(presetId: string): string | undefined {
    const record = this.ctx.presets.get(presetId)
    if (record === undefined) return undefined
    return (this.ctx.presets.blocks(record) ?? [])
      .filter(
        (block) =>
          block.zone === 'system' &&
          (block.role === undefined || block.role === 'system') &&
          typeof block.content === 'string'
      )
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map((block) => String(block.content).trim())
      .filter((text) => text !== '')
      .join('\n\n')
  }

  private async processGrid(presetId: string, persona: string, entries: readonly StickerEntryRow[], animated: boolean) {
    const unreadable: string[] = []
    let cells: { entry: StickerEntryRow; bytes: Uint8Array }[] = []
    for (const entry of entries) {
      const file = await this.store.readFile(entry.hash)
      if (file === undefined) unreadable.push(entry.hash)
      else cells.push({ entry, bytes: file.bytes })
    }
    const columns = this.config.gridSize === 9 ? 3 : 2
    let sheet: Uint8Array | undefined
    while (cells.length > 0 && sheet === undefined) {
      try {
        const images = cells.map((cell) => cell.bytes)
        sheet = animated ? animatedGrid(images, this.config.gifFrames, this.config.gifSheetSize) : grid(images, columns)
      } catch (error) {
        if (!(error instanceof GridImageError)) throw error
        unreadable.push(cells[error.index]!.entry.hash)
        cells = cells.filter((_, index) => index !== error.index)
      }
    }
    await this.store.fail(presetId, unreadable, 'image unreadable')
    if (sheet === undefined) return

    const hashes = cells.map((cell) => cell.entry.hash)
    const count = cells.length
    const prompt = `Catalog all ${count} stickers in the image.`
    let stickers: GridSticker[]
    try {
      const result = await this.ctx.chatluna.extract(GRID_RESULT, {
        model: this.config.model,
        system: systemPrompt(animated ? ANIMATED_LAYOUT(count, this.config.gifFrames) : STILL_LAYOUT(count), persona),
        prompt,
        content: [
          { type: 'text', text: prompt },
          { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: Buffer.from(sheet).toString('base64') } }
        ]
      })
      stickers = result.stickers
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn('sticker grid of preset %s failed: %s', presetId, reason)
      await this.store.retry(presetId, hashes, reason)
      return
    }

    const items: CatalogItem[] = []
    const missing: string[] = []
    hashes.forEach((hash, slot) => {
      // The first answer for a number wins; numbers outside 1..n are ignored.
      const sticker = stickers.find((item) => item.index === slot + 1)
      if (sticker === undefined) missing.push(hash)
      else items.push({ hash, ...sticker })
    })
    if (items.length > 0) await this.store.catalog(presetId, items)
    if (missing.length > 0) await this.store.retry(presetId, missing, 'missing from model output')
  }
}
