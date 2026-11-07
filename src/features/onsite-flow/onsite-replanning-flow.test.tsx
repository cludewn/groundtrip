// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'
import type { Trip } from '@/domain'
import type { ApplyRevision, GenerateRevisions } from '@/features/revision-review/api-client'

import { OnSiteReplanningFlow } from './onsite-replanning-flow'

afterEach(() => cleanup())

const goToLunch = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: '次の予定へ進む' }))
  await user.click(screen.getByRole('button', { name: '予定が変わった？この予定だけ変更する' }))
}

const submitReport = async (
  user: ReturnType<typeof userEvent.setup>,
  kind: 'actual' | 'simulated',
) => {
  await user.click(screen.getByRole('radio', { name: /閉店・臨時休業だった/ }))
  await user.click(
    screen.getByRole('radio', {
      name: kind === 'actual' ? /いまの現地の状況（実際の報告）/ : /デモ用の模擬報告/,
    }),
  )
  await user.click(
    screen.getByRole('button', {
      name: kind === 'actual' ? '実際の報告として送る' : '模擬報告として送る',
    }),
  )
}

describe('現地報告から再計画', () => {
  it('旅行中に固定でない予定を報告し、on_site文脈で既存の部分修正APIへ渡す', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue({ status: 'no_candidates' })
    const original = structuredClone(sampleTrip)
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} />)

    // 固定予定は選べず、手動進行した昼食から現地報告を開始する。
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
    await goToLunch(user)
    expect(screen.getByText('現地の状況を報告する')).toBeTruthy()

    await submitReport(user, 'actual')
    expect(screen.getByText('現地の報告内容')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '現地の報告内容' }) as HTMLTextAreaElement).readOnly)
      .toBe(true)
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    const [request] = generate.mock.calls[0]
    expect(request.targetStopId).toBe('stop-lunch')
    expect(request.context).toEqual({
      phase: 'on_site',
      report: { kind: 'actual', description: '閉店・臨時休業だった' },
    })
    expect(request.reason).toContain('閉店・臨時休業だった')
    expect(request.trip.stops.find((stop) => stop.id === 'stop-exhibition')?.isFixed).toBe(true)
    expect(sampleTrip).toEqual(original)

    // 成立する候補がなくても元の旅程を維持し、戻ったときの現在地点は昼食のまま。
    await waitFor(() => expect(screen.getByText(/条件に合う候補が見つかりませんでした/)).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    await user.click(screen.getByRole('button', { name: '旅行中の画面に戻る' }))
    expect(screen.getByText('旅行中の進行状況')).toBeTruthy()
    expect(screen.getByText('いまの予定').closest('section')?.textContent).toContain('昼食店A（架空）')
  })

  it('模擬報告は明示し、適用サービスが渡されても旅程の変更は許さない', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue({ status: 'no_candidates' })
    const apply = vi.fn<ApplyRevision>()
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} apply={apply} />)
    await goToLunch(user)
    await submitReport(user, 'simulated')
    expect(screen.getByText(/デモ用の想定です。現地で実際に起きたことではありません/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(generate.mock.calls[0][0].context).toEqual({
      phase: 'on_site',
      report: { kind: 'simulated', description: '閉店・臨時休業だった' },
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('途中で旅程が更新された場合は、古い報告による候補生成を許可しない', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>()
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} />)
    await goToLunch(user)
    await submitReport(user, 'actual')

    const updated: Trip = { ...sampleTrip, version: sampleTrip.version + 1 }
    rerender(<OnSiteReplanningFlow trip={updated} generate={generate} />)
    expect(screen.getByRole('alert').textContent).toContain('古い報告からの再計画を中止しました')
    expect(screen.queryByRole('button', { name: '変更候補を探す' })).toBeNull()
    expect(generate).not.toHaveBeenCalled()
  })

  it('候補生成サービス未接続時は操作できるかのように見せない', () => {
    render(<OnSiteReplanningFlow trip={sampleTrip} />)
    expect(screen.getByText(/候補生成サービスを接続すると利用できます/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
  })
})
