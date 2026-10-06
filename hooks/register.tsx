import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'
import { fitPane, fitRow, imageNumbers, pngSize } from './layout'
import type { Size } from './layout'

// Pasting an image raises no prompt.edit (the tag only shows up on the next keystroke),
// so the draft is polled instead.
const POLL_MS = 200

const images = atom({ plugin: 'image-preview', key: 'images' } as const, [] as PastedImage[])
// The image number shown enlarged in the pane, or null while the pane is closed.
const zoomed = atom({ plugin: 'image-preview', key: 'zoomed' } as const, null as number | null)

const PANE = 'image-preview'
// Rows under the enlarged picture: the label and the buttons.
const PANE_CHROME_ROWS = 2
// How to enlarge, drawn right of the tiles; its width is held back from them.
const HINT = 'zoom: click #N, or ctrl+x tab then 1-9'
const HINT_COLUMNS = HINT.length + 1

let tmpRoot: string | undefined
let found: { sessionId: string; dir: string } | undefined
// The image numbers last drawn, so an unchanged draft doesn't rewrite state; undefined
// while a drawn image's file is still missing, so the next poll looks again.
let shownKey: string | undefined
let isChecking = false
const sizes = new Map<string, Size | null>()

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png. The project
// folder is named after a working directory that may since have moved, so find it by the
// session id instead of rebuilding it.
async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (found?.sessionId === sessionId) return found.dir
  if (tmpRoot === undefined) {
    const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
    tmpRoot = fromEnv ?? `/tmp/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
  }
  const entries = await $.fs.list(tmpRoot).catch(() => [])
  for (const entry of entries) {
    const dir = `${tmpRoot}/${entry.name}/${sessionId}/images`
    if (entry.kind === 'dir' && (await $.fs.exists(dir))) {
      found = { sessionId, dir }
      return dir
    }
  }
  return undefined
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const path = `${dir}/${n}.png`
  if (dir === undefined || !(await $.fs.exists(path))) return { n, path: null, size: null }
  if (!sizes.has(path)) {
    const head = await $.fs.read(path, { as: 'bytes' }).then(
      ({ base64 }) => pngSize(base64),
      () => undefined, // too big to read: still drawable, just without its aspect ratio
    )
    if (head === null) return { n, path: null, size: null }
    sizes.set(path, head ?? null)
  }
  return { n, path, size: sizes.get(path) ?? null }
}

async function show($: EngineInterface, draft: string) {
  const numbers = imageNumbers(draft)
  const key = numbers.join(',')
  if (key === shownKey) return
  const dir = numbers.length > 0 ? await imagesDir($) : undefined
  const list: PastedImage[] = []
  for (const n of numbers) list.push(await describe($, dir, n))
  shownKey = list.every(image => image.path !== null) ? key : undefined
  await update($, images, () => list)
  // The enlarged image left the draft (sent, or its tag deleted): close its pane.
  const open = await read($, zoomed)
  if (open !== null && !numbers.includes(open)) await closeZoom($)
}

// Opens the pane as the press's own first call: anything awaited before $.ui.open loses
// the press, and the pane then counts as opened unasked (seated only from 144 columns).
// A pane that still can't be seated falls back to Preview, so a press always shows the picture.
async function zoom($: EngineInterface, n: number, path: string) {
  const opened = $.ui.open({ id: PANE, title: `Image #${n}`, focus: true, closeOnEscape: true, rows: 30 })
  await update($, zoomed, () => n)
  const result = await opened.catch(() => undefined)
  if (result?.isPlaced !== true) {
    await $.ui.close({ id: PANE })
    await update($, zoomed, () => null)
    await $.process.run(['open', path])
  }
}

async function closeZoom($: EngineInterface) {
  await update($, zoomed, () => null)
  await $.ui.close({ id: PANE })
}

async function check($: EngineInterface) {
  if (isChecking) return
  isChecking = true
  try {
    await show($, (await $.prompt.read()).text)
  } finally {
    isChecking = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // Image is terminal-only; the Desktop app previews pastes itself.
    if (e.surface !== 'terminal') return next(e)
    const { Box, Button, Image, Text } = $.ui.resolve(e)
    const n = await read($, zoomed)
    const image = (await read($, images)).find(one => one.n === n)
    if (n === null || image === undefined || image.path === null) {
      return <Text dimColor>No image to show.</Text>
    }
    const { columns, rows } = fitPane(image.size, e.props.scroll.bodyRows - PANE_CHROME_ROWS, e.props.bodyColumns)
    const path = image.path
    const size = image.size === null ? '' : `  ${image.size.width}×${image.size.height}`
    return (
      <Box flexDirection="column">
        <Image key={`zoom-${n}`} source={{ file: path, format: 'png' }} columns={columns} rows={rows} alt={`[Image #${n}]`} />
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor>#{n}{size}</Text>
          <Button key="preview" hotkey="o" onPress={() => void $.process.run(['open', path])}>Open in Preview</Button>
          <Button key="close" role="dismiss" hotkey="x" onPress={() => void closeZoom($)}>Close</Button>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    if (list.length === 0) return next(e)

    const { Box, Button, Image, Text } = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns - HINT_COLUMNS)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {list.map((image, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            return (
              <Box flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                {image.path === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                ) : (
                  <Image
                    key={`image-${image.n}`}
                    source={{ file: image.path, format: 'png' }}
                    columns={columns}
                    rows={rows}
                    alt={`[Image #${image.n}]`}
                  />
                )}
                {image.path === null ? (
                  <Text dimColor>#{image.n}</Text>
                ) : (
                  <Button
                    key={`zoom-${image.n}`}
                    plain
                    dimColor
                    hotkey={image.n <= 9 ? String(image.n) : undefined}
                    onPress={() => zoom($, image.n, image.path ?? '')}
                  >
                    {`#${image.n}`}
                  </Button>
                )}
              </Box>
            )
          })}
          <Box alignSelf="flex-end">
            <Text dimColor>{HINT}</Text>
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}
