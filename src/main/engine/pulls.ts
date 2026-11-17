import type { MyPull, MyPulls } from '../../shared/types'
import { prRef, pullStatus, type PullRequest, type RankContext } from './rank'

const TTL_MS = 2 * 60_000

export function myPull(pr: PullRequest, ctx: RankContext): MyPull {
  return {
    ref: prRef(pr.repo, pr.number),
    repo: pr.repo,
    title: pr.title,
    url: pr.url,
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft,
    ci: pr.ci,
    ...pullStatus(pr, ctx),
  }
}

type Fetch = (account: string | null) => Promise<{ me: string; pullRequests: PullRequest[] }>

// My open PRs across every project, read on demand: the tab asks at each sync, GitHub at most
// every couple of minutes, and a failure keeps the last list with its error
export class PullBoard {
  private last: { at: number; account: string | null; value: MyPulls } | null = null
  private pending: Promise<MyPulls> | null = null

  constructor(
    private readonly fetch: Fetch,
    private readonly noReview: () => Set<string>,
  ) {}

  get(account: string | null, force: boolean, now = new Date()): Promise<MyPulls> {
    const last = this.last?.account === account ? this.last : null
    if (!force && last && now.getTime() - last.at < TTL_MS) return Promise.resolve(last.value)
    this.pending ??= this.read(account, now, last?.value ?? null).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async read(account: string | null, now: Date, previous: MyPulls | null): Promise<MyPulls> {
    try {
      const { me, pullRequests } = await this.fetch(account)
      const context = { me, now, noReview: this.noReview() }
      const pulls = pullRequests
        .filter(pr => pr.state === 'OPEN')
        .map(pr => myPull(pr, context))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const value = { at: now.toISOString(), pulls, error: null }
      this.last = { at: now.getTime(), account, value }
      return value
    } catch (error) {
      return { at: previous?.at ?? null, pulls: previous?.pulls ?? [], error: (error as Error).message }
    }
  }
}
