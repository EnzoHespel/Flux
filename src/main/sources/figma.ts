import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CheckResult, CommentLine } from '../../shared/types'
import type { FigmaFile } from '../engine/rank'

// Routes carry their version: the v1 project routes need a scope new tokens can no longer get, the
// v2 folder routes (a folder is a project in Figma's interface) read with folders:read
const API = 'https://api.figma.com'
const DAY_MS = 86_400_000
// Files edited within this window are read; an older one only while its topic is open
const RECENT_DAYS = 60
const MAX_RECENT_FILES = 40
// A comment older than this no longer waits on you
const PENDING_DAYS = 30
const FOLDERS_EVERY_MS = 6 * 3_600_000
const LISTING_EVERY_MS = 3_600_000
// A file you have a topic or a pending comment on is read again after this, ahead of the others
const PRIORITY_EVERY_MS = 5 * 60_000
// Requests per tick of a minute. Comments, folders and file listings allow 5 a minute
// to a View or Collab seat, 25 and more to a Full or Dev seat
const BUDGET = { low: 3, high: 12 } as const
const EXCERPT_LENGTH = 110

export interface RawFigmaComment {
  id: string
  // Empty on the comment that starts a thread
  parent_id: string
  user: { id: string; handle: string } | null
  created_at: string
  resolved_at: string | null
  message: string
}

export interface FigmaMe {
  id: string
  handle: string
}

export function fileUrl(key: string): string {
  return `https://www.figma.com/file/${key}`
}

// Figma opens the file on the comment named by the fragment
export function commentUrl(key: string, commentId: string): string {
  return `${fileUrl(key)}#${commentId}`
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// Figma writes a mention as the plain name, without @ or markup
export function mentions(message: string, handle: string): boolean {
  const name = fold(handle).trim()
  if (!name) return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(fold(message))
}

function excerpt(text: string): string {
  const flat = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat
}

// A thread waits on me when someone wrote after my last message in it, or named me and I never
// answered; it stops waiting once I reply or the thread is resolved
export function readThreads(
  key: string,
  comments: RawFigmaComment[],
  me: FigmaMe,
  now: Date,
): { involved: boolean; pending: CommentLine[] } {
  const threads = new Map<string, RawFigmaComment[]>()
  for (const comment of comments) {
    const root = comment.parent_id || comment.id
    threads.set(root, [...(threads.get(root) ?? []), comment])
  }
  const limit = new Date(now.getTime() - PENDING_DAYS * DAY_MS).toISOString()
  const mine = (comment: RawFigmaComment) => comment.user?.id === me.id
  const named = (comment: RawFigmaComment) =>
    comment.user !== null && !mine(comment) && mentions(comment.message, me.handle)
  let involved = false
  const pending: CommentLine[] = []
  for (const [root, unsorted] of threads) {
    const thread = [...unsorted].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const wrote = thread.some(mine)
    if (wrote || thread.some(named)) involved = true
    const first = thread.find(comment => comment.id === root) ?? thread[0]
    if (first.resolved_at) continue
    const start = wrote ? thread.map(mine).lastIndexOf(true) + 1 : thread.findIndex(named)
    if (start < 0) continue
    const waiting = thread.slice(start).filter(comment => comment.user !== null && !mine(comment))
    const latest = waiting[waiting.length - 1]
    if (!latest || latest.created_at < limit) continue
    pending.push({
      id: root,
      author: latest.user?.handle ?? 'Quelqu’un',
      excerpt: excerpt(latest.message),
      at: latest.created_at,
      url: commentUrl(key, root),
    })
  }
  pending.sort((a, b) => b.at.localeCompare(a.at))
  return { involved, pending }
}

interface Listing {
  at: number
  files: Array<{ key: string; name: string; lastModified: string }>
}

interface ScanState {
  // Token and teams the state was read with: another account starts over
  signature: string
  me: FigmaMe | null
  folders: { at: number; ids: string[] } | null
  listings: Record<string, Listing>
  files: Record<string, FigmaFile>
  // After a 429, nothing is asked before this time
  pausedUntil: number
}

const emptyState = (signature: string): ScanState => ({
  signature,
  me: null,
  folders: null,
  listings: {},
  files: {},
  pausedUntil: 0,
})

// The step's request budget is spent
class Spent extends Error {}

// A refused request: a token Figma no longer takes, or one without the scope the route needs.
// Either way the fix is in the settings, which access says
export class FigmaError extends Error {
  readonly access: boolean

  constructor(
    readonly status: number,
    readonly scope = false,
  ) {
    const access = status === 401 || status === 403
    super(scope ? 'Il manque un droit au jeton Figma' : access ? 'Jeton Figma refusé' : `Figma ${status}`)
    this.access = access
  }
}

// Figma answers 403 both to a refused token and to one missing a scope; only the body tells
async function missingScope(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  const body = await response.text().catch(() => '')
  return /scope/i.test(body)
}

type Get = <T>(path: string) => Promise<T>

// Reads your profile, then each team's projects: a token and teams the scanner can start from
export async function checkFigma(
  token: string,
  teams: string[],
  http: typeof fetch = (input, init) => fetch(input, init),
): Promise<CheckResult> {
  if (!token.trim() || teams.length === 0) {
    return { ok: false, detail: 'Il faut le lien de ton équipe et le jeton.' }
  }
  const get = (path: string) =>
    http(`${API}${path}`, {
      headers: { 'X-Figma-Token': token.trim() },
      signal: AbortSignal.timeout(15_000),
    })
  try {
    const me = await get('/v1/me')
    if (await missingScope(me)) return { ok: false, detail: 'Il manque le droit current_user:read à ce jeton.' }
    if (me.status === 401 || me.status === 403) return { ok: false, detail: 'Figma refuse ce jeton.' }
    if (me.status === 429) return { ok: false, detail: 'Figma limite les requêtes : réessaie dans une minute.' }
    if (!me.ok) return { ok: false, detail: `Figma répond ${me.status}.` }
    const { handle } = (await me.json()) as FigmaMe
    let projects = 0
    for (const team of teams) {
      const response = await get(`/v2/teams/${team}/folders`)
      if (await missingScope(response)) {
        return { ok: false, detail: 'Il manque le droit folders:read à ce jeton : sans lui, Flux ne voit pas les projets.' }
      }
      if (response.status === 403 || response.status === 404) {
        return { ok: false, detail: `Ce jeton ne lit pas l’équipe ${team} : vérifie le lien de l’équipe.` }
      }
      if (response.status === 429) return { ok: false, detail: 'Figma limite les requêtes : réessaie dans une minute.' }
      if (!response.ok) return { ok: false, detail: `Figma répond ${response.status}.` }
      projects += ((await response.json()) as { folders: unknown[] }).folders.length
    }
    const where = teams.length === 1 ? 'dans l’équipe' : `dans ${teams.length} équipes`
    return { ok: true, detail: `Connecté en tant que ${handle} · ${projects} projets ${where}` }
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
}

// Reads the comments of a team's recent files a few requests per tick: Figma has no notification
// inbox, and a View seat gets five requests a minute
export class FigmaScanner {
  private state: ScanState
  private budget: number = BUDGET.low

  constructor(
    private readonly file: string | null,
    private readonly http: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.state = this.load()
  }

  // The files that involve me, plus the ones an open topic follows, as Figma last answered
  async step(token: string, teams: string[], followed: string[], now: Date): Promise<FigmaFile[]> {
    const signature = `${createHash('sha256').update(token).digest('hex').slice(0, 16)}|${teams.join(',')}`
    if (signature !== this.state.signature) this.state = emptyState(signature)
    if (now.getTime() >= this.state.pausedUntil) {
      try {
        await this.read(this.client(token, now), teams, followed, now)
      } catch (error) {
        if (!(error instanceof Spent)) {
          await this.save()
          throw error
        }
      }
      await this.save()
    }
    return this.snapshot(followed)
  }

  private client(token: string, now: Date): Get {
    let left = this.budget
    return async <T>(path: string): Promise<T> => {
      if (left <= 0) throw new Spent()
      left -= 1
      const response = await this.http(`${API}${path}`, {
        headers: { 'X-Figma-Token': token },
        signal: AbortSignal.timeout(30_000),
      })
      const seat = response.headers.get('x-figma-rate-limit-type')
      if (seat === 'low' || seat === 'high') this.budget = BUDGET[seat]
      if (response.status === 429) {
        const wait = Number(response.headers.get('retry-after')) || 60
        this.state.pausedUntil = now.getTime() + wait * 1000
        throw new Spent()
      }
      if (!response.ok) throw new FigmaError(response.status, await missingScope(response))
      return (await response.json()) as T
    }
  }

  private async read(get: Get, teams: string[], followed: string[], now: Date): Promise<void> {
    const state = this.state
    const at = now.getTime()
    if (!state.me) {
      const me = await get<FigmaMe>('/v1/me')
      state.me = { id: String(me.id), handle: me.handle }
    }
    // Every folder of the team, nested ones included, each listing only its own files
    if (!state.folders || at - state.folders.at > FOLDERS_EVERY_MS) {
      const ids: string[] = []
      for (const team of teams) {
        const data = await get<{ folders: Array<{ id: string | number }> }>(`/v2/teams/${team}/folders`)
        ids.push(...data.folders.map(folder => String(folder.id)))
      }
      state.folders = { at, ids }
      for (const id of Object.keys(state.listings)) if (!ids.includes(id)) delete state.listings[id]
    }

    // One folder listing per tick at most, so comments keep flowing while the team is discovered
    const stale = state.folders.ids
      .filter(id => !state.listings[id] || at - state.listings[id].at > LISTING_EVERY_MS)
      .sort((a, b) => (state.listings[a]?.at ?? 0) - (state.listings[b]?.at ?? 0))[0]
    if (stale) {
      const data = await get<{ files: Array<{ key: string; name: string; last_modified: string }> }>(
        `/v2/folders/${stale}/files`,
      )
      state.listings[stale] = {
        at,
        files: data.files.map(file => ({ key: file.key, name: file.name, lastModified: file.last_modified })),
      }
    }

    const listed = Object.values(state.listings).flatMap(listing => listing.files)
    const names = new Map(listed.map(file => [file.key, file.name]))
    const recent = listed
      .filter(file => at - Date.parse(file.lastModified) <= RECENT_DAYS * DAY_MS)
      .sort((a, b) => b.lastModified.localeCompare(a.lastModified))
      .slice(0, MAX_RECENT_FILES)
      .map(file => file.key)
    const priority = new Set([
      ...followed,
      ...Object.values(state.files)
        .filter(file => file.pending.length > 0)
        .map(file => file.key),
    ])
    const keys = [...new Set([...priority, ...recent])]
    for (const key of Object.keys(state.files)) {
      if (!keys.includes(key)) delete state.files[key]
    }
    const readAt = (key: string) => state.files[key]?.readAt ?? ''
    const due = keys
      .filter(key => !priority.has(key) || !state.files[key] || at - Date.parse(readAt(key)) >= PRIORITY_EVERY_MS)
      .sort((a, b) => Number(priority.has(b)) - Number(priority.has(a)) || readAt(a).localeCompare(readAt(b)))

    let read = 0
    let refused: FigmaError[] = []
    try {
      for (const key of due) {
        const name = names.get(key) ?? state.files[key]?.name ?? key
        const base = { key, name, url: fileUrl(key), readAt: now.toISOString() }
        try {
          const data = await get<{ comments: RawFigmaComment[] }>(`/v1/files/${key}/comments`)
          read += 1
          state.files[key] = { ...base, ...readThreads(key, data.comments, state.me, now) }
        } catch (error) {
          // A deleted file, or one you lost access to, waits on no one
          if (!(error instanceof FigmaError) || (error.status !== 404 && error.status !== 403)) throw error
          read += 1
          if (error.status === 403) refused = [...refused, error]
          state.files[key] = { ...base, involved: false, pending: [] }
        }
      }
    } finally {
      // Every file refused: the token lacks the comments scope, which must show
      if (read > 0 && refused.length === read) throw refused[refused.length - 1]
    }
  }

  private snapshot(followed: string[]): FigmaFile[] {
    return Object.values(this.state.files).filter(file => file.involved || followed.includes(file.key))
  }

  private load(): ScanState {
    if (!this.file || !existsSync(this.file)) return emptyState('')
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ScanState> & { projects?: unknown }
      // Read through the v1 project routes: the listings start over from the folders
      if ('projects' in saved) return emptyState('')
      return { ...emptyState(''), ...saved }
    } catch {
      return emptyState('')
    }
  }

  private async save(): Promise<void> {
    if (!this.file) return
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 })
    await rename(temporary, this.file)
  }
}
