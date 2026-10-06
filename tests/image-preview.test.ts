import { expect, mock, test } from 'claude-code/testing'

import { fitCells, fitRow, imageNumbers, pngSize } from '../hooks/layout'

function pngHead(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return btoa(String.fromCharCode(...bytes))
}

test('image numbers come from the draft, deduplicated, in order', () => {
  expect(imageNumbers('look [Image #2] and [Image #1] again [Image #2]')).toEqual([2, 1])
  expect(imageNumbers('[Image 1] [image #3] #4')).toEqual([])
})

test('PNG size is read from the IHDR header', () => {
  expect(pngSize(pngHead(1630, 632))).toEqual({ width: 1630, height: 632 })
  expect(pngSize(btoa('\xff\xd8\xff\xe0 this is a jpeg, not a png...'))).toBeNull()
})

test('thumbnails keep aspect ratio within the tile', () => {
  // Square: 6 rows tall, twice as many columns because cells are tall.
  expect(fitCells({ width: 500, height: 500 })).toEqual({ columns: 12, rows: 6 })
  // Very wide: capped at 32 columns, rows shrink to match.
  expect(fitCells({ width: 3000, height: 500 })).toEqual({ columns: 32, rows: 3 })
  // Very tall: never narrower than 4 columns.
  expect(fitCells({ width: 100, height: 2000 })).toEqual({ columns: 4, rows: 6 })
})

test('a row of tiles shrinks to fit the band so it never scrolls', () => {
  const square = { width: 500, height: 500 }
  // Plenty of room: full 6-row tiles.
  expect(fitRow([square], 20, 120)).toEqual([{ columns: 12, rows: 6 }])
  // A short band: border and label take 3 rows, so the picture gets the rest.
  expect(fitRow([square], 7, 120)).toEqual([{ columns: 8, rows: 4 }])
  // A narrow band: three 6-row squares need 3 * 14 + 2 = 44 columns; 40 forces 5 rows.
  expect(fitRow([square, square, square], 20, 40)).toEqual([
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
  ])
})

const BAND = {
  plugin: 'image-preview',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('a pasted image shows without another keystroke and clears when the draft does', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-1/images'
  let draft = 'see [Image #1] [Image #2]'
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', () => ({ value: '/tmp/claude-501' }))
  on('session.id', () => ({ value: 'sess-1' }))
  // Another project's folder and a stray file sit beside the one holding this session.
  const entry = { size: 0, mtimeMs: 0, isLink: false }
  on('fs.list', () => ({
    value: [
      { name: '-other', kind: 'dir', ...entry },
      { name: 'notes.txt', kind: 'file', ...entry },
      { name: '-work', kind: 'dir', ...entry },
    ],
  }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { file: `${dir}/1.png`, format: 'png' }, columns: 24, rows: 6 })
  // #2 has no cached file, so it gets a placeholder tile instead of a broken Image.
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()
  await ui.unmount()

  // Sending the prompt empties the box.
  draft = ''
  await clock.advance(200)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Image' })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('pressing a thumbnail enlarges it in a pane, which closes when its tag leaves the draft', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-1/images'
  let draft = 'see [Image #1]'
  const opened: string[] = []
  const closed: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', () => ({ value: '/tmp/claude-501' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'zoom-1' })
  expect(opened).toEqual(['image-preview'])
  await band.unmount()

  const pane = await $.ui.mount({
    plugin: 'image-preview',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'image-preview',
    viewport: { columns: 120, rows: 40 },
    props: { title: 'Image #1', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const big = await pane.find({ type: 'Image' })
  // 800×400 at two rows per cell height: capped by the 100-column body, rows follow the aspect.
  expect(big?.props).toMatchObject({ source: { file: `${dir}/1.png`, format: 'png' }, columns: 100, rows: 25 })
  await pane.unmount()

  draft = ''
  await clock.advance(200)
  expect(closed).toEqual(['image-preview'])
})

test('a pane that cannot be seated falls back to opening the picture in Preview', async ($, on) => {
  const clock = mock.clock(on)
  const dir = '/tmp/claude-501/-work/sess-1/images'
  const draft = 'see [Image #1]'
  const ran: string[][] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('env.get', () => ({ value: '/tmp/claude-501' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', () => ({ value: [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', ($, e) => ({ value: e.path === dir || e.path === `${dir}/1.png` }))
  on('fs.read', () => ({ value: { base64: pngHead(800, 400) } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'unasked below 144 columns' } }))
  on('ui.close', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'zoom-1' })
  expect(ran).toContainEqual(['open', `${dir}/1.png`])
  await band.unmount()
})
