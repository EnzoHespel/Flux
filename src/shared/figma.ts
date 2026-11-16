// A Figma file in Flux: one ref per file, whatever its comments
const FIGMA_REF = /^figma:([A-Za-z0-9]+)$/

export function figmaRef(key: string): string {
  return `figma:${key}`
}

export function figmaKey(ref: string): string | null {
  return FIGMA_REF.exec(ref)?.[1] ?? null
}

// Team links (figma.com/files/team/123…/…) or bare team ids, separated by spaces, commas or lines;
// the other numbers of a link, like ?fuid=, are not teams
export function figmaTeamIds(text: string): string[] {
  const ids = text.split(/[\s,;]+/).flatMap(token => {
    const linked = /team\/(\d+)/.exec(token)?.[1]
    if (linked) return [linked]
    return /^\d+$/.test(token) ? [token] : []
  })
  return [...new Set(ids)]
}
