export type PastedImage = {
  n: number
  /** The cached paste as Claude Code saved it (.png, .jpg, .gif, .webp...); null when it can't be found. */
  path: string | null
  /** A PNG of it for the Image element: `path` itself, or a converted copy; null when no converter could read it. */
  png: string | null
  /** Pixel size; null when unknown, and the tile falls back to a default shape. */
  size: { width: number; height: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'image-preview': { images: PastedImage[]; zoomed: number | null }
  }
}
