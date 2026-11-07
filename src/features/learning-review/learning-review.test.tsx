// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApprovedLearning } from '@/domain'
import { sampleLearning, sampleRevision, sampleTrip } from '@/domain/samples'

import type { CandidatesResult } from './api-client'
import { LearningReview, type RequestCandidates } from './learning-review'

afterEach(() => {
  cleanup()
})

const NOW = new Date('2026-11-08T10:00:00+09:00')
const proposed: CandidatesResult = { ok: true, learnings: [sampleLearning] }

const setup = (
  result: CandidatesResult = proposed,
  props: Partial<React.ComponentProps<typeof LearningReview>> = {},
) => {
  const request = vi.fn<RequestCandidates>().mockResolvedValue(result)
  const onApprovedChange = vi.fn<(approved: ApprovedLearning[]) => void>()
  const user = userEvent.setup()
  render(
    <LearningReview
      trip={sampleTrip}
      requestCandidates={request}
      now={() => NOW}
      onApprovedChange={onApprovedChange}
      {...props}
    />,
  )
  return { request, onApprovedChange, user }
}

const feedback = () => screen.getByLabelText(/感想・変更した理由/)
const makeButton = () => screen.getByRole('button', { name: /学びの候補を作/ })

const generate = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(feedback(), '昼食後は休みたかった')
  await user.click(makeButton())
  await screen.findByRole('heading', { name: /学びの候補（/ })
}

describe('LearningReview: 候補の作成', () => {
  it('初期表示では、承認済みの学びは0件で、保存されないことを案内する', () => {
    setup()
    expect(screen.getByRole('heading', { name: '承認済みの学び（0件）' })).toBeTruthy()
    expect(screen.getByText(/まだ保存されません/)).toBeTruthy()
  })

  it('感想を送って候補を作る。候補は未承認で、承認済みには入らない', async () => {
    const { request, onApprovedChange, user } = setup()
    await generate(user)

    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toMatchObject({
      trip: sampleTrip,
      feedback: '昼食後は休みたかった',
    })
    expect(screen.getByText('未承認')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '承認済みの学び（0件）' })).toBeTruthy()
    expect(onApprovedChange).toHaveBeenLastCalledWith([])
  })

  it('候補が出たら、見出しへフォーカスを移す', async () => {
    const { user } = setup()
    await generate(user)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: /学びの候補（/ })),
    )
  })

  it('材料（感想も承認済みの変更）が無いときは、ボタンは押せて、AIを呼ばず感想欄を示す', async () => {
    const { request, user } = setup()
    const button = makeButton()
    expect(button.getAttribute('aria-disabled')).toBeNull()

    await user.click(button)

    expect(request).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('感想を入力')
    expect(feedback().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(feedback())
  })

  it('承認した変更があれば、感想が空でも作成できる', async () => {
    const approvedRevision = {
      ...sampleRevision,
      approval: { status: 'approved' as const, decidedAt: '2026-11-08T11:50:00+09:00' },
    }
    const { request, user } = setup(proposed, { revisions: [approvedRevision] })

    await user.click(makeButton())

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('未承認の変更しか無いときは、材料にならないと案内する', async () => {
    const { request, user } = setup(proposed, { revisions: [sampleRevision] })
    expect(screen.getByText(/未承認または却下（学びの材料にしません）/)).toBeTruthy()

    await user.click(makeButton())

    expect(request).not.toHaveBeenCalled()
  })

  it('感想が長すぎるときは、AIを呼ばずに案内する', async () => {
    const { request, user } = setup()
    await user.click(feedback())
    await user.paste('あ'.repeat(1001))
    await user.click(makeButton())

    expect(request).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('1000文字以内')
  })

  it('失敗したら理由を示し、入力した感想は残す', async () => {
    const { user } = setup({
      ok: false,
      failure: { kind: 'external_service_error', message: 'AIに接続できませんでした。' },
    })
    await user.type(feedback(), '昼食後は休みたかった')
    await user.click(makeButton())

    expect((await screen.findByRole('alert')).textContent).toContain('AIに接続できませんでした。')
    expect((feedback() as HTMLTextAreaElement).value).toBe('昼食後は休みたかった')
    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
  })

  it('生成中は二重に送信しない', async () => {
    let resolve: (value: CandidatesResult) => void = () => undefined
    const request = vi.fn<RequestCandidates>(
      () => new Promise<CandidatesResult>((r) => (resolve = r)),
    )
    const user = userEvent.setup()
    render(<LearningReview trip={sampleTrip} requestCandidates={request} />)
    await user.type(feedback(), '感想')
    await user.click(makeButton())
    await user.click(screen.getByRole('button', { name: /作っています/ }))

    expect(request).toHaveBeenCalledTimes(1)
    resolve(proposed)
    await screen.findByRole('heading', { name: /学びの候補（/ })
  })
})

describe('LearningReview: 承認・却下・編集', () => {
  it('承認すると承認済みの一覧に入り、承認済みだけが通知される', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)

    await user.click(screen.getByRole('button', { name: '承認する' }))

    expect(screen.getByRole('heading', { name: '承認済みの学び（1件）' })).toBeTruthy()
    const last = onApprovedChange.mock.lastCall?.[0] ?? []
    expect(last).toHaveLength(1)
    expect(last[0].approval).toEqual({ status: 'approved', decidedAt: NOW.toISOString() })
  })

  it('却下した学びは承認済みに入らない。取り消すと未承認に戻る', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)

    await user.click(screen.getByRole('button', { name: '却下する' }))
    expect(screen.getAllByText('却下').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: '承認済みの学び（0件）' })).toBeTruthy()
    expect(onApprovedChange).toHaveBeenLastCalledWith([])

    await user.click(screen.getByRole('button', { name: '却下を取り消す' }))
    expect(screen.getByText('未承認')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '承認済みの学び（0件）' })).toBeTruthy()
  })

  it('内容を編集してから承認すると、編集後の内容が承認される', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    const content = screen.getByLabelText('学びの内容')
    await user.clear(content)
    await user.type(content, '昼食の候補は2つ用意したい')

    await user.click(screen.getByRole('button', { name: '承認する' }))

    const approved = onApprovedChange.mock.lastCall?.[0] ?? []
    expect(approved[0].content).toBe('昼食の候補は2つ用意したい')
  })

  it('適用範囲を「すべての旅行」に変えて承認できる', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    await user.selectOptions(screen.getByLabelText('適用範囲'), 'all_trips')

    await user.click(screen.getByRole('button', { name: '承認する' }))

    expect((onApprovedChange.mock.lastCall?.[0] ?? [])[0].scope).toEqual({ kind: 'all_trips' })
  })

  it('内容を空にしたまま承認しようとすると、承認されず理由が出る', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    await user.clear(screen.getByLabelText('学びの内容'))

    await user.click(screen.getByRole('button', { name: '承認する' }))

    expect(screen.getByText('学びの内容を入力してください')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '承認済みの学び（0件）' })).toBeTruthy()
    expect(onApprovedChange).toHaveBeenLastCalledWith([])
  })

  it('承認したあとに内容を変えて承認し直すと、新しい内容に置き換わる', async () => {
    const { onApprovedChange, user } = setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))

    const content = screen.getByLabelText('学びの内容')
    await user.clear(content)
    await user.type(content, '昼食は予約しておく')
    expect(screen.getByRole('button', { name: '承認する' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '承認する' }))

    const approved = onApprovedChange.mock.lastCall?.[0] ?? []
    expect(approved).toHaveLength(1)
    expect(approved[0].content).toBe('昼食は予約しておく')
  })

  it('承認済みの一覧には、内容と適用範囲が表示される', async () => {
    const { user } = setup()
    await generate(user)
    await user.click(screen.getByRole('button', { name: '承認する' }))

    const section = screen.getByRole('heading', { name: '承認済みの学び（1件）' }).parentElement
    expect(section).not.toBeNull()
    expect(within(section as HTMLElement).getByText(/昼食の営業情報を当日確認し/)).toBeTruthy()
    expect(within(section as HTMLElement).getByText(/東山エリア|の旅行/)).toBeTruthy()
  })
})
