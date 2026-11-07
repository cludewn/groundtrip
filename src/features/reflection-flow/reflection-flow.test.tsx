// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleApprovedLearning, sampleRevision, sampleTrip } from '@/domain/samples'
import { initializeAnonymousSession, startNewAnonymousSession } from '@/lib/auth/client'

import {
  createFirestoreLearningStore,
  loadReflectionHistory,
  loadSavedLearnings,
  loadSavedTrips,
} from './api-client'
import { ReflectionFlow } from './reflection-flow'

vi.mock('@/lib/auth/client', () => ({
  initializeAnonymousSession: vi.fn(),
  startNewAnonymousSession: vi.fn(),
}))
vi.mock('./api-client', () => ({
  loadSavedTrips: vi.fn(),
  loadReflectionHistory: vi.fn(),
  loadSavedLearnings: vi.fn(),
  createFirestoreLearningStore: vi.fn(() => ({ save: vi.fn() })),
}))
vi.mock('@/features/learning-review/learning-review', () => ({
  LearningReview: ({ trip }: { trip: typeof sampleTrip }) => (
    <div data-testid="learning-review">実旅程：{trip.id}</div>
  ),
}))

const listInfo = { returned: 1, skippedInvalid: 0, truncated: false }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(initializeAnonymousSession).mockResolvedValue({ uid: 'user-1', isAnonymous: true })
  vi.mocked(startNewAnonymousSession).mockResolvedValue({ uid: 'new-user', isAnonymous: true })
  vi.mocked(loadSavedTrips).mockResolvedValue({ trips: [sampleTrip], listInfo })
  vi.mocked(loadReflectionHistory).mockResolvedValue({
    trip: sampleTrip,
    revisions: [sampleRevision],
  })
  vi.mocked(loadSavedLearnings).mockResolvedValue({
    learnings: [{ version: 1, learning: sampleApprovedLearning }],
    listInfo,
  })
})
afterEach(cleanup)

describe('ReflectionFlow', () => {
  it('既存匿名セッションの復元に成功したときだけ本人のTripを選択して表示する', async () => {
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    const button = await screen.findByRole('button', { name: /振り返る/ })
    expect(screen.queryByTestId('learning-review')).toBeNull()
    await user.click(button)
    expect((await screen.findByTestId('learning-review')).textContent).toContain(
      '実旅程：trip-demo',
    )
    expect(loadReflectionHistory).toHaveBeenCalledWith(sampleTrip.id, expect.any(Object))
    expect(screen.getByText(sampleApprovedLearning.content)).toBeTruthy()
    expect(createFirestoreLearningStore).toHaveBeenCalled()
  })

  it('保存済みの旅行がない場合は架空サンプルを実データとして表示しない', async () => {
    vi.mocked(loadSavedTrips).mockResolvedValue({
      trips: [],
      listInfo: { ...listInfo, returned: 0 },
    })
    render(<ReflectionFlow />)
    expect(await screen.findByText('保存された旅行がありません。')).toBeTruthy()
    expect(screen.queryByTestId('learning-review')).toBeNull()
  })

  it('認証失敗で勝手に新しいUIDを発行しない。明示ボタンを押した場合だけ開始する', async () => {
    vi.mocked(initializeAnonymousSession).mockRejectedValue(new Error('認証を復元できません'))
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    expect((await screen.findByRole('alert')).textContent).toContain('認証を復元できません')
    expect(startNewAnonymousSession).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '新しい利用を始める' }))
    await screen.findByRole('button', { name: /振り返る/ })
    expect(startNewAnonymousSession).toHaveBeenCalledTimes(1)
  })

  it('変更履歴の取得が失敗したら学び候補の画面を開始しない', async () => {
    vi.mocked(loadReflectionHistory).mockRejectedValue(new Error('履歴が不完全です'))
    render(<ReflectionFlow initialTripId={sampleTrip.id} />)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('履歴が不完全です')
    })
    expect(screen.queryByTestId('learning-review')).toBeNull()
  })

  it('保存済み学びの取得が失敗した場合も、保存できたと見せない', async () => {
    vi.mocked(loadSavedLearnings).mockRejectedValue(new Error('保存先の応答がありません'))
    render(<ReflectionFlow initialTripId={sampleTrip.id} />)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('保存先の応答がありません')
    })
    expect(screen.queryByText(sampleApprovedLearning.content)).toBeNull()
  })
})
