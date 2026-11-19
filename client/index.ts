import type { Context } from 'cordis'
import zh from './locales/zh.yml'
import en from './locales/en.yml'

export default function apply(ctx: Context) {
  ctx.locale.register('sticker-helper', { zh, en })
  ctx.slots.route({
    path: '/stickers',
    // Lazy so the page is split into its own chunk and loads only when the route opens.
    page: async () => (await import('./page')).StickerPage,
    title: '表情包',
    icon: 'sticker',
    order: 36,
    group: 'capabilities',
    groupOrder: 36
  })
}
