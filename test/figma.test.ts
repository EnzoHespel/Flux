import { describe, expect, it } from 'vitest'
import { figmaKey, figmaRef, figmaTeamIds } from '../src/shared/figma'
import type { Topic } from '../src/shared/types'
import { isLinkedRef, reconcile } from '../src/main/engine/ball'
import { itemFromFigmaFile, type FigmaFile } from '../src/main/engine/rank'
import { promptFor } from '../src/main/threads/actions'
import { failureOf } from '../src/main/sources/failure'
import { checkFigma, FigmaError, FigmaScanner, mentions, readThreads, type RawFigmaComment } from '../src/main/sources/figma'
import { projectTrackers } from '../src/shared/trackers'
import { displayTitle, refLabel } from '../src/renderer/src/format'

const NOW = new Date('2026-11-16T12:00:00Z')
const ME = { id: 'me', handle: 'Gérome' }
const PIERRE = { id: 'p', handle: 'Pierre Aldebert' }
const CAMILLE = { id: 'c', handle: 'Camille' }

let sequence = 0
const comment = (
  user: { id: string; handle: string } | null,
  message: string,
  createdAt: string,
  overrides: Partial<RawFigmaComment> = {},
): RawFigmaComment => ({
  id: String(++sequence),
  parent_id: '',
  user,
  created_at: createdAt,
  resolved_at: null,
  message,
  ...overrides,
})

describe('commentaires Figma qui m’attendent', () => {
  it('reconnaît mon nom écrit en clair, sans accent ni casse, mais pas un autre mot', () => {
    expect(mentions('gerome tu valides ?', 'Gérome')).toBe(true)
    expect(mentions('Vu avec Gérome, ok', 'Gérome')).toBe(true)
    expect(mentions('Géromette a validé', 'Gérome')).toBe(false)
    expect(mentions('rien pour toi', 'Gérome')).toBe(false)
  })

  it('garde un fil où l’on m’a répondu ou nommé, et le lâche quand je réponds ou qu’il est résolu', () => {
    const asked = comment(ME, 'Pierre Aldebert pourquoi l’impression horizontale ?', '2026-11-16T09:00:00Z')
    const answer = comment(PIERRE, 'Pour la lisibilité sur tablette', '2026-11-16T10:00:00Z', { parent_id: asked.id })
    const named = comment(CAMILLE, 'gerome tu peux regarder le bouton ?', '2026-11-15T08:00:00Z')
    const replied = comment(CAMILLE, 'Gérome ok pour toi ?', '2026-11-14T08:00:00Z')
    const done = comment(ME, 'oui', '2026-11-14T09:00:00Z', { parent_id: replied.id })
    const resolved = comment(PIERRE, 'Gérome à valider', '2026-11-13T08:00:00Z', { resolved_at: '2026-11-13T09:00:00Z' })
    const others = comment(PIERRE, 'inverser nom et heure', '2026-11-12T08:00:00Z')
    const old = comment(CAMILLE, 'Gérome ?', '2026-09-01T08:00:00Z')

    const { involved, pending } = readThreads(
      'KEY',
      [answer, asked, named, replied, done, resolved, others, old],
      ME,
      NOW,
    )
    expect(involved).toBe(true)
    expect(pending).toEqual([
      {
        id: asked.id,
        author: 'Pierre Aldebert',
        excerpt: 'Pour la lisibilité sur tablette',
        at: '2026-11-16T10:00:00Z',
        url: `https://www.figma.com/file/KEY#${asked.id}`,
      },
      expect.objectContaining({ id: named.id, author: 'Camille' }),
    ])
  })

  it('ne retient rien d’un fichier où personne ne me parle', () => {
    expect(readThreads('KEY', [comment(PIERRE, 'pour les aidants ?', '2026-11-16T08:00:00Z')], ME, NOW)).toEqual({
      involved: false,
      pending: [],
    })
  })
})

describe('une tâche par fichier Figma', () => {
  const file = (pending: FigmaFile['pending']): FigmaFile => ({
    key: 'phQPUDMN',
    name: 'app_aidant',
    url: 'https://www.figma.com/file/phQPUDMN',
    readAt: NOW.toISOString(),
    involved: true,
    pending,
  })
  const line = (id: string, at: string) => ({ id, author: 'Pierre', excerpt: '…', at, url: `https://www.figma.com/file/phQPUDMN#${id}` })

  it('compte les commentaires, attend depuis le plus ancien et notifie au plus récent', () => {
    const item = itemFromFigmaFile(file([line('2', '2026-11-16T10:00:00Z'), line('1', '2026-11-14T10:00:00Z')]))
    expect(item).toMatchObject({ ref: 'figma:phQPUDMN', kind: 'figma', title: 'app_aidant', ball: 'me', terminal: false })
    expect(item.comments).toHaveLength(2)
    expect(item.signals).toEqual([
      expect.objectContaining({
        id: 'figma:phQPUDMN:comments',
        rank: 3,
        detail: '2 commentaires Figma',
        action: 'figma',
        since: '2026-11-14T10:00:00Z',
        stamp: '2026-11-16T10:00:00Z',
      }),
    ])
    expect(promptFor('figma', item.ref, item.url)).toBeUndefined()
  })

  it('ouvre un sujet pour le fichier, puis le ferme quand tout est répondu', () => {
    const waiting = itemFromFigmaFile(file([line('1', '2026-11-16T10:00:00Z')]))
    const first = reconcile([], [waiting], [], NOW)
    expect(first.created.map(topic => [topic.title, topic.links])).toEqual([['figma:phQPUDMN — app_aidant', ['figma:phQPUDMN']]])
    expect(displayTitle(first.created[0].title)).toBe('App_aidant')
    const topic: Topic = first.created[0]
    expect(reconcile([topic], [itemFromFigmaFile(file([]))], [], NOW).closed).toEqual([topic.id])
  })

  it('montre « Figma » plutôt que la clef, et lit une ref Figma', () => {
    expect(refLabel('figma:phQPUDMN')).toBe('Figma')
    expect(refLabel('daca#1553')).toBe('daca#1553')
    expect(isLinkedRef(figmaRef('phQPUDMN'))).toBe(true)
    expect(figmaKey('figma:phQPUDMN')).toBe('phQPUDMN')
    expect(figmaKey('OFF-917')).toBeNull()
  })

  it('tire les équipes d’un lien Figma, sans prendre l’id d’utilisateur', () => {
    expect(
      figmaTeamIds('https://www.figma.com/files/team/704360851569708857/recents?fuid=446329420676600936, 123456'),
    ).toEqual(['704360851569708857', '123456'])
    expect(figmaTeamIds('https://www.figma.com/files/team/1/x\n https://www.figma.com/files/team/1/y')).toEqual(['1'])
  })
})

describe('lecture progressive de Figma', () => {
  // A fake Figma answering by path, recording each request
  function figma(routes: Record<string, () => Response>) {
    const calls: string[] = []
    const http = (async (input: string | URL | Request) => {
      const path = String(input).replace('https://api.figma.com', '')
      calls.push(path)
      const route = routes[path]
      return route ? route() : new Response('{}', { status: 404 })
    }) as typeof fetch
    return { calls, http }
  }
  const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })
  const recent = '2026-11-10T08:00:00Z'
  // The v2 shapes: a team's folders, then a folder's files
  const routes = {
    '/v1/me': json({ id: 'me', handle: 'Gérome' }),
    '/v2/teams/T/folders': json({ name: 'Ouihelp', folders: [{ id: '42', name: 'App', parent_folder_id: null }] }),
    '/v2/folders/42/files': json({
      name: 'App',
      files: [
        { key: 'A', name: 'app_aidant', thumbnail_url: '', last_modified: recent },
        { key: 'B', name: 'vieux', thumbnail_url: '', last_modified: '2025-01-01T00:00:00Z' },
      ],
    }),
    '/v1/files/A/comments': json({ comments: [comment(PIERRE, 'Gérome tu valides ?', '2026-11-16T08:00:00Z')] }),
    '/v1/files/OLD/comments': json({ comments: [] }),
  }

  it('découvre l’équipe puis lit les commentaires, trois requêtes par tour', async () => {
    const { calls, http } = figma(routes)
    const scanner = new FigmaScanner(null, http)
    expect(await scanner.step('token', ['T'], [], NOW)).toEqual([])
    expect(calls).toEqual(['/v1/me', '/v2/teams/T/folders', '/v2/folders/42/files'])
    const files = await scanner.step('token', ['T'], [], new Date(NOW.getTime() + 60_000))
    // The old file is never read; the recent one is
    expect(calls.slice(3)).toEqual(['/v1/files/A/comments'])
    expect(files.map(file => [file.key, file.name, file.pending.length])).toEqual([['A', 'app_aidant', 1]])
  })

  it('ne relit les commentaires d’un fichier qu’au bout de cinq minutes', async () => {
    const { calls, http } = figma(routes)
    const scanner = new FigmaScanner(null, http)
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)
    await scanner.step('token', ['T'], [], NOW)
    await scanner.step('token', ['T'], [], at(1))
    for (const minutes of [2, 3, 4, 5]) await scanner.step('token', ['T'], [], at(minutes))
    expect(calls.slice(3)).toEqual(['/v1/files/A/comments'])
    await scanner.step('token', ['T'], [], at(6))
    expect(calls.slice(3)).toEqual(['/v1/files/A/comments', '/v1/files/A/comments'])
  })

  it('lit d’abord un fichier suivi par un sujet, même ancien, et se tait après un 429', async () => {
    const limited = {
      ...routes,
      '/v1/files/A/comments': () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
    }
    const { calls, http } = figma(limited)
    const scanner = new FigmaScanner(null, http)
    await scanner.step('token', ['T'], ['OLD'], NOW)
    const files = await scanner.step('token', ['T'], ['OLD'], new Date(NOW.getTime() + 60_000))
    expect(calls.slice(3)).toEqual(['/v1/files/OLD/comments', '/v1/files/A/comments'])
    // Followed, it comes back even without comments, so its topic can close
    expect(files.map(file => [file.key, file.pending.length])).toEqual([['OLD', 0]])
    await scanner.step('token', ['T'], ['OLD'], new Date(NOW.getTime() + 120_000))
    expect(calls).toHaveLength(5)
  })

  it('signale un jeton sans accès aux commentaires', async () => {
    const refused = { ...routes, '/v1/files/A/comments': () => new Response('{}', { status: 403 }) }
    const { http } = figma(refused)
    const scanner = new FigmaScanner(null, http)
    await scanner.step('token', ['T'], [], NOW)
    await expect(scanner.step('token', ['T'], [], new Date(NOW.getTime() + 60_000))).rejects.toThrow('Jeton Figma refusé')
  })

  it('dit qu’il manque un droit, et pas que le jeton est refusé, quand Figma parle de scope', async () => {
    const scope = () =>
      new Response(JSON.stringify({ status: 403, err: 'Invalid scope(s): folders:read. This endpoint requires the folders:read scope' }), {
        status: 403,
      })
    const { http } = figma({ ...routes, '/v2/teams/T/folders': scope })
    const failed = await new FigmaScanner(null, http).step('token', ['T'], [], NOW).catch(error => error as FigmaError)
    expect(failed).toBeInstanceOf(FigmaError)
    expect(failed).toMatchObject({ message: 'Il manque un droit au jeton Figma', access: true, scope: true })
    expect(failureOf(failed)).toBe('access')
  })
})

describe('Figma comme outil', () => {
  const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })
  const answer = (routes: Record<string, () => Response>) =>
    (async (input: string | URL | Request) =>
      routes[String(input).replace('https://api.figma.com', '')]?.() ??
      new Response('{}', { status: 404 })) as typeof fetch

  it('vérifie le jeton puis chaque équipe', async () => {
    const http = answer({
      '/v1/me': json({ id: 'me', handle: 'Gérome' }),
      '/v2/teams/T/folders': json({ name: 'Ouihelp', folders: [{ id: '1' }, { id: '2' }] }),
    })
    expect(await checkFigma(' token ', ['T'], http)).toEqual({
      ok: true,
      detail: 'Connecté en tant que Gérome · 2 projets dans l’équipe',
    })
    expect((await checkFigma('token', ['T', 'X'], http)).detail).toContain('ne lit pas l’équipe X')
    expect(await checkFigma('token', [], http)).toMatchObject({ ok: false })
    expect(await checkFigma('token', ['T'], answer({ '/v1/me': () => new Response('{}', { status: 403 }) }))).toEqual({
      ok: false,
      detail: 'Figma refuse ce jeton.',
    })
    const noFolders = answer({
      '/v1/me': json({ id: 'me', handle: 'Gérome' }),
      '/v2/teams/T/folders': () => new Response('{"status":403,"err":"Invalid scope"}', { status: 403 }),
    })
    expect((await checkFigma('token', ['T'], noFolders)).detail).toContain('folders:read')
  })

  it('ne fait pas d’espace de Figma', () => {
    expect(projectTrackers(['figma', 'linear', 'jira'])).toEqual(['linear', 'jira'])
  })
})

describe('pourquoi une source échoue', () => {
  it('ne dit hors ligne que quand le réseau manque', () => {
    expect(failureOf(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }))).toBe('network')
    expect(failureOf(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe(
      'network',
    )
    expect(failureOf(new FigmaError(403))).toBe('access')
    expect(failureOf(new Error('Linear 401'))).toBe('access')
    expect(failureOf(new Error('GitHub 502'))).toBe('other')
  })
})
