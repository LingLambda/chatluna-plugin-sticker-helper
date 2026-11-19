import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-database'
import { chatlunaDataPath } from '@chatluna/utils'
import type { Config } from './index'
import { frameCount, probe, thumbnail } from './image'
import type { StickerEntryRow, StickerImageRow, StickerSource, StickerStatus } from './types'

const IMAGE = 'sticker_helper_image'
const ENTRY = 'sticker_helper_entry'

/** Entries still collecting are forgotten after 30 days without another sighting. */
export const COLLECTING_TTL = 30 * 86_400_000
/** The third failed batch run marks an entry failed. */
export const MAX_ATTEMPTS = 3
const TITLE_LENGTH = 8
const TITLE_STRIP = /[「」『』"“”'‘’《》[\]【】()（）\s]/g
export const MIB = 1024 * 1024

export interface CatalogItem {
  hash: string
  title: string
  description: string
  scenes: string
  fit: boolean
  reason: string
}

export interface StickerRecord extends StickerEntryRow {
  image: StickerImageRow | undefined
}

export type UpdateOutcome = 'ok' | 'missing' | 'conflict'

/** Model titles: no quotes, brackets or spaces, at most 8 code points, `表情` when nothing remains. */
export function normalizeTitle(raw: string): string {
  const title = Array.from(raw.trim().replace(TITLE_STRIP, '')).slice(0, TITLE_LENGTH).join('')
  return title === '' ? '表情' : title
}

/** `base`, else the first free `base-1`, `base-2`, …; the result is added to `taken`. */
export function uniqueTitle(base: string, taken: Set<string>): string {
  let title = base
  for (let suffix = 1; taken.has(title); suffix++) title = `${base}-${suffix}`
  taken.add(title)
  return title
}

/**
 * Sticker rows and files. Images are shared and keyed by content hash; entries are per preset, so two presets never
 * see each other's counts, titles or verdicts. Every entry write goes through {@link serial} for its preset.
 */
export class StickerStore {
  readonly root = resolve(chatlunaDataPath('sticker-helper'))
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly dirs: Promise<unknown>

  constructor(
    private readonly ctx: Context,
    private readonly config: Config
  ) {
    ctx.model.extend(
      IMAGE,
      {
        hash: 'string',
        ext: 'string',
        mediaType: 'string',
        size: 'unsigned',
        width: 'unsigned',
        height: 'unsigned',
        marked: 'boolean',
        summary: 'string',
        createdAt: 'integer',
        /** Frames in the file; above 1 the sticker is cataloged from a frame strip. 0 = not counted yet. */
        frames: { type: 'unsigned', initial: 0 }
      },
      { primary: 'hash' }
    )
    ctx.model.extend(
      ENTRY,
      {
        presetId: 'string',
        hash: 'string',
        status: 'string',
        count: 'unsigned',
        attempts: 'unsigned',
        title: { type: 'string', initial: '' },
        description: 'text',
        scenes: 'text',
        reason: 'text',
        source: 'string',
        createdAt: 'integer',
        updatedAt: 'integer',
        lastSeenAt: 'integer'
      },
      {
        primary: ['presetId', 'hash'],
        indexes: [
          ['presetId', 'status'],
          ['presetId', 'title']
        ]
      }
    )
    this.dirs = Promise.all([
      mkdir(join(this.root, 'files'), { recursive: true }),
      mkdir(join(this.root, 'thumbs'), { recursive: true })
    ])
  }

  /** Runs `fn` after every earlier call with the same key has settled. */
  serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tail = next.catch(() => {})
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return next
  }

  changed() {
    this.ctx.emit('sticker-helper/change')
  }

  /**
   * Stores the file and its thumbnail once, then runs `attach` with the hash while still holding the image's lock, so
   * {@link removeOrphans} cannot drop the image between storing it and the caller writing its entry. Undefined when the
   * bytes are not a supported image within the limits.
   */
  async ingest<T>(
    bytes: Buffer,
    meta: { marked: boolean; summary: string },
    attach: (hash: string) => Promise<T>
  ): Promise<T | undefined> {
    const info = probe(bytes, this.config.maxFileSize * MIB)
    if (info === undefined) {
      this.ctx.logger.debug('skipped image: unsupported or over the limits (%d bytes)', bytes.length)
      return undefined
    }
    const hash = createHash('sha256').update(bytes).digest('hex')
    return this.serial(`\0image:${hash}`, async () => {
      await this.dirs
      const file = this.filePath(hash, info.ext)
      const thumb = this.thumbPath(hash)
      if (!(await exists(thumb))) {
        let jpeg: Uint8Array
        try {
          jpeg = thumbnail(bytes)
        } catch (error) {
          this.ctx.logger.debug('skipped image %s: cannot decode: %s', hash, error)
          return undefined
        }
        await writeFile(thumb, jpeg)
      }
      if (!(await exists(file))) await writeFile(file, bytes)
      const [row] = await this.ctx.database.get(IMAGE, { hash })
      if (row === undefined) {
        await this.ctx.database.create(IMAGE, {
          hash,
          ext: info.ext,
          mediaType: info.mediaType,
          size: bytes.length,
          width: info.width,
          height: info.height,
          frames: frameCount(bytes),
          marked: meta.marked,
          summary: meta.summary,
          createdAt: Date.now()
        })
      } else {
        const patch: Partial<StickerImageRow> = {}
        if (meta.marked && !row.marked) patch.marked = true
        if (row.summary === '' && meta.summary !== '') patch.summary = meta.summary
        if (Object.keys(patch).length > 0) await this.ctx.database.set(IMAGE, { hash }, patch)
      }
      return attach(hash)
    })
  }

  /** Runs `fn` under the image's lock when the image is still stored; undefined when it is gone. */
  withImage<T>(hash: string, fn: () => Promise<T>): Promise<T | undefined> {
    return this.serial(`\0image:${hash}`, async () => ((await this.image(hash)) === undefined ? undefined : fn()))
  }

  /**
   * Counts one more sighting (or an upload/copy) of the image in this preset. Collected images wait for the threshold;
   * uploaded and copied ones go straight to pending. Entries already queued or processed only count.
   */
  record(presetId: string, hash: string, source: StickerSource): Promise<{ becamePending: boolean; created: boolean }> {
    return this.serial(presetId, async () => {
      const now = Date.now()
      const [entry] = await this.ctx.database.get(ENTRY, { presetId, hash })
      if (entry === undefined) {
        const status: StickerStatus = source !== 'collected' || 1 >= this.config.threshold ? 'pending' : 'collecting'
        await this.ctx.database.create(ENTRY, {
          presetId,
          hash,
          status,
          count: 1,
          attempts: 0,
          title: '',
          description: '',
          scenes: '',
          reason: '',
          source,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now
        })
        this.changed()
        return { becamePending: status === 'pending', created: true }
      }
      const count = entry.count + 1
      const promote = entry.status === 'collecting' && (source !== 'collected' || count >= this.config.threshold)
      await this.ctx.database.set(
        ENTRY,
        { presetId, hash },
        promote ? { count, lastSeenAt: now, status: 'pending', updatedAt: now } : { count, lastSeenAt: now }
      )
      this.changed()
      return { becamePending: promote, created: false }
    })
  }

  /** Pending entries of a preset, split by whether they are cataloged from a frame strip. */
  async pendingCounts(presetId: string): Promise<{ still: number; animated: number }> {
    const pending = await this.pendingKinds(presetId)
    const animated = pending.filter((entry) => entry.animated).length
    return { still: pending.length - animated, animated }
  }

  /**
   * Takes up to `limit` of the oldest pending entries of one kind (animated or still) and marks them processing so
   * nothing else takes them. With `full`, takes nothing unless all `limit` are there.
   */
  takePending(presetId: string, animated: boolean, limit: number, full: boolean): Promise<StickerEntryRow[]> {
    return this.serial(presetId, async () => {
      const kinds = await this.pendingKinds(presetId)
      const rows = kinds
        .filter((entry) => entry.animated === animated)
        .slice(0, limit)
        .map((entry) => entry.row)
      if (rows.length === 0 || (full && rows.length < limit)) return []
      await this.ctx.database.set(ENTRY, { presetId, hash: rows.map((row) => row.hash) }, { status: 'processing' })
      this.changed()
      return rows
    })
  }

  /** Pending entries oldest first, each marked animated when its image has more than one frame. */
  private async pendingKinds(presetId: string): Promise<{ row: StickerEntryRow; animated: boolean }[]> {
    const rows = await this.ctx.database
      .select(ENTRY, { presetId, status: 'pending' })
      .orderBy('updatedAt', 'asc')
      .execute()
    const images = await this.ctx.database.get(IMAGE, { hash: rows.map((row) => row.hash) }, ['hash', 'frames'])
    const animated = new Set(images.filter((image) => image.frames > 1).map((image) => image.hash))
    return rows.map((row) => ({ row, animated: animated.has(row.hash) }))
  }

  async presetIdsWithPending(): Promise<string[]> {
    const rows = await this.ctx.database.get(ENTRY, { status: 'pending' }, ['presetId'])
    return [...new Set(rows.map((row) => row.presetId))]
  }

  /**
   * Writes a batch's catalog: titles normalized and made unique within the preset, status by the fit verdict. Entries
   * no longer processing (saved by the model or deleted meanwhile) keep what they have.
   */
  catalog(presetId: string, items: readonly CatalogItem[]): Promise<void> {
    return this.serial(presetId, async () => {
      const live = new Set(
        (
          await this.ctx.database.get(ENTRY, { presetId, hash: items.map((item) => item.hash), status: 'processing' }, [
            'hash'
          ])
        ).map((row) => row.hash)
      )
      const rows = await this.ctx.database.get(ENTRY, { presetId, title: { $ne: '' } }, ['hash', 'title'])
      const taken = new Set(rows.filter((row) => !live.has(row.hash)).map((row) => row.title))
      const now = Date.now()
      for (const item of items.filter((item) => live.has(item.hash))) {
        await this.ctx.database.set(
          ENTRY,
          { presetId, hash: item.hash },
          {
            title: uniqueTitle(normalizeTitle(item.title), taken),
            description: item.description.trim(),
            scenes: item.scenes.trim(),
            reason: item.reason.trim(),
            status: item.fit ? 'fit' : 'unfit',
            attempts: 0,
            updatedAt: now
          }
        )
      }
      this.changed()
    })
  }

  /**
   * The model's own pick: the image joins the library as fit with the model's text, replacing any earlier catalog of it.
   * The title is normalized and made unique like a batch title; returns the title it got.
   */
  save(presetId: string, hash: string, text: { title: string; description: string; scenes: string }): Promise<string> {
    return this.serial(presetId, async () => {
      const rows = await this.ctx.database.get(ENTRY, { presetId, title: { $ne: '' } }, ['hash', 'title'])
      const taken = new Set(rows.filter((row) => row.hash !== hash).map((row) => row.title))
      const title = uniqueTitle(normalizeTitle(text.title), taken)
      const now = Date.now()
      const catalog = {
        title,
        description: text.description.trim(),
        scenes: text.scenes.trim(),
        reason: '',
        status: 'fit' as const,
        attempts: 0,
        updatedAt: now,
        lastSeenAt: now
      }
      const [entry] = await this.ctx.database.get(ENTRY, { presetId, hash }, ['count'])
      if (entry === undefined) {
        await this.ctx.database.create(ENTRY, { presetId, hash, count: 1, source: 'saved', createdAt: now, ...catalog })
      } else {
        await this.ctx.database.set(ENTRY, { presetId, hash }, catalog)
      }
      this.changed()
      return title
    })
  }

  /** One more failed attempt for entries still processing: back to pending, or failed with `reason` on the third. */
  retry(presetId: string, hashes: readonly string[], reason: string): Promise<void> {
    return this.serial(presetId, async () => {
      const rows = await this.ctx.database.get(ENTRY, { presetId, hash: [...hashes], status: 'processing' })
      const now = Date.now()
      for (const row of rows) {
        const attempts = row.attempts + 1
        await this.ctx.database.set(
          ENTRY,
          { presetId, hash: row.hash },
          attempts >= MAX_ATTEMPTS
            ? { attempts, status: 'failed', reason, updatedAt: now }
            : { attempts, status: 'pending', updatedAt: now }
        )
      }
      this.changed()
    })
  }

  fail(presetId: string, hashes: readonly string[], reason: string): Promise<void> {
    if (hashes.length === 0) return Promise.resolve()
    return this.serial(presetId, async () => {
      await this.ctx.database.set(
        ENTRY,
        { presetId, hash: [...hashes] },
        { status: 'failed', reason, updatedAt: Date.now() }
      )
      this.changed()
    })
  }

  /**
   * Crash recovery and threshold changes: processing goes back to pending, collecting at the threshold moves up. Then
   * images stored before frames were counted get counted; that reads files, so it comes last and cannot reset a batch
   * that started meanwhile.
   */
  async recover(): Promise<void> {
    const now = Date.now()
    await this.ctx.database.set(ENTRY, { status: 'processing' }, { status: 'pending' })
    await this.ctx.database.set(
      ENTRY,
      { status: 'collecting', count: { $gte: this.config.threshold } },
      { status: 'pending', updatedAt: now }
    )
    for (const image of await this.ctx.database.get(IMAGE, { frames: 0 }, ['hash', 'ext'])) {
      const bytes = await readFile(this.filePath(image.hash, image.ext)).catch(() => undefined)
      await this.ctx.database.set(IMAGE, { hash: image.hash }, { frames: bytes === undefined ? 1 : frameCount(bytes) })
    }
    this.changed()
  }

  /** Forgets stale collecting entries, then images nothing references. */
  async prune(): Promise<void> {
    await this.ctx.database.remove(ENTRY, {
      status: 'collecting',
      lastSeenAt: { $lt: Date.now() - COLLECTING_TTL }
    })
    await this.removeOrphans()
    this.changed()
  }

  /**
   * Drops image rows and files no entry references; `hashes` limits the check, otherwise every image. Each image is
   * rechecked under its own lock, which {@link ingest} holds until its caller's entry is written.
   */
  async removeOrphans(hashes?: readonly string[]): Promise<void> {
    const candidates =
      hashes === undefined
        ? await this.ctx.database.get(IMAGE, {}, ['hash', 'ext'])
        : await this.ctx.database.get(IMAGE, { hash: [...hashes] }, ['hash', 'ext'])
    const used = new Set(
      (await this.ctx.database.get(ENTRY, { hash: candidates.map((row) => row.hash) }, ['hash'])).map((row) => row.hash)
    )
    for (const row of candidates.filter((row) => !used.has(row.hash))) {
      await this.serial(`\0image:${row.hash}`, async () => {
        const [entry] = await this.ctx.database.get(ENTRY, { hash: row.hash }, ['hash'])
        if (entry !== undefined) return
        await this.ctx.database.remove(IMAGE, { hash: row.hash })
        await rm(this.filePath(row.hash, row.ext), { force: true })
        await rm(this.thumbPath(row.hash), { force: true })
      })
    }
  }

  async fitLibrary(presetId: string): Promise<StickerEntryRow[]> {
    const rows = await this.ctx.database.get(ENTRY, { presetId, status: 'fit' })
    return rows.sort((left, right) => left.createdAt - right.createdAt)
  }

  async findFit(presetId: string, title: string): Promise<StickerEntryRow | undefined> {
    const [row] = await this.ctx.database.get(ENTRY, { presetId, title, status: 'fit' })
    return row
  }

  async image(hash: string): Promise<StickerImageRow | undefined> {
    const [row] = await this.ctx.database.get(IMAGE, { hash })
    return row
  }

  async readFile(hash: string): Promise<{ bytes: Buffer; mediaType: string; ext: string } | undefined> {
    const row = await this.image(hash)
    if (row === undefined) return undefined
    const bytes = await readFile(this.filePath(hash, row.ext)).catch(() => undefined)
    return bytes === undefined ? undefined : { bytes, mediaType: row.mediaType, ext: row.ext }
  }

  async dataUri(hash: string): Promise<string | undefined> {
    const file = await this.readFile(hash)
    return file === undefined ? undefined : `data:${file.mediaType};base64,${file.bytes.toString('base64')}`
  }

  async thumbUri(hash: string): Promise<string> {
    const bytes = await readFile(this.thumbPath(hash)).catch(() => undefined)
    return bytes === undefined ? '' : `data:image/jpeg;base64,${bytes.toString('base64')}`
  }

  /** Every entry of a preset (optionally one status), newest first, joined with its image row. */
  async list(presetId: string, status: StickerStatus | 'all' = 'all'): Promise<StickerRecord[]> {
    const rows = await this.ctx.database.get(ENTRY, status === 'all' ? { presetId } : { presetId, status })
    const images = await this.ctx.database.get(IMAGE, { hash: rows.map((row) => row.hash) })
    const byHash = new Map(images.map((image) => [image.hash, image]))
    return rows
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((row) => ({ ...row, image: byHash.get(row.hash) }))
  }

  async statusRows(): Promise<{ presetId: string; status: StickerStatus }[]> {
    return this.ctx.database.get(ENTRY, {}, ['presetId', 'status'])
  }

  /** A manual edit; titles are only trimmed, never shortened, and must stay unique within the preset. */
  update(
    presetId: string,
    hash: string,
    patch: {
      title?: string | undefined
      description?: string | undefined
      scenes?: string | undefined
      status?: 'fit' | 'unfit' | undefined
      reason?: string | undefined
    }
  ): Promise<UpdateOutcome> {
    return this.serial(presetId, async () => {
      const [entry] = await this.ctx.database.get(ENTRY, { presetId, hash })
      if (entry === undefined) return 'missing'
      const next: Partial<StickerEntryRow> = { updatedAt: Date.now() }
      if (patch.title !== undefined) {
        const title = patch.title.trim()
        const [clash] = await this.ctx.database.get(ENTRY, { presetId, title, hash: { $ne: hash } }, ['hash'])
        if (clash !== undefined) return 'conflict'
        next.title = title
      }
      if (patch.description !== undefined) next.description = patch.description
      if (patch.scenes !== undefined) next.scenes = patch.scenes
      if (patch.status !== undefined) next.status = patch.status
      if (patch.reason !== undefined) next.reason = patch.reason
      await this.ctx.database.set(ENTRY, { presetId, hash }, next)
      this.changed()
      return 'ok'
    })
  }

  async remove(presetId: string, hashes: readonly string[]): Promise<void> {
    await this.serial(presetId, async () => {
      await this.ctx.database.remove(ENTRY, { presetId, hash: [...hashes] })
    })
    await this.removeOrphans(hashes)
    this.changed()
  }

  /** Back to pending with a fresh attempt budget; the old text stays until the batch overwrites it. */
  requeue(presetId: string, hashes: readonly string[]): Promise<void> {
    return this.serial(presetId, async () => {
      await this.ctx.database.set(
        ENTRY,
        { presetId, hash: [...hashes], status: { $ne: 'processing' } },
        { status: 'pending', attempts: 0, updatedAt: Date.now() }
      )
      this.changed()
    })
  }

  async hasEntries(presetId: string, hashes: readonly string[]): Promise<string[]> {
    const rows = await this.ctx.database.get(ENTRY, { presetId, hash: [...hashes] }, ['hash'])
    return rows.map((row) => row.hash)
  }

  /** When a periodic job last started (ms), so restarts resume its period instead of resetting it; 0 if never. */
  async lastRun(job: string): Promise<number> {
    const runs = await this.readSchedule()
    return runs[job] ?? 0
  }

  markRun(job: string): Promise<void> {
    return this.serial('\0schedule', async () => {
      await this.dirs
      const runs = await this.readSchedule()
      runs[job] = Date.now()
      await writeFile(join(this.root, 'schedule.json'), JSON.stringify(runs))
    })
  }

  private async readSchedule(): Promise<Record<string, number>> {
    const raw = await readFile(join(this.root, 'schedule.json'), 'utf8').catch(() => undefined)
    if (raw === undefined) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return {}
      return Object.fromEntries(
        Object.entries(parsed).filter((pair): pair is [string, number] => typeof pair[1] === 'number')
      )
    } catch {
      return {}
    }
  }

  private filePath(hash: string, ext: string) {
    return join(this.root, 'files', `${hash}.${ext}`)
  }

  private thumbPath(hash: string) {
    return join(this.root, 'thumbs', `${hash}.jpg`)
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}
