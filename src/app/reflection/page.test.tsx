// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision, sampleTrip } from '@/domain/samples'
import { getAuthHeaders, initializeAnonymousSession } from '@/lib/auth/client'

import ReflectionPage from './page'

// 認証（Firebase）だけを差し替える。ページ・ReflectionFlow・LearningReviewは本物を使う。
vi.mock('@/lib/auth/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/client')>()),
  getAuthHeaders: vi.fn(),
  initializeAnonymousSession: vi.fn(),
  startNewAnonymousSession: vi.fn(),
}))

const info = { returned: 1, skippedInvalid: 0, truncated: false }
const respond = (body: unknown) => new Response(JSON.stringify(body))

// 保存済みの旅程が1件だけある保存先。
const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
  const path = String(input)
  if (path === '/api/trips') return respond({ trips: [sampleTrip], listInfo: info })
  if (path.endsWith('/revisions')) {
    return respond({ revisions: [sampleRevision], listInfo: info })
  }
  if (path === '/api/learnings')
    return respond({ learnings: [], listInfo: { ...info, returned: 0 } })
  return respond({ trip: sampleTrip })
})

beforeEach(() => {
  vi.stubGlobal('fetch', fetchFn)
  vi.mocked(getAuthHeaders).mockImplementation(async () => new Headers({ Authorization: 'x' }))
  vi.mocked(initializeAnonymousSession).mockResolvedValue({ uid: 'user-1', isAnonymous: true })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const renderPage = async (searchParams: { tripId?: string; demo?: string }) =>
  render(await ReflectionPage({ searchParams: Promise.resolve(searchParams) }))

describe('/reflection のページ', () => {
  it('?demo=1 だけは、架空デモと明示し、保存先へつながず、保存の操作も出さない', async () => {
    await renderPage({ demo: '1' })

    expect(screen.getByRole('note').textContent).toContain('デモ用の想定です')
    expect(screen.getByRole('note').textContent).toContain('架空')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('振り返りの確認ページ')
    // 架空の旅程（サンプル）でLearningReviewを開く。保存の接続（store）は渡さない。
    expect(screen.getByRole('button', { name: '学びの候補を作る' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /保存する/ })).toBeNull()
    expect(document.body.textContent).toContain('承認した内容は、いまはこの画面の中だけにあり')
    // 本人の保存済みの旅程には触れない（認証も通信もしない）。
    expect(fetchFn).not.toHaveBeenCalled()
    expect(initializeAnonymousSession).not.toHaveBeenCalled()
    expect(screen.queryByText('保存済みの旅行')).toBeNull()
  })

  it('通常は、本人の保存済み旅程の振り返りを開き、架空デモの注記は出さない', async () => {
    await renderPage({})

    expect(await screen.findByRole('button', { name: /振り返る/ })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('保存した旅行を振り返る')
    expect(screen.queryByRole('note')).toBeNull()
    expect(fetchFn).toHaveBeenCalledWith('/api/trips', expect.any(Object))
  })

  it.each(['0', '', 'true'])('demo=%s はデモにしない（1のときだけデモ）', async (demo) => {
    await renderPage({ demo })

    expect(await screen.findByRole('button', { name: /振り返る/ })).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('tripId は表示する旅行の指定にだけ使い、保存済みの旅行にあるときだけ選ぶ', async () => {
    await renderPage({ tripId: sampleTrip.id })
    const button = await screen.findByRole('button', { name: /振り返る/ })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByRole('button', { name: '学びの候補を作る' })).toBeTruthy()
    cleanup()

    await renderPage({ tripId: 'trip-not-owned' })
    const other = await screen.findByRole('button', { name: /振り返る/ })
    expect(other.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('button', { name: '学びの候補を作る' })).toBeNull()
  })
})
