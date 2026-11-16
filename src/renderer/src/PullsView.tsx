import {
  CircleCheck,
  CircleDashed,
  CircleX,
  GitPullRequest,
  GitPullRequestDraft,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import type { MyPull, MyPulls } from '../../shared/types'
import { clock, waitingFor } from './format'
import { showMenu } from './navigation'
import { rankStyle } from './rankStyle'

// Repos by their latest update, so the busiest project comes first
function byRepo(pulls: MyPull[]): Array<{ repo: string; pulls: MyPull[] }> {
  const groups = new Map<string, MyPull[]>()
  for (const pull of pulls) groups.set(pull.repo, [...(groups.get(pull.repo) ?? []), pull])
  return [...groups.entries()].map(([repo, list]) => ({ repo, pulls: list }))
}

function Checks({ ci }: { ci: string | null }) {
  if (ci === 'SUCCESS') return <CircleCheck size={16} className="pull-ci ok" aria-label="CI verte" />
  if (ci === 'FAILURE' || ci === 'ERROR') return <CircleX size={16} className="pull-ci fail" aria-label="CI en échec" />
  if (ci === 'PENDING' || ci === 'EXPECTED') {
    return <LoaderCircle size={16} className="pull-ci" aria-label="CI en cours" />
  }
  return <CircleDashed size={16} className="pull-ci" aria-label="Sans CI" />
}

// Open or draft, in GitHub's words, as on its own badge
function State({ draft }: { draft: boolean }) {
  const Icon = draft ? GitPullRequestDraft : GitPullRequest
  return (
    <span className={`pull-state${draft ? ' draft' : ''}`}>
      <Icon size={12} strokeWidth={2.4} aria-hidden="true" />
      {draft ? 'Draft' : 'Open'}
    </span>
  )
}

function subtitle(board: MyPulls | null): string {
  if (!board) return 'Lecture de GitHub…'
  const count = board.pulls.length
  const open = count === 0 ? 'Aucune PR ouverte' : `${count} PR ouverte${count > 1 ? 's' : ''}, tous projets confondus`
  return board.at ? `${open} · synchro de ${clock(board.at)}` : open
}

export function PullsView({
  board,
  loading,
  onRefresh,
}: {
  board: MyPulls | null
  loading: boolean
  onRefresh(): void
}) {
  return (
    <main className="page">
      <div className="page-column wrapup">
        <header className="daily-head">
          <div>
            <h1>Mes PR</h1>
            <p>{subtitle(board)}</p>
          </div>
          <div className="daily-actions">
            <button type="button" className="pill glass small" disabled={loading} onClick={onRefresh}>
              <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
              Actualiser
            </button>
          </div>
        </header>

        {board?.error && <p className="wrapup-empty">GitHub n’a pas répondu : {board.error}</p>}

        {byRepo(board?.pulls ?? []).map(group => (
          <section className="wrapup-section" key={group.repo} aria-label={group.repo}>
            <h2>
              {group.repo}
              <span className="count">{group.pulls.length}</span>
            </h2>
            <ul className="checklist">
              {group.pulls.map(pull => (
                <li
                  key={pull.ref}
                  className="check-row pull-row"
                  onContextMenu={event =>
                    showMenu(event, { sources: [{ ref: pull.ref, url: pull.url }], flux: null })
                  }
                >
                  <Checks ci={pull.ci} />
                  <State draft={pull.isDraft} />
                  <button
                    type="button"
                    className="check-main"
                    title="Ouvrir sur GitHub"
                    onClick={() => void window.flux.openExternal(pull.url)}
                  >
                    <span className="check-title">
                      <span className="check-ref">#{pull.ref.split('#')[1]}</span>
                      {pull.title}
                    </span>
                    <span
                      className="check-meta pull-status"
                      style={pull.rank === null ? undefined : { color: rankStyle(pull.rank).light }}
                    >
                      {pull.status}
                    </span>
                  </button>
                  <span className="check-side" title={`Mise à jour il y a ${waitingFor(pull.updatedAt)}`}>
                    {waitingFor(pull.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}
