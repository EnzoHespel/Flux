import { describe, expect, it } from 'vitest'
import type { AppState, Item, Rank, TopicView } from '../src/shared/types'
import {
  listOf,
  menuOfLine,
  menuOfView,
  resolveRoute,
  searchFlux,
  tabFor,
} from '../src/renderer/src/navigation'

function item(ref: string, url: string, overrides: Partial<Item> = {}): Item {
  return { ref, refs: [ref], kind: 'pr', title: ref, url, terminal: false, ball: 'others', mine: false, signals: [], ...overrides }
}

function view(id: string, title: string, links: string[], overrides: Partial<TopicView> = {}): TopicView {
  return {
    topic: { id, title, status: 'open', links, threads: [], createdAt: '2026-11-10T09:00:00Z', body: '' },
    items: [],
    signals: [],
    threads: [],
    rank: null,
    ball: 'others',
    stage: 'untouched',
    mine: true,
    since: null,
    actions: [],
    ...overrides,
  }
}

const review = (rank: Rank, detail: string) => ({
  id: `s:${rank}`,
  rank,
  weight: 0,
  detail,
  since: '2026-11-10T09:00:00Z',
  stamp: '2026-11-10T09:00:00Z',
  action: 'review' as const,
})

const pr = item('daca#1553', 'https://github.com/acme/daca/pull/1553')
const ticket = item('OFF-917', 'https://linear.app/acme/issue/OFF-917', { kind: 'ticket' })

const started = view('t-queue', 'daca#1553 — feat(recueil): signature de l’aidant', ['daca#1553', 'OFF-917'], {
  items: [pr, ticket],
  rank: 2,
  signals: [review(2, 'Review demandée par nicolas')],
  stage: 'started',
})
const note = view('t-note', 'Relire le cadrage outbox', [], { rank: 6, ball: 'me' })
note.topic.body = 'Penser à la démo de jeudi'

// Assigned to me and in technical review: in the file, but with another reviewer
const held = view('t-held', 'TG-930 — Export des factures', ['TG-930'], {
  rank: 3,
  ball: 'me',
  stage: 'held',
  signals: [review(3, 'Technical review')],
})

const state = {
  queue: [started, held, note],
  // A thread runs on the first topic of the file
  active: [started],
  waiting: [view('t-wait', 'hb#7010 — Écran du recueil', ['hb#7010'], { mine: false })],
  dormant: [],
  loose: [item('ONL-3511', 'https://linear.app/acme/issue/ONL-3511', { kind: 'ticket', title: 'Sujet du triage' })],
} as unknown as AppState

describe('liens vers Flux', () => {
  it('ouvre un sujet par sa ref, quelle que soit la casse, ou par son id', () => {
    expect(resolveRoute(state, { kind: 'ref', ref: 'off-917' })).toEqual({ tab: 'queue', selected: 't-queue' })
    expect(resolveRoute(state, { kind: 'topic', id: 't-wait' })).toEqual({ tab: 'waiting', selected: 't-wait' })
    expect(resolveRoute(state, { kind: 'tab', tab: 'daily' })).toEqual({ tab: 'daily', selected: null })
  })

  it('retrouve en Attente un ticket qu’aucun sujet ne tient, et rien pour un sujet disparu', () => {
    expect(resolveRoute(state, { kind: 'ref', ref: 'ONL-3511' })).toEqual({ tab: 'waiting', selected: 'loose:ONL-3511' })
    expect(tabFor(state, 'loose:ONL-3511')).toBe('waiting')
    expect(resolveRoute(state, { kind: 'ref', ref: 'APP-1' })).toBeNull()
    expect(resolveRoute(state, { kind: 'topic', id: 'clos' })).toBeNull()
  })

  it('copie les sources d’un sujet et son lien par la première ref, une note par son id', () => {
    expect(menuOfView(state.queue[0])).toEqual({
      sources: [
        { ref: 'daca#1553', url: 'https://github.com/acme/daca/pull/1553' },
        { ref: 'OFF-917', url: 'https://linear.app/acme/issue/OFF-917' },
      ],
      flux: 'flux://ref/daca%231553',
    })
    expect(menuOfView(note).flux).toBe('flux://topic/t-note')
  })

  it('ne propose le lien Flux d’une ligne du daily que tant que son sujet vit', () => {
    const line = { live: true, topicId: 't-queue', refs: [{ ref: 'daca#1553', url: 'https://github.com/acme/daca/pull/1553' }], url: null }
    expect(menuOfLine(line).flux).toBe('flux://ref/daca%231553')
    expect(menuOfLine({ ...line, live: false }).flux).toBeNull()
    expect(menuOfLine({ live: false, topicId: null, ref: 'aura#220', url: 'https://github.com/acme/aura/pull/220' })).toEqual({
      sources: [{ ref: 'aura#220', url: 'https://github.com/acme/aura/pull/220' }],
      flux: null,
    })
  })
})

describe('recherche ⌘K', () => {
  const ids = (query: string) => searchFlux(state, query).map(result => result.id)

  it('liste tout Flux dans l’ordre des onglets sans requête', () => {
    expect(ids('')).toEqual(['t-queue', 't-held', 't-note', 't-wait', 'loose:ONL-3511'])
  })

  it('trouve par ref, par titre sans accents, par détail et par corps de note', () => {
    expect(ids('1553')).toEqual(['t-queue'])
    expect(ids('daca#15')).toEqual(['t-queue'])
    expect(ids('ecran recueil')).toEqual(['t-wait'])
    expect(ids('nicolas')).toEqual(['t-queue'])
    expect(ids('démo')).toEqual(['t-note'])
    // The visible title wins over a commit prefix the title hides
    expect(ids('recueil')).toEqual(['t-wait', 't-queue'])
  })

  it('classe une ref avant un titre et propose les pages', () => {
    const results = searchFlux(state, 'off')
    expect(results.map(result => result.id)).toEqual(['t-queue'])
    expect(searchFlux(state, 'da').map(result => [result.kind, result.id])).toEqual([
      ['page', 'page:daily'],
      ['topic', 't-queue'],
    ])
  })
})

describe('onglets', () => {
  it('ne garde dans À démarrer que les sujets de la file où rien n’est fait', () => {
    expect(listOf(state, 'unstarted').map(entry => entry.topic.id)).toEqual(['t-note'])
  })

  it('range en Attente un sujet de la file bloqué ou chez un autre relecteur, mon travail d’abord', () => {
    expect(listOf(state, 'waiting').map(entry => entry.topic.id)).toEqual(['t-held', 't-wait'])
    expect(tabFor(state, 't-held', 'waiting')).toBe('waiting')
    expect(tabFor(state, 't-held', 'unstarted')).toBe('queue')
  })

  it('reste sur En cours quand on y choisit un sujet aussi dans la file', () => {
    expect(tabFor(state, 't-queue', 'active')).toBe('active')
    expect(tabFor(state, 't-note', 'unstarted')).toBe('unstarted')
    // Elsewhere, the topic opens in its first tab
    expect(tabFor(state, 't-queue', 'daily')).toBe('queue')
    expect(tabFor(state, 't-wait', 'active')).toBe('waiting')
  })

  it('ouvre l’onglet À démarrer par son lien', () => {
    expect(resolveRoute(state, { kind: 'tab', tab: 'unstarted' })).toEqual({ tab: 'unstarted', selected: null })
  })
})
