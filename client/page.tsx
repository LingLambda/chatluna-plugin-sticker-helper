import * as React from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  PageHeader,
  SearchBox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea
} from '@chatluna/ui-kit'
import { apiErrorMessage, callAction, toast, useLive, useTranslate } from '@chatluna/ui-client/client'
import type { Translate } from '@chatluna/ui-client/client'
import { useStored } from '@chatluna/ui-storage'
import { CopyIcon, DownloadIcon, PlayIcon, RotateCcwIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { STICKER_STATUSES, type StickerPresetView, type StickerStatus, type StickerView } from '../src/types'

const PAGE = 60
/** The upload action takes at most 50 files per call. */
const UPLOAD_CHUNK = 50
const STATUS_FILTERS = ['all', ...STICKER_STATUSES] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

const STATUS_VARIANTS: Record<StickerStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  collecting: 'outline',
  pending: 'secondary',
  processing: 'secondary',
  fit: 'default',
  unfit: 'outline',
  failed: 'destructive'
}

function useT(): Translate {
  return useTranslate('sticker-helper')
}

function report(t: Translate, key: string) {
  return (error: unknown) => toast.error(t(key), { description: apiErrorMessage(error) })
}

/** The file's bytes as base64, without the data-URI prefix. */
function readBase64(file: File): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const reader = new FileReader()
  reader.onload = () => {
    const url = String(reader.result)
    resolve(url.slice(url.indexOf(',') + 1))
  }
  reader.onerror = () => reject(reader.error ?? new Error(`cannot read ${file.name}`))
  reader.readAsDataURL(file)
  return promise
}

async function download(t: Translate, presetId: string, hashes?: string[]) {
  try {
    const { filename, data } = await callAction(
      'sticker.download',
      hashes === undefined ? { presetId } : { presetId, hashes }
    )
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    report(t, 'downloadFailed')(error)
  }
}

export function StickerPage() {
  const t = useT()
  const snapshot = useLive('sticker.presets')
  const [stored, setStored] = useStored('chatluna.sticker-helper.preset', (value) =>
    typeof value === 'string' ? value : ''
  )
  const [status, setStatus] = React.useState<StatusFilter>('all')
  const [query, setQuery] = React.useState('')
  const [offset, setOffset] = React.useState(0)
  const [selected, setSelected] = React.useState<string[]>([])
  const [detail, setDetail] = React.useState<string>()
  const [copying, setCopying] = React.useState<string[]>()
  const [deleting, setDeleting] = React.useState<string[]>()
  const fileInput = React.useRef<HTMLInputElement>(null)

  const presets = snapshot.data?.presets ?? []
  const presetId = presets.some((preset) => preset.id === stored) ? stored : presets[0]?.id
  const preset = presets.find((item) => item.id === presetId)
  const entries = useLive(
    'sticker.entries',
    presetId === undefined ? undefined : { presetId, status, query, offset, limit: PAGE }
  )
  const items = entries.data?.items ?? []
  const total = entries.data?.total ?? 0
  const opened = items.find((item) => item.hash === detail)
  const threshold = snapshot.data?.threshold ?? 2

  React.useEffect(() => {
    setOffset(0)
    setSelected([])
  }, [presetId, status, query])

  const upload = async (list: FileList) => {
    if (presetId === undefined) return
    try {
      const files = await Promise.all(
        Array.from(list, async (file) => ({ name: file.name, content: await readBase64(file) }))
      )
      let added = 0
      let skipped = 0
      for (let start = 0; start < files.length; start += UPLOAD_CHUNK) {
        const result = await callAction('sticker.upload', { presetId, files: files.slice(start, start + UPLOAD_CHUNK) })
        added += result.added
        skipped += result.skipped
      }
      toast.success(t('uploaded', { added, skipped }))
    } catch (error) {
      report(t, 'uploadFailed')(error)
    }
  }

  const run = () =>
    void callAction('sticker.run', presetId === undefined ? {} : { presetId }).then(
      ({ started }) => toast.success(t(started ? 'runStarted' : 'runJoined')),
      report(t, 'runFailed')
    )

  const requeue = (hashes: string[]) =>
    presetId !== undefined &&
    void callAction('sticker.requeue', { presetId, hashes }).then(
      () => toast.success(t('requeue.done')),
      report(t, 'detail.saveFailed')
    )

  const toggle = (hash: string, on: boolean) =>
    setSelected((current) => (on ? [...current, hash] : current.filter((item) => item !== hash)))

  return (
    <div className="flex min-h-full flex-col gap-5 p-(--page-gutter)">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const files = event.target.files
                if (files !== null && files.length > 0) void upload(files)
                event.target.value = ''
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={presetId === undefined}
              onClick={() => fileInput.current?.click()}
            >
              <UploadIcon />
              {t('upload')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={presetId === undefined || total === 0}
              onClick={() => presetId !== undefined && void download(t, presetId)}
            >
              <DownloadIcon />
              {t('downloadAll')}
            </Button>
            <Button size="sm" disabled={snapshot.data?.running === true} onClick={run}>
              <PlayIcon />
              {snapshot.data?.running === true ? t('running') : t('run')}
            </Button>
          </div>
        }
      />
      {snapshot.data === undefined ? (
        <Skeleton className="h-8 w-full" />
      ) : presets.length === 0 ? (
        <EmptyState title={t('preset.none')} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={presetId ?? ''} onValueChange={(value) => value !== null && setStored(value)}>
              <SelectTrigger size="sm" className="w-44" aria-label={t('preset')}>
                <SelectValue>{preset === undefined ? '' : presetLabel(t, preset)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {presets.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {presetLabel(t, item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) => setStatus(STATUS_FILTERS.find((item) => item === value) ?? 'all')}
            >
              <SelectTrigger size="sm" className="w-32">
                <SelectValue>{t(`status.${status}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`status.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder={t('search')}
              clearLabel={t('clear')}
              className="min-w-0 flex-1"
            />
          </div>
          {preset !== undefined && (
            <div className="flex flex-wrap gap-1.5">
              {STICKER_STATUSES.map((item) => (
                <Badge key={item} variant={STATUS_VARIANTS[item]} title={t(`status.hint.${item}`, { threshold })}>
                  {t(`status.${item}`)} {preset.counts[item]}
                </Badge>
              ))}
            </div>
          )}
          {selected.length > 0 && presetId !== undefined && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <span>{t('selection.count', { count: selected.length })}</span>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                {t('selection.clear')}
              </Button>
              <span className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setCopying(selected)}>
                  <CopyIcon />
                  {t('copy')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => requeue(selected)}>
                  <RotateCcwIcon />
                  {t('requeue')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void download(t, presetId, selected)}>
                  <DownloadIcon />
                  {t('downloadSelected')}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setDeleting(selected)}>
                  <Trash2Icon />
                  {t('delete')}
                </Button>
              </span>
            </div>
          )}
          {entries.data === undefined ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="aspect-square w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              art={query === '' && status === 'all' ? 'empty' : 'search'}
              title={t(query === '' && status === 'all' ? 'list.empty' : 'list.noMatch')}
              hint={query === '' && status === 'all' ? t('list.emptyHint') : undefined}
            />
          ) : (
            <>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected([...new Set([...selected, ...items.map((item) => item.hash)])])}
                >
                  {t('selection.all')}
                </Button>
              </div>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
                {items.map((item) => (
                  <StickerCard
                    key={item.hash}
                    item={item}
                    threshold={threshold}
                    checked={selected.includes(item.hash)}
                    onCheck={(on) => toggle(item.hash, on)}
                    onOpen={() => setDetail(item.hash)}
                  />
                ))}
              </ul>
              <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                <span className="tabular-nums">
                  {t('list.page', { from: offset + 1, to: Math.min(offset + PAGE, total), total })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}
                >
                  {t('list.prev')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={offset + PAGE >= total}
                  onClick={() => setOffset(offset + PAGE)}
                >
                  {t('list.next')}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {opened !== undefined && presetId !== undefined && (
        <DetailDialog
          key={opened.hash}
          presetId={presetId}
          item={opened}
          threshold={threshold}
          onClose={() => setDetail(undefined)}
          onCopy={() => setCopying([opened.hash])}
          onRequeue={() => requeue([opened.hash])}
          onDelete={() => setDeleting([opened.hash])}
        />
      )}
      {copying !== undefined && presetId !== undefined && (
        <CopyDialog
          from={presetId}
          hashes={copying}
          presets={presets}
          onClose={(done) => {
            setCopying(undefined)
            if (done) setSelected([])
          }}
        />
      )}
      <AlertDialog open={deleting !== undefined} onOpenChange={(open) => !open && setDeleting(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('delete.hint', { count: deleting?.length ?? 0 })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const hashes = deleting
                if (presetId === undefined || hashes === undefined) return
                void callAction('sticker.delete', { presetId, hashes }).then(
                  () => {
                    setSelected((current) => current.filter((hash) => !hashes.includes(hash)))
                    if (detail !== undefined && hashes.includes(detail)) setDetail(undefined)
                  },
                  report(t, 'delete.failed')
                )
              }}
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function presetLabel(t: Translate, preset: StickerPresetView): string {
  return preset.missing ? `${preset.name}（${t('preset.missing')}）` : preset.name
}

function StickerCard({
  item,
  threshold,
  checked,
  onCheck,
  onOpen
}: {
  item: StickerView
  threshold: number
  checked: boolean
  onCheck(on: boolean): void
  onOpen(): void
}) {
  const t = useT()
  return (
    <li className={`relative overflow-hidden rounded-xl border ${checked ? 'ring-2 ring-primary' : ''}`}>
      <button type="button" onClick={onOpen} className="block w-full text-left transition-colors hover:bg-muted/50">
        <span className="flex aspect-square items-center justify-center bg-white">
          {item.thumb !== '' && (
            <img src={item.thumb} alt={item.title} className="max-h-full max-w-full object-contain" />
          )}
        </span>
        <span className="flex flex-col gap-1 p-2">
          <span className={`truncate text-sm font-medium ${item.title === '' ? 'text-muted-foreground' : ''}`}>
            {item.title === '' ? t('list.untitled') : item.title}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant={STATUS_VARIANTS[item.status]} title={t(`status.hint.${item.status}`, { threshold })}>
              {t(`status.${item.status}`)}
            </Badge>
            {item.status === 'collecting' ? (
              <span className="tabular-nums" title={t('list.progress', { count: item.count, threshold })}>
                {item.count}/{threshold}
              </span>
            ) : (
              <span className="tabular-nums">×{item.count}</span>
            )}
          </span>
        </span>
      </button>
      <span className="absolute top-2 left-2 rounded bg-background/80 p-0.5">
        <Checkbox checked={checked} onCheckedChange={(value) => onCheck(value === true)} />
      </span>
    </li>
  )
}

function DetailDialog({
  presetId,
  item,
  threshold,
  onClose,
  onCopy,
  onRequeue,
  onDelete
}: {
  presetId: string
  item: StickerView
  threshold: number
  onClose(): void
  onCopy(): void
  onRequeue(): void
  onDelete(): void
}) {
  const t = useT()
  const [image, setImage] = React.useState<string>()
  const [title, setTitle] = React.useState(item.title)
  const [description, setDescription] = React.useState(item.description)
  const [scenes, setScenes] = React.useState(item.scenes)
  const [verdict, setVerdict] = React.useState<'fit' | 'unfit' | undefined>(
    item.status === 'fit' || item.status === 'unfit' ? item.status : undefined
  )
  const [busy, setBusy] = React.useState(false)
  // What the form started from: a batch can rewrite the live item while the dialog is open, and fields the user left
  // alone must not overwrite that.
  const baseline = React.useRef({ title: title.trim(), description, scenes, verdict })

  React.useEffect(() => {
    let live = true
    void callAction('sticker.image', { hash: item.hash }).then(
      ({ dataUri }) => live && setImage(dataUri),
      report(t, 'detail.loadFailed')
    )
    return () => {
      live = false
    }
  }, [item.hash])

  const save = () => {
    setBusy(true)
    const sent = { title: title.trim(), description, scenes, verdict }
    const base = baseline.current
    const patch = {
      presetId,
      hash: item.hash,
      ...(sent.title !== base.title ? { title: sent.title } : {}),
      ...(description !== base.description ? { description } : {}),
      ...(scenes !== base.scenes ? { scenes } : {}),
      ...(verdict !== undefined && verdict !== base.verdict ? { status: verdict } : {})
    }
    void callAction('sticker.update', patch)
      .then(() => {
        baseline.current = sent
        toast.success(t('detail.saved'))
      }, report(t, 'detail.saveFailed'))
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="gap-1 border-b p-4 pr-12">
          <DialogTitle>{item.title === '' ? t('detail.title') : item.title}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANTS[item.status]}>{t(`status.${item.status}`)}</Badge>
            <span>
              {item.status === 'collecting' && `${t('list.progress', { count: item.count, threshold })} · `}
              {t(`status.hint.${item.status}`, { threshold })}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 sm:grid-cols-[minmax(0,16rem)_1fr]">
          <div className="flex flex-col gap-3">
            <div className="flex aspect-square items-center justify-center rounded-lg border bg-white">
              {image === undefined ? (
                <Skeleton className="size-full" />
              ) : (
                <img src={image} alt={item.title} className="max-h-full max-w-full object-contain" />
              )}
            </div>
            <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t('detail.field.count')}</dt>
              <dd className="tabular-nums">{item.count}</dd>
              <dt className="text-muted-foreground">{t('detail.field.source')}</dt>
              <dd>{t(`source.${item.source}`)}</dd>
              {item.summary !== '' && (
                <>
                  <dt className="text-muted-foreground">{t('detail.field.summary')}</dt>
                  <dd className="min-w-0 break-words">{item.summary}</dd>
                </>
              )}
              {item.reason !== '' && (
                <>
                  <dt className="text-muted-foreground">{t('detail.field.reason')}</dt>
                  <dd className="min-w-0 break-words">{item.reason}</dd>
                </>
              )}
            </dl>
          </div>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel>{t('detail.field.title')}</FieldLabel>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel>{t('detail.field.description')}</FieldLabel>
              <Textarea
                className="min-h-28"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>{t('detail.field.scenes')}</FieldLabel>
              <Textarea className="min-h-20" value={scenes} onChange={(event) => setScenes(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel>{t('detail.field.verdict')}</FieldLabel>
              <Select
                value={verdict ?? ''}
                onValueChange={(value) => setVerdict(value === 'fit' || value === 'unfit' ? value : undefined)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{verdict === undefined ? '—' : t(`status.${verdict}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fit">{t('status.fit')}</SelectItem>
                  <SelectItem value="unfit">{t('status.unfit')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </div>
        <DialogFooter className="flex-wrap border-t p-4">
          <Button variant="destructive" onClick={onDelete}>
            <Trash2Icon />
            {t('delete')}
          </Button>
          <Button variant="outline" onClick={onCopy}>
            <CopyIcon />
            {t('copy')}
          </Button>
          <Button variant="outline" onClick={onRequeue}>
            <RotateCcwIcon />
            {t('requeue')}
          </Button>
          <Button disabled={busy || title.trim() === ''} onClick={save}>
            {t('detail.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CopyDialog({
  from,
  hashes,
  presets,
  onClose
}: {
  from: string
  hashes: string[]
  presets: readonly StickerPresetView[]
  onClose(done: boolean): void
}) {
  const t = useT()
  const targets = presets.filter((preset) => preset.id !== from && !preset.missing)
  const [to, setTo] = React.useState(targets[0]?.id ?? '')
  const [busy, setBusy] = React.useState(false)
  const target = targets.find((preset) => preset.id === to)
  const submit = () => {
    setBusy(true)
    void callAction('sticker.copy', { from, to, hashes })
      .then(
        ({ queued, skipped }) => {
          toast.success(t('copy.done', { queued, skipped }))
          onClose(true)
        },
        report(t, 'copy.failed')
      )
      .finally(() => setBusy(false))
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('copy')}</DialogTitle>
          <DialogDescription>{t('copy.hint')}</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel>{t('copy.target')}</FieldLabel>
          <Select value={to} onValueChange={(value) => setTo(value ?? '')}>
            <SelectTrigger className="w-full">
              <SelectValue>{target?.name ?? ''}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {targets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            {t('cancel')}
          </Button>
          <Button disabled={busy || target === undefined} onClick={submit}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
