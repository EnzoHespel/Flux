import type { SourceFailure } from '../../shared/types'

// What a failed source reads from the network once it is back
const NETWORK =
  /fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up/i

// Why a source failed, for the top bar: off the network, refused (a token or a right to fix in the
// settings), or anything else the source answered
export function failureOf(error: unknown): SourceFailure {
  if (!(error instanceof Error)) return 'other'
  if ((error as { access?: unknown }).access === true || /\b40[13]\b/.test(error.message)) return 'access'
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause
  const causeText = `${String(cause?.code ?? '')} ${String(cause?.message ?? '')}`
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'network'
  return NETWORK.test(error.message) || NETWORK.test(causeText) ? 'network' : 'other'
}
