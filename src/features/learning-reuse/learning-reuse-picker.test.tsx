// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleApprovedLearning, sampleLearning } from '@/domain/samples'
import { approveLearning } from '@/lib/learnings/lifecycle'

import { LearningReusePicker, type LoadLearningOptions } from './learning-reuse-picker'

afterEach(cleanup)

const approvedRegional = approveLearning(
  { ...sampleLearning, scope: { kind: 'region', region: '京都市' } },
  '2026-11-08T20:00:00+09:00',
)
const records = [
  { version: 1, learning: sampleApprovedLearning },
  { version: 1, learning: approvedRegional },
]
const loaded: LoadLearningOptions = async () => ({ ok: true, items: records })

describe('学びの選択UI', () => {
  it('すべての地域と同じ地域の学びだけを選択できる', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    render(
      <LearningReusePicker region="京都市" load={loaded} onSelectionChange={onSelectionChange} />,
    )

    expect(await screen.findByText(approvedRegional.content)).toBeTruthy()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    await user.click(boxes[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith([approvedRegional.id])
    await user.click(boxes[0])
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      approvedRegional.id,
      sampleApprovedLearning.id,
    ])
    await user.click(boxes[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith([sampleApprovedLearning.id])
  })

  it('地域が変わると古い選択を破棄し、地域外の学びを表示しない', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const view = render(
      <LearningReusePicker region="京都市" load={loaded} onSelectionChange={onSelectionChange} />,
    )
    await screen.findByText(approvedRegional.content)
    await user.click(screen.getAllByRole('checkbox')[1])
    view.rerender(
      <LearningReusePicker region="奈良市" load={loaded} onSelectionChange={onSelectionChange} />,
    )
    await waitFor(() => expect(screen.queryByText(approvedRegional.content)).toBeNull())
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(onSelectionChange).toHaveBeenLastCalledWith([])
  })

  it('APIが失敗したら選択を持ち越さず、再試行できる', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const load = vi
      .fn<LoadLearningOptions>()
      .mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: '停止中です。' })
      .mockResolvedValueOnce({ ok: true, items: records })
    render(
      <LearningReusePicker region="京都市" load={load} onSelectionChange={onSelectionChange} />,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('停止中です。')
    await user.click(screen.getByRole('button', { name: '再読み込み' }))
    expect(await screen.findByText(approvedRegional.content)).toBeTruthy()
    expect(onSelectionChange).toHaveBeenLastCalledWith([])
  })

  it('地域外だけなら学びなしと明示する', async () => {
    const load: LoadLearningOptions = async () => ({
      ok: true,
      items: [{ version: 1, learning: approvedRegional }],
    })
    render(<LearningReusePicker region="奈良市" load={load} />)
    expect(await screen.findByText(/今回の地域に使える、承認済みの学びはありません/)).toBeTruthy()
  })
})
