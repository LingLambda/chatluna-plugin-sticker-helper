import type { Context } from 'cordis'
import { h } from '@satorijs/core'
import { Schema } from '@chatluna/schema'
import { defineTool } from '@chatluna/tool'
import type { ChatBlock, ChatFileBlock, ChatMessage } from '@chatluna/message'
import type {} from '@chatluna/storage-files'
import { fileRefTableOf } from '@chatluna/transform'
import type {} from '@chatluna/chat'
import type { Agent } from '@chatluna/agent'
import type {} from '@chatluna/engine'
import type {} from '@chatluna/permission'
import type {} from '@chatluna/prompt'
import { isRecord } from '@chatluna/utils/object'
import type { Config } from './index'
import { downloadImage } from './capture'
import { MIB, normalizeTitle, type StickerStore } from './store'
import type { StickerEntryRow } from './types'

const SPLIT = /[\s,，、。;；]+/

/**
 * The preset the calling conversation runs now, the same one the prompt block and `<sticker>` see; sticker libraries
 * are per preset, so a call without one fails. `options.presetId` is only the preset the agent opened with.
 */
function presetOf(ctx: Context, agent: object | undefined): string {
  const options = agent !== undefined && isRecord(agent) ? agent['options'] : undefined
  const presetId =
    (agent === undefined ? undefined : ctx.get('engines')?.presetOf(agent as Agent)) ??
    (isRecord(options) ? options['presetId'] : undefined)
  if (typeof presetId !== 'string' || presetId === '')
    throw new Error('sticker tools need a conversation with a preset')
  return presetId
}

interface SaveArgs {
  ref: string
  title: string
  description: string
  scenes?: string
}

/** The image block a `<img ref>` placeholder in the calling conversation stands for. */
function imageOf(agent: object | undefined, ref: string): ChatFileBlock {
  const session = agent !== undefined && isRecord(agent) ? agent['session'] : undefined
  const messages: unknown =
    isRecord(session) && typeof session['messages'] === 'function' ? session['messages']() : undefined
  if (!Array.isArray(messages)) throw new Error('sticker_save needs the conversation history to resolve refs')
  const history: readonly ChatMessage[] = messages
  const block = fileRefTableOf(history).resolve(ref)
  if (block === undefined) throw new Error(`No file matches ref ${JSON.stringify(ref)} in this conversation.`)
  if (!block.mediaType.startsWith('image/')) throw new Error(`${ref} is not an image (${block.mediaType}).`)
  return block
}

/** The original bytes (never the admission preview): inline data, a stored temp file, or the platform link. */
async function bytesOf(ctx: Context, block: ChatFileBlock, maxBytes: number): Promise<Buffer | undefined> {
  const { data } = block
  if (data.type === 'data') {
    return data.data.startsWith('data:') ? downloadImage(ctx, data.data, maxBytes) : Buffer.from(data.data, 'base64')
  }
  if (data.type === 'url') return downloadImage(ctx, data.url, maxBytes)
  if (data.type === 'reference' && data.reference.startsWith('storage://')) {
    const file = await ctx.get('chatluna_storage')?.getTempFile(data.reference.slice('storage://'.length))
    return file === undefined || file === null ? undefined : file.data
  }
  return undefined
}

/** Results cross a JSON boundary; only the text and file blocks `sticker_detail` builds are passed on. */
function isContentBlocks(value: unknown): value is ChatBlock[] {
  return (
    Array.isArray(value) &&
    value.every((block) => isRecord(block) && (block['type'] === 'text' || block['type'] === 'file'))
  )
}

/** Term hits weigh 3 on the title and 1 on description/scenes; character bigrams of the whole query add 2 and 1. */
export function scoreSticker(entry: StickerEntryRow, query: string): number {
  const body = `${entry.description}\n${entry.scenes}`
  let score = 0
  for (const term of query.split(SPLIT).filter((term) => term !== '')) {
    if (entry.title.includes(term)) score += 3
    if (body.includes(term)) score += 1
  }
  const chars = Array.from(query.replace(/\s+/g, ''))
  for (let i = 0; i + 1 < chars.length; i++) {
    const bigram = chars[i]! + chars[i + 1]!
    if (entry.title.includes(bigram)) score += 2
    if (body.includes(bigram)) score += 1
  }
  return score
}

function libraryPrompt(mode: Config['mode'], library: readonly StickerEntryRow[]): string {
  if (mode === 'inject') {
    return `## Stickers
Send a sticker by writing <sticker title="…"/> inside a <message>, copying one of the titles below exactly. Titles are usually enough to choose; call sticker_detail only when you need a sticker's description or want to look at it. When someone sends a sticker you would like to use yourself, add it with sticker_save. Fix a wrong title or description with sticker_edit; drop stickers you no longer want with sticker_delete.
Titles: ${library.map((entry) => entry.title).join(' | ')}`
  }
  return `## Stickers
You have ${library.length} stickers. Call sticker_search to find titles for what you want to express, then send one with <sticker title="…"/> inside a <message>. Call sticker_detail when you need a sticker's description or want to look at it. When someone sends a sticker you would like to use yourself, add it with sticker_save. Fix a wrong title or description with sticker_edit; drop stickers you no longer want with sticker_delete.`
}

/** Hands each preset's fit stickers to the model: the prompt block, the `<sticker>` element and the lookup tools. */
export function applyLibrary(ctx: Context, config: Config, store: StickerStore) {
  ctx.prompt.block({
    id: 'sticker-helper:library',
    zone: 'system',
    order: 200,
    content: async ({ env }) => {
      if (env.presetId === undefined) return ''
      const library = await store.fitLibrary(env.presetId)
      return library.length === 0 ? '' : libraryPrompt(config.mode, library)
    }
  })

  ctx.chat.element('sticker', {
    description: 'Send a sticker from your sticker library by its exact title.',
    locales: { zh: { description: '按标题发送表情库中的表情包。', attrs: { title: '表情标题' } } },
    attrs: Schema.object({
      title: Schema.string().required().description('the exact title from your sticker library')
    }),
    example: '<message>早呀<sticker title="小猪说天气真好"/></message>',
    inline: true,
    default: true,
    render: async (attrs, _children, session) => {
      const presetId = ctx.chat.binding(session).preset.preset
      const title = String(attrs['title'] ?? '').trim()
      const entry = presetId === undefined ? undefined : await store.findFit(presetId, title)
      const dataUri = entry === undefined ? undefined : await store.dataUri(entry.hash)
      if (dataUri === undefined) {
        ctx.logger.warn('unknown sticker title %s in preset %s', title, presetId)
        return ''
      }
      return h.image(dataUri)
    }
  })

  // The library is the persona's own; looking through it never asks.
  ctx.inject(['permissions'], (ctx) => ctx.permissions.define('tool:sticker_(name)', { allow: 1 }))

  ctx.tools.define(
    defineTool<{ title: string; look?: boolean }>({
      name: 'sticker_detail',
      description:
        "Read a sticker's description and suitable scenes by its exact title; with look, also see the image itself.",
      args: Schema.object({
        title: Schema.string().required().description('the exact sticker title'),
        look: Schema.boolean().default(false).description('also return the image so you can see it')
      }),
      traits: { effect: 'read', parallel: true },
      async run(args, call) {
        const entry = await store.findFit(presetOf(ctx, call.agent), args.title.trim())
        if (entry === undefined) throw new Error(`No sticker titled "${args.title}" in this library.`)
        const result: { title: string; description: string; scenes: string; content?: ChatBlock[] } = {
          title: entry.title,
          description: entry.description,
          scenes: entry.scenes
        }
        if (args.look === true) {
          const file = await store.readFile(entry.hash)
          if (file !== undefined) {
            result.content = [
              { type: 'text', text: `Sticker "${entry.title}": ${entry.description}` },
              { type: 'file', mediaType: file.mediaType, data: { type: 'data', data: file.bytes.toString('base64') } }
            ]
          }
        }
        return result
      },
      render: {
        // With look, the image goes to the model as content instead of the JSON snapshot.
        result: (args, value) => {
          const content = isRecord(value) ? value['content'] : undefined
          if (!isContentBlocks(content)) return { kind: 'generic', title: args.title }
          return { kind: 'generic', title: args.title, content }
        }
      }
    })
  )

  ctx.tools.define(
    defineTool<SaveArgs>({
      name: 'sticker_save',
      description:
        'Add an image from this conversation to your own sticker library so you can send it later with <sticker title="…"/>. Look at it first if you have not seen it. Give it a short title naming its core content and a description of what it shows; the saved title may be shortened or numbered, so use the one returned.',
      args: Schema.object({
        ref: Schema.string().required().description('the ref attribute of the `<img ref="i…"/>` placeholder to save'),
        title: Schema.string()
          .required()
          .description('at most 8 Chinese characters: subject + action, emotion or caption, e.g. 小猪说天气真好'),
        description: Schema.string()
          .required()
          .description('who or what is shown, expression, action, caption text verbatim, art style'),
        scenes: Schema.string().default('').description('chat situations where sending it fits')
      }),
      traits: { effect: 'write' },
      async run(args, call) {
        const presetId = presetOf(ctx, call.agent)
        const block = imageOf(call.agent, args.ref)
        const bytes = await bytesOf(ctx, block, config.maxFileSize * MIB)
        if (bytes === undefined) throw new Error(`The image ${args.ref} can no longer be fetched.`)
        const title = await store.ingest(bytes, { marked: true, summary: '' }, (hash) =>
          store.save(presetId, hash, {
            title: args.title,
            description: args.description,
            scenes: args.scenes ?? ''
          })
        )
        if (title === undefined) {
          throw new Error(
            `The image ${args.ref} is not a supported image (png, jpg, gif, webp up to ${config.maxFileSize} MiB).`
          )
        }
        return { saved: true, title }
      }
    })
  )

  ctx.tools.define(
    defineTool<{ title: string; newTitle?: string; description?: string; scenes?: string }>({
      name: 'sticker_edit',
      description:
        'Correct a sticker in your library: rename it, or rewrite its description or scenes. Only the fields you pass change; look at it with sticker_detail first if unsure what it shows. Use the title returned from now on.',
      args: Schema.object({
        title: Schema.string().required().description('the exact current title'),
        newTitle: Schema.string().description(
          'new title, at most 8 Chinese characters; must not be taken by another sticker'
        ),
        description: Schema.string().description(
          'new description: who or what is shown, expression, action, caption text verbatim, art style'
        ),
        scenes: Schema.string().description('new chat situations where sending it fits')
      }),
      traits: { effect: 'write' },
      async run(args, call) {
        const presetId = presetOf(ctx, call.agent)
        const entry = await store.findFit(presetId, args.title.trim())
        if (entry === undefined) throw new Error(`No sticker titled "${args.title}" in this library.`)
        const patch = {
          title: args.newTitle === undefined ? undefined : normalizeTitle(args.newTitle),
          description: args.description?.trim(),
          scenes: args.scenes?.trim()
        }
        if (Object.values(patch).every((value) => value === undefined)) {
          throw new Error('Pass at least one of newTitle, description or scenes.')
        }
        const outcome = await store.update(presetId, entry.hash, patch)
        if (outcome === 'missing') throw new Error(`No sticker titled "${args.title}" in this library.`)
        if (outcome === 'conflict')
          throw new Error(`Another sticker is already titled "${patch.title}"; pick another title.`)
        return {
          title: patch.title ?? entry.title,
          description: patch.description ?? entry.description,
          scenes: patch.scenes ?? entry.scenes
        }
      }
    })
  )

  ctx.tools.define(
    defineTool<{ titles: string[]; reason?: string }>({
      name: 'sticker_delete',
      description:
        'Remove stickers you no longer want from your library. They stop being offered to you and are not collected again; sticker_save brings one back if it is sent in the conversation again.',
      args: Schema.object({
        titles: Schema.array(Schema.string()).min(1).required().description('exact titles to remove'),
        reason: Schema.string().default('').description('why, kept for the library owner')
      }),
      traits: { effect: 'write' },
      async run(args, call) {
        const presetId = presetOf(ctx, call.agent)
        const note = args.reason?.trim() ?? ''
        // Marked unfit, not deleted: the owner can restore it in the WebUI, and later sightings do not queue it again.
        const reason = note === '' ? '模型将其移出表情库' : `模型将其移出表情库：${note}`
        const removed: string[] = []
        const missing: string[] = []
        for (const title of new Set(args.titles.map((title) => title.trim()))) {
          const entry = await store.findFit(presetId, title)
          const outcome =
            entry === undefined ? 'missing' : await store.update(presetId, entry.hash, { status: 'unfit', reason })
          if (outcome === 'ok') removed.push(title)
          else missing.push(title)
        }
        if (removed.length === 0)
          throw new Error(`No sticker titled ${missing.map((title) => `"${title}"`).join(', ')} in this library.`)
        return missing.length === 0 ? { removed } : { removed, missing }
      }
    })
  )

  if (config.mode !== 'search') return
  ctx.tools.define(
    defineTool<{ query: string; limit?: number }>({
      name: 'sticker_search',
      description:
        'Search your sticker library by what you want to express (emotion, action, caption words); returns titles to send with <sticker title="…"/>.',
      args: Schema.object({
        query: Schema.string().required().description('what you want to express'),
        limit: Schema.natural().min(1).max(30).default(10)
      }),
      traits: { effect: 'read', parallel: true },
      async run(args, call) {
        const library = await store.fitLibrary(presetOf(ctx, call.agent))
        const results = library
          .map((entry) => ({ entry, score: scoreSticker(entry, args.query) }))
          .filter((hit) => hit.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, args.limit ?? 10)
          .map(({ entry }) => ({ title: entry.title, scenes: entry.scenes }))
        return { results }
      }
    })
  )
}
