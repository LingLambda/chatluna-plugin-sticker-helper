import type {} from '@cordisjs/plugin-database'
import type {} from '@chatluna/ui-client/client'

export const STICKER_STATUSES = ['collecting', 'pending', 'processing', 'fit', 'unfit', 'failed'] as const

export type StickerStatus = (typeof STICKER_STATUSES)[number]

/** `saved`: the model added it itself with `sticker_save`. */
export type StickerSource = 'collected' | 'uploaded' | 'copied' | 'saved'

export type StickerMode = 'inject' | 'search'

/** One image file, shared by every preset that has seen it. */
export interface StickerImageRow {
  hash: string
  ext: string
  mediaType: string
  size: number
  width: number
  height: number
  /** True once any occurrence was flagged as a sticker by the platform. */
  marked: boolean
  summary: string
  createdAt: number
  /** Frames in the file (GIF); 0 until counted. */
  frames: number
}

/** One image as one preset knows it: its own count, status and catalog text. */
export interface StickerEntryRow {
  presetId: string
  hash: string
  status: StickerStatus
  /** Messages in this preset's conversations that carried the image. */
  count: number
  /** Failed batch runs; the third failure marks the entry failed. */
  attempts: number
  title: string
  description: string
  scenes: string
  /** Why the model judged it fit or unfit, or why processing failed. */
  reason: string
  source: StickerSource
  createdAt: number
  updatedAt: number
  lastSeenAt: number
}

export interface StickerPresetView {
  id: string
  name: string
  /** The preset is gone but stickers still reference it. */
  missing: boolean
  counts: Record<StickerStatus, number>
}

export interface StickerPresetsSnapshot {
  presets: StickerPresetView[]
  running: boolean
  mode: StickerMode
  gridSize: number
  threshold: number
}

export interface StickerView {
  hash: string
  status: StickerStatus
  count: number
  title: string
  description: string
  scenes: string
  reason: string
  source: StickerSource
  marked: boolean
  summary: string
  mediaType: string
  /** JPEG thumbnail as a data URI; empty when the file is gone. */
  thumb: string
  updatedAt: number
}

export interface StickerEntriesSnapshot {
  total: number
  items: StickerView[]
}

export interface StickerEntriesParams {
  presetId: string
  status?: StickerStatus | 'all'
  query?: string
  offset?: number
  limit?: number
}

export interface StickerUpdateInput {
  presetId: string
  hash: string
  title?: string
  description?: string
  scenes?: string
  status?: 'fit' | 'unfit'
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    sticker_helper_image: StickerImageRow
    sticker_helper_entry: StickerEntryRow
  }
}

declare module 'cordis' {
  interface Events<C = any> {
    /** Any sticker row, file or batch state changed. */
    'sticker-helper/change'(): void
  }
}

declare module '@chatluna/ui-client/client' {
  interface States {
    'sticker.presets': StickerPresetsSnapshot
    'sticker.entries': StickerEntriesSnapshot
  }
  interface Actions {
    'sticker.image'(input: { hash: string }): { dataUri: string }
    'sticker.upload'(input: { presetId: string; files: { name: string; content: string }[] }): {
      added: number
      skipped: number
    }
    'sticker.update'(input: StickerUpdateInput): void
    'sticker.delete'(input: { presetId: string; hashes: string[] }): void
    'sticker.copy'(input: { from: string; to: string; hashes: string[] }): { queued: number; skipped: number }
    'sticker.requeue'(input: { presetId: string; hashes: string[] }): void
    'sticker.run'(input: { presetId?: string }): { started: boolean }
    'sticker.download'(input: { presetId: string; hashes?: string[] }): { filename: string; data: string }
  }
}
