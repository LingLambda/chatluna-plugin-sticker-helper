import type { Context } from 'cordis'
import Schema from 'schemastery'
import type {} from '@cordisjs/plugin-timer'
import type {} from '@chatluna/permission'
import { modelAddressSchema } from '@chatluna/utils/model-address'
import { BatchRunner } from './batch'
import { applyCapture } from './capture'
import { applyLibrary } from './library'
import { StickerStore } from './store'
import type { StickerMode } from './types'
import { applyWebUI } from './webui'

export * from './types'

export const name = 'chatluna-plugin-sticker-helper'

export interface Config {
  autoCollect: boolean
  threshold: number
  gridSize: 9 | 4
  gifPerGrid: number
  gifFrames: 4 | 6 | 8
  gifSheetSize: number
  interval: number
  model: string
  mode: StickerMode
  maxFileSize: number
}

export const Config: Schema<Config> = Schema.object({
  autoCollect: Schema.boolean()
    .default(true)
    .description(
      '自动收集总开关。关闭后不再从会话中收集图片，规则中的「收集范围」也不再显示和生效；上传、复制和模型主动收藏不受影响。'
    ),
  threshold: Schema.natural().min(1).default(2).description('同一张图在某预设的会话中出现多少次后进入待处理队列。'),
  gridSize: Schema.union([Schema.const(9).description('9 张（3×3）'), Schema.const(4).description('4 张（2×2）')])
    .default(9)
    .description('静态表情每次识别拼成一张网格图的数量。'),
  gifPerGrid: Schema.natural()
    .min(1)
    .max(4)
    .default(1)
    .description('动图（多帧 GIF）每次识别的数量。默认 1 张，帧在整张图中横纵排开；多张时每张占一块，上下排列。'),
  gifFrames: Schema.union([
    Schema.const(4).description('4 帧（2×2）'),
    Schema.const(6).description('6 帧（2×3）'),
    Schema.const(8).description('8 帧（2×4）')
  ])
    .default(6)
    .description('每张动图均匀抽取的帧数（含首尾帧），按时间顺序从左到右、从上到下排成两行。'),
  gifSheetSize: Schema.natural()
    .min(1024)
    .max(4096)
    .default(2048)
    .description(
      '动图网格图的最大边长（px）。动图多或帧多时每格缩小，使宽和高都不超过它，每格最大 384px；模型服务商通常会缩小过大的图片。'
    ),
  interval: Schema.natural().min(10).default(360).description('定时跑批间隔（分钟），会处理所有待处理表情。'),
  model: modelAddressSchema({
    description: '识别表情的模型，须支持图片输入。',
    default: '@medium',
    modality: 'chat',
    roles: true
  }) as Schema<string>,
  mode: Schema.union([
    Schema.const('inject').description('注入全部标题'),
    Schema.const('search').description('提供搜索工具')
  ])
    .default('inject')
    .description('表情库交给模型的方式。'),
  maxFileSize: Schema.natural().min(1).default(5).description('单张图片大小上限（MiB）。')
})

export const inject = ['database', 'model', 'http', 'timer', 'chatluna', 'chat', 'presets', 'prompt', 'tools']

export function apply(ctx: Context, config: Config) {
  const store = new StickerStore(ctx, config)
  const runner = new BatchRunner(ctx, config, store)
  if (config.autoCollect) applyCapture(ctx, config, store, runner)
  applyLibrary(ctx, config, store)
  ctx.inject(['chatluna_webui', 'permissions'], (ctx) => applyWebUI(ctx, config, store, runner))

  /** Runs `job` every `period`, the first time when `period` has passed since its last start, even across restarts. */
  const every = async (name: string, period: number, job: () => Promise<void>) => {
    const tick = () => {
      void store
        .markRun(name)
        .then(job)
        .catch((error) => ctx.logger.warn('%s failed: %s', name, error))
    }
    const delay = Math.max(0, (await store.lastRun(name)) + period - Date.now())
    ctx.timeout(() => {
      tick()
      ctx.interval(tick, period)
    }, delay)
  }

  // Recovery resets processing entries, so no batch may start before it ends.
  void store
    .recover()
    .catch((error) => ctx.logger.warn('recover failed: %s', error))
    .then(() =>
      Promise.all([
        every('batch', config.interval * 60_000, () => runner.run({ full: false })),
        every('prune', 24 * 3_600_000, () => store.prune())
      ])
    )
    .catch((error) => ctx.logger.warn('schedule failed: %s', error))
}
