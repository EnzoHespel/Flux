import { describe, expect, it } from 'vitest'
import { PullBoard } from '../src/main/engine/pulls'
import type { PullRequest } from '../src/main/engine/rank'

const NOW = new Date('2026-11-16T12:00:00Z')

const pr = (overrides: Partial<PullRequest>): PullRequest => ({
  repo: 'daca',
  number: 1,
  title: 'feat: outbox',
  url: 'https://example.test/daca/pull/1',
  state: 'OPEN',
  isDraft: false,
  updatedAt: '2026-11-16T09:00:00Z',
  mergedAt: null,
  headRefName: 'feature/off-1',
  reviewDecision: 'REVIEW_REQUIRED',
  mergeStateStatus: 'CLEAN',
  author: 'gerome',
  ci: 'SUCCESS',
  lastCommitAt: '2026-11-16T08:00:00Z',
  viewerReview: null,
  reviewedAt: null,
  reviewRequested: false,
  requestedAt: null,
  pendingReview: null,
  threads: [],
  ...overrides,
})

describe('mes PR, tous projets confondus', () => {
  it('dit où en est chaque PR, la plus récente d’abord', async () => {
    const pulls = [
      pr({ number: 1, updatedAt: '2026-11-15T09:00:00Z' }),
      pr({ repo: 'aura', number: 7, isDraft: true }),
      pr({ number: 3, reviewDecision: 'APPROVED', updatedAt: '2026-11-14T09:00:00Z' }),
      pr({ number: 4, ci: 'FAILURE', updatedAt: '2026-11-13T09:00:00Z' }),
      pr({
        number: 5,
        updatedAt: '2026-11-12T09:00:00Z',
        threads: [{ resolved: false, firstAuthor: 'nicolas', lastAuthor: 'nicolas', lastAt: '2026-11-12T09:00:00Z' }],
      }),
      pr({ number: 6, state: 'MERGED' }),
    ]
    const board = new PullBoard(async () => ({ me: 'gerome', pullRequests: pulls }), () => new Set())
    const { pulls: read, error } = await board.get(null, false, NOW)
    expect(error).toBeNull()
    expect(read.map(pull => [pull.ref, pull.status, pull.rank])).toEqual([
      ['aura#7', 'Pas encore en review', null],
      ['daca#1', 'En attente de review', null],
      ['daca#3', 'Prêt à merger', 4],
      ['daca#4', 'CI en échec', 6],
      ['daca#5', '1 retour de nicolas', 1],
    ])
  })

  it('répond du cache deux minutes, relit sur demande, et garde la liste quand GitHub échoue', async () => {
    let calls = 0
    let fail = false
    const board = new PullBoard(async () => {
      calls += 1
      if (fail) throw new Error('GitHub 502')
      return { me: 'gerome', pullRequests: [pr({})] }
    }, () => new Set())
    await board.get(null, false, NOW)
    await board.get(null, false, new Date(NOW.getTime() + 60_000))
    expect(calls).toBe(1)
    await board.get(null, true, new Date(NOW.getTime() + 60_000))
    expect(calls).toBe(2)
    fail = true
    const failed = await board.get(null, false, new Date(NOW.getTime() + 300_000))
    expect(failed).toMatchObject({ error: 'GitHub 502', at: new Date(NOW.getTime() + 60_000).toISOString() })
    expect(failed.pulls).toHaveLength(1)
    // Another account never answers from the first one's list
    fail = false
    await board.get('autre', false, new Date(NOW.getTime() + 300_000))
    expect(calls).toBe(4)
  })
})
