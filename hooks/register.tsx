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

// Where this session's pastes are cached, and where their PNG copies go.
type Dirs = { sessionId: string; images: string; converted: string }

let tmpRoot: string | undefined
let found: Dirs | undefined
// The image numbers last drawn, so an unchanged draft doesn't rewrite state; undefined
// while a drawn image's file is still missing, so the next poll looks again.
let shownKey: string | undefined
let isChecking = false
const sizes = new Map<string, Size | null>()
// Cached file -> its PNG copy, or null when no converter could read it.
const converted = new Map<string, string | null>()

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.<ext>, the extension
// that of the pasted picture (png, jpg, gif, webp...). The project folder is named after a
// working directory that may since have moved, so find it by the session id instead of
// rebuilding it. PNG copies of the other formats go in a sibling folder, <session>/image-preview.
async function dirs($: EngineInterface): Promise<Dirs | undefined> {
  const sessionId = await $.session.id()
  if (found?.sessionId === sessionId) return found
  if (tmpRoot === undefined) {
    const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
    tmpRoot = fromEnv ?? `/tmp/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
  }
  const entries = await $.fs.list(tmpRoot).catch(() => [])
  for (const entry of entries) {
    const session = `${tmpRoot}/${entry.name}/${sessionId}`
    if (entry.kind === 'dir' && (await $.fs.exists(`${session}/images`))) {
      found = { sessionId, images: `${session}/images`, converted: `${session}/image-preview` }
      return found
    }
  }
  return undefined
}

/** The cached file of image n, whatever its extension, or undefined while there is none. */
async function cached($: EngineInterface, where: Dirs, n: number): Promise<string | undefined> {
  const name = new RegExp(`^${n}\\.[A-Za-z0-9]+$`)
  const entries = await $.fs.list(where.images).catch(() => [])
  const entry = entries.find(one => one.kind === 'file' && name.test(one.name))
  return entry === undefined ? undefined : `${where.images}/${entry.name}`
}

// sips ships with macOS; ImageMagick is the usual tool elsewhere. `[0]` takes a GIF's first frame.
function converters(src: string, dst: string): string[][] {
  return [
    ['sips', '-s', 'format', 'png', src, '--out', dst],
    ['magick', `${src}[0]`, dst],
    ['convert', `${src}[0]`, dst],
  ]
}

// The Image element draws PNG only, so any other paste is converted once to
// <session>/image-preview/<n>.png. sips exits 0 even when it can't read the file, and a
// missing converter rejects, so the copy's existence is what decides.
async function toPng($: EngineInterface, where: Dirs, n: number, path: string): Promise<string | null> {
  if (path.endsWith('.png')) return path
  const known = converted.get(path)
  if (known !== undefined) return known
  const out = `${where.converted}/${n}.png`
  if (!(await $.fs.exists(out))) {
    if (!(await $.fs.exists(where.converted))) await $.process.run(['mkdir', '-p', where.converted]).catch(() => undefined)
    for (const argv of converters(path, out)) {
      const ran = await $.process.run(argv).catch(() => undefined)
      if (ran?.exitCode === 0 && (await $.fs.exists(out))) break
    }
  }
  const result = (await $.fs.exists(out)) ? out : null
  converted.set(path, result)
  return result
}

async function describe($: EngineInterface, where: Dirs | undefined, n: number): Promise<PastedImage> {
  const path = where === undefined ? undefined : await cached($, where, n)
  if (where === undefined || path === undefined) return { n, path: null, png: null, size: null }
  const png = await toPng($, where, n, path)
  if (png === null) return { n, path, png: null, size: null }
  if (!sizes.has(png)) {
    const head = await $.fs.read(png, { as: 'bytes' }).then(
      ({ base64 }) => pngSize(base64),
      () => undefined, // too big to read: still drawable, just without its aspect ratio
    )
    if (head === null) return { n, path, png: null, size: null } // not a PNG after all
    sizes.set(png, head ?? null)
  }
  return { n, path, png, size: sizes.get(png) ?? null }
}

async function show($: EngineInterface, draft: string) {
  const numbers = imageNumbers(draft)
  const key = numbers.join(',')
  if (key === shownKey) return
  const where = numbers.length > 0 ? await dirs($) : undefined
  const list: PastedImage[] = []
  for (const n of numbers) list.push(await describe($, where, n))
  shownKey = list.every(image => image.path !== null) ? key : undefined
  await update($, images, () => list)
  // The enlarged image left the draft (sent, or its tag deleted): close its pane.
  const open = await read($, zoomed)
  if (open !== null && !numbers.includes(open)) await closeZoom($)
}

// Opens the pane as the press's own first call: anything awaited before $.ui.open loses
// the press, and the pane then counts as opened unasked (seated only from 144 columns).
// A pane that still can't be seated falls back to Preview, so a press always shows the picture.
async function zoom($: EngineInterface, image: PastedImage) {
  if (image.path === null) return
  // Nothing to draw in a pane: open the original as it is.
  if (image.png === null) {
    await $.process.run(['open', image.path])
    return
  }
  const opened = $.ui.open({ id: PANE, title: `Image #${image.n}`, focus: true, closeOnEscape: true, rows: 30 })
  await update($, zoomed, () => image.n)
  const result = await opened.catch(() => undefined)
  if (result?.isPlaced !== true) {
    await $.ui.close({ id: PANE })
    await update($, zoomed, () => null)
    await $.process.run(['open', image.path])
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
    if (n === null || image === undefined || image.path === null || image.png === null) {
      return <Text dimColor>No image to show.</Text>
    }
    const { columns, rows } = fitPane(image.size, e.props.scroll.bodyRows - PANE_CHROME_ROWS, e.props.bodyColumns)
    const path = image.path
    const size = image.size === null ? '' : `  ${image.size.width}×${image.size.height}`
    return (
      <Box flexDirection="column">
        <Image key={`zoom-${n}`} source={{ file: image.png, format: 'png' }} columns={columns} rows={rows} alt={`[Image #${n}]`} />
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
                {image.png === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                ) : (
                  <Image
                    key={`image-${image.n}`}
                    source={{ file: image.png, format: 'png' }}
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
                    onPress={() => void zoom($, image)}
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
