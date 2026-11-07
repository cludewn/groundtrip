// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision, sampleTrip } from '@/domain/samples'
import type { Trip } from '@/domain'
import type {
  ApplyRevision,
  GenerateRevisions,
  RevisionProposal,
} from '@/features/revision-review/api-client'

import { OnSiteReplanningFlow } from './onsite-replanning-flow'

afterEach(() => cleanup())

type User = ReturnType<typeof userEvent.setup>

const goToLunch = async (user: User) => {
  await user.click(screen.getByRole('button', { name: '次の予定へ進む' }))
  await user.click(screen.getByRole('button', { name: '予定が変わった？この予定だけ変更する' }))
}

const submitReport = async (user: User, kind: 'actual' | 'simulated') => {
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

// 成立（satisfied）する候補と、根拠になる比較データ。revision-route-view.test.tsx と同じ前提を使う。
const lunch = sampleTrip.stops[1]
const after = {
  ...sampleRevision.diff.after,
  placeId: 'test-place',
  evidence: (['place_identity', 'opening_hours'] as const).map((subject) => ({
    ...sampleRevision.diff.after.evidence[0],
    id: `test-${subject}`,
    subject,
    source: { kind: 'places' as const, label: 'Google Places' },
    status: 'consistent' as const,
    explanation: '候補の根拠',
  })),
}

function leg(fromStopId: string, toStopId: string, durationMinutes: number) {
  return {
    presence: 'segment',
    segment: {
      fromStopId,
      toStopId,
      status: 'known',
      mode: 'walk',
      durationMinutes,
      source: { kind: 'routes', label: 'Google Routes' },
      checkedAt: '2026-11-08T11:46:00+09:00',
      explanation: '構造化された移動時間',
    },
  } as const
}

const [morning, , exhibition] = sampleTrip.stops

// サーバーと同じく、依頼の理由と文脈をそのまま写した成立候補を返す。
const propose: GenerateRevisions = async (request): Promise<RevisionProposal> => ({
  status: 'proposed',
  revisions: [
    {
      ...sampleRevision,
      reason: request.reason,
      context: request.context,
      baseTripVersion: request.trip.version,
      diff: { before: lunch, after },
      constraintCheck: { status: 'satisfied', explanation: '固定展示に間に合う' },
    },
  ],
  comparisons: [
    {
      revisionId: sampleRevision.id,
      before: {
        fromPrevious: leg(morning.id, lunch.id, 10),
        toNext: leg(lunch.id, exhibition.id, 10),
      },
      after: {
        fromPrevious: leg(morning.id, lunch.id, 8),
        toNext: leg(lunch.id, exhibition.id, 6),
      },
    },
  ],
})

// 適用後の旅程。昼食だけが候補に置き換わる。
const savedTrip = (): Trip => {
  const saved = structuredClone({
    ...sampleTrip,
    version: 1,
    stops: sampleTrip.stops.with(1, after),
  })
  saved.stops[1].evidence[0].checkedAt = '2026-11-08T11:47:00+09:00'
  return saved
}

const openCandidates = async (user: User, kind: 'actual' | 'simulated') => {
  await goToLunch(user)
  await submitReport(user, kind)
  await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
  await screen.findByRole('table')
}

const approve = () => screen.getByRole<HTMLButtonElement>('button', { name: '承認して適用を依頼' })
const replanButton = () =>
  screen.getByRole('button', { name: '予定が変わった？この予定だけ変更する' })
const currentHeading = () => screen.getByRole('heading', { name: 'いまの予定' })
const reportHeading = () => screen.getByRole('heading', { name: '現地の状況を報告する' })
const currentStop = () => currentHeading().closest('section')?.textContent
// 導線全体の通知欄（先頭のライブリージョン）。子の画面にも別のstatusがあるため、位置で特定する。
const flowNotice = () => {
  const notice = screen.getByRole('region', { name: '旅行中の再計画' }).firstElementChild
  expect(notice?.getAttribute('role')).toBe('status')
  return notice as HTMLElement
}

describe('現地報告から再計画', () => {
  it('旅行中に固定でない予定を報告し、on_site文脈で既存の部分修正APIへ渡す', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue({
      status: 'no_candidates',
      message: '候補がありません',
    })
    const original = structuredClone(sampleTrip)
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} />)

    // 固定予定は選べず、手動進行した昼食から現地報告を開始する。
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
    await goToLunch(user)
    expect(screen.getByText('現地の状況を報告する')).toBeTruthy()

    await submitReport(user, 'actual')
    expect(screen.getByText('現地の報告内容')).toBeTruthy()
    expect(
      (screen.getByRole('textbox', { name: '現地の報告内容' }) as HTMLTextAreaElement).readOnly,
    ).toBe(true)
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
    await waitFor(() =>
      expect(screen.getByText(/条件に合う候補が見つかりませんでした/)).toBeTruthy(),
    )
    // 現地報告のときのボタン名は、実際の動作（報告画面へ戻る）を表す。
    expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '報告を見直す' }))
    expect(document.activeElement).toBe(reportHeading())
    await user.click(screen.getByRole('button', { name: '旅行中の画面に戻る' }))
    expect(screen.getByText('旅行中の進行状況')).toBeTruthy()
    expect(currentStop()).toContain('昼食店A（架空）')
    expect(document.activeElement).toBe(currentHeading())
  })

  it('模擬報告の候補は比較できても、承認しても適用サービスを呼ばず旅程を変えない', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>(propose)
    const apply = vi.fn<ApplyRevision>()
    const onTripChange = vi.fn()
    const original = structuredClone(sampleTrip)
    render(
      <OnSiteReplanningFlow
        trip={sampleTrip}
        generate={generate}
        apply={apply}
        onTripChange={onTripChange}
      />,
    )
    await goToLunch(user)
    await submitReport(user, 'simulated')
    expect(screen.getByText(/デモ用の想定です。現地で実際に起きたことではありません/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    await screen.findByRole('table')
    expect(generate.mock.calls[0][0].context).toEqual({
      phase: 'on_site',
      report: { kind: 'simulated', description: '閉店・臨時休業だった' },
    })

    // 候補は成立していても、承認の操作は適用に届かない。理由は「未接続」ではなく模擬報告と伝える。
    const note = document.getElementById(approve().getAttribute('aria-describedby') ?? '')
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    expect(note?.textContent).toBe('模擬報告のため適用できません。')
    expect(screen.queryByText(/未接続/)).toBeNull()
    approve().focus()
    await user.keyboard('{Enter}')
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
    expect(onTripChange).not.toHaveBeenCalled()
    expect(sampleTrip).toEqual(original)

    await user.click(screen.getByRole('button', { name: '報告を見直す' }))
    expect(onTripChange).not.toHaveBeenCalled()
  })

  it('実際の報告の承認は、on_site文脈つきで適用し、成功後に旅程を渡して進行画面へ戻る', async () => {
    const user = userEvent.setup()
    const saved = savedTrip()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'applied', trip: saved })
    const onTripChange = vi.fn()
    render(
      <OnSiteReplanningFlow
        trip={sampleTrip}
        generate={propose}
        apply={apply}
        onTripChange={onTripChange}
      />,
    )
    await openCandidates(user, 'actual')

    // 適用できる状態では、適用できない理由を出さない。
    expect(approve().getAttribute('aria-disabled')).toBe('false')
    expect(screen.queryByText(/適用できません|未接続/)).toBeNull()
    await user.click(approve())

    await waitFor(() => expect(onTripChange).toHaveBeenCalledTimes(1))
    expect(apply).toHaveBeenCalledTimes(1)
    const [decision] = apply.mock.calls[0]
    expect(decision.request.context).toEqual({
      phase: 'on_site',
      report: { kind: 'actual', description: '閉店・臨時休業だった' },
    })
    expect(decision.request.targetStopId).toBe('stop-lunch')
    expect(decision.request.reason).toContain('閉店・臨時休業だった')
    expect(decision.revision.id).toBe(sampleRevision.id)
    expect(onTripChange).toHaveBeenCalledWith(saved)

    // 進行画面へ戻り、置き換わった予定と通知を示し、フォーカスを「いまの予定」へ移す。
    expect(screen.getByRole('heading', { name: '旅行中の進行状況' })).toBeTruthy()
    expect(currentStop()).toContain(after.name)
    expect(flowNotice().textContent).toContain('承認した1件の変更を旅程に反映しました')
    expect(document.activeElement).toBe(currentHeading())
  })

  it('実際の報告でも、適用サービスが無ければ未接続と伝えて承認を送らない', async () => {
    const user = userEvent.setup()
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} />)
    await openCandidates(user, 'actual')
    expect(approve().getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('承認・適用サービスは未接続です。')).toBeTruthy()
    await user.click(approve())
    expect(screen.queryByText(/旅程に反映しました/)).toBeNull()
  })

  it('途中で旅程が更新された場合は、古い報告による候補生成を許可しない', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>()
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} />)
    await goToLunch(user)
    await submitReport(user, 'actual')

    const updated: Trip = { ...sampleTrip, version: sampleTrip.version + 1 }
    rerender(<OnSiteReplanningFlow trip={updated} generate={generate} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('古い報告からの再計画を中止しました')
    expect(alert.textContent).not.toContain('適用結果')
    // 比較画面が消えてフォーカスを失わないよう、通知へ移す。
    expect(document.activeElement).toBe(alert)
    expect(screen.queryByRole('button', { name: '変更候補を探す' })).toBeNull()
    expect(generate).not.toHaveBeenCalled()

    // 適用を送っていないので、戻れば通常どおり報告を始められる。
    await user.click(within(alert).getByRole('button', { name: '旅行中の画面に戻る' }))
    expect(document.activeElement).toBe(currentHeading())
    await user.click(replanButton())
    expect(document.activeElement).toBe(reportHeading())
  })

  it('適用の応答待ちに親が旅程を差し替えたら、結果不明として扱い、確認するまで再報告を始めさせない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const onTripChange = vi.fn()
    const { rerender } = render(
      <OnSiteReplanningFlow
        trip={sampleTrip}
        generate={propose}
        apply={apply}
        onTripChange={onTripChange}
      />,
    )
    await openCandidates(user, 'actual')
    await user.click(approve())
    expect(apply).toHaveBeenCalledTimes(1)

    // 送信済みの適用をサーバーが反映した可能性があるまま、親が旅程を差し替える。
    const latest: Trip = { ...sampleTrip, version: 1 }
    rerender(
      <OnSiteReplanningFlow
        trip={latest}
        generate={propose}
        apply={apply}
        onTripChange={onTripChange}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('適用結果を確認できませんでした')
    expect(alert.textContent).toContain('最新の旅程')
    expect(alert.textContent).not.toContain('古い報告からの再計画を中止しました')
    expect(document.activeElement).toBe(alert)

    // 戻っても結果不明の状態を消さない。確認を促す表示を残し、そこへフォーカスを移す。
    await user.click(within(alert).getByRole('button', { name: '旅行中の画面に戻る' }))
    const unresolved = screen.getByRole('note')
    expect(unresolved.textContent).toContain('適用結果を確認できていません')
    expect(document.activeElement).toBe(unresolved)
    expect(flowNotice().textContent).toContain('適用結果を確認できませんでした')

    // 確認するまでは報告を始めない。ボタンは押せて、理由を伝えて確認の欄へ戻す。
    await user.click(replanButton())
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
    const firstNotice = screen.getByText(/最新の旅程を確認してから、報告を始めてください。/, {
      selector: 'span',
    })
    expect(document.activeElement).toBe(unresolved)
    // 同じ文言が続いても、通知の要素を作り直して読み上げ直させる。
    await user.click(replanButton())
    const secondNotice = screen.getByText(/最新の旅程を確認してから、報告を始めてください。/, {
      selector: 'span',
    })
    expect(secondNotice).not.toBe(firstNotice)

    // 遅れて届いた応答は、旅程を置き換えない。
    await act(async () => pending.resolve({ status: 'applied', trip: savedTrip() }))
    expect(onTripChange).not.toHaveBeenCalled()
    expect(currentStop()).toContain('昼食店A（架空）')
    expect(screen.getByRole('note')).toBeTruthy()

    // 最新の旅程を確認した扱いにして、はじめて再報告を始められる。
    await user.click(screen.getByRole('button', { name: '最新の旅程を確認した' }))
    expect(screen.queryByRole('note')).toBeNull()
    expect(document.activeElement).toBe(currentHeading())
    await user.click(replanButton())
    expect(document.activeElement).toBe(reportHeading())
  })

  it('適用結果が不明なまま比較画面から戻っても、不明の状態を保つ', async () => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'uncertain' })
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} apply={apply} />)
    await openCandidates(user, 'actual')
    await user.click(approve())
    await user.click(await screen.findByRole('button', { name: '旅程を確認' }))

    expect(screen.getByRole('note').textContent).toContain('適用結果を確認できていません')
    expect(document.activeElement).toBe(screen.getByRole('note'))
    await user.click(replanButton())
    expect(screen.queryByRole('heading', { name: '現地の状況を報告する' })).toBeNull()
  })

  it('適用の応答待ちに、中身が同じで参照だけ違う旅程を渡されても、適用結果を巻き戻さない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const onTripChange = vi.fn()
    const props = { generate: propose, apply, onTripChange }
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} {...props} />)
    await openCandidates(user, 'actual')
    await user.click(approve())

    // 送信後に、親が同じ内容の旅程を別のオブジェクトとして渡し直す（比較は続けられる）。
    rerender(<OnSiteReplanningFlow trip={structuredClone(sampleTrip)} {...props} />)
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => pending.resolve({ status: 'applied', trip: savedTrip() }))
    expect(onTripChange).toHaveBeenCalledTimes(1)
    expect(currentStop()).toContain(after.name)

    // 親が旅程の更新を反映しないまま、さらに同じ内容を渡し直されても、適用後の表示を保つ。
    rerender(<OnSiteReplanningFlow trip={structuredClone(sampleTrip)} {...props} />)
    expect(currentStop()).toContain(after.name)
    // 親が適用後の旅程を渡せば、それに従う。
    rerender(<OnSiteReplanningFlow trip={savedTrip()} {...props} />)
    expect(currentStop()).toContain(after.name)
  })

  it('報告の入力中に旅程の版が変わったら、入力をリセットしたことを知らせる', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<OnSiteReplanningFlow trip={sampleTrip} generate={propose} />)
    await goToLunch(user)
    await user.type(screen.getByRole('textbox', { name: /補足/ }), '貼り紙があった')
    expect((screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement).value).toBe(
      '貼り紙があった',
    )

    rerender(<OnSiteReplanningFlow trip={{ ...sampleTrip, version: 1 }} generate={propose} />)
    expect((screen.getByRole('textbox', { name: /補足/ }) as HTMLTextAreaElement).value).toBe('')
    expect(
      screen.getByText('旅程が更新されたため入力をリセットしました。').closest('[role="status"]'),
    ).toBeTruthy()
  })

  it('現地の報告内容と希望条件を合わせて上限を超えるときは、送らずに短くするよう案内する', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>(propose)
    render(<OnSiteReplanningFlow trip={sampleTrip} generate={generate} />)
    await goToLunch(user)
    await user.click(screen.getByRole('textbox', { name: /補足/ }))
    await user.paste('あ'.repeat(500))
    await submitReport(user, 'actual')

    const preferences = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: '希望条件（任意）',
    })
    await user.click(preferences)
    await user.paste('い'.repeat(500))
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))

    expect(generate).not.toHaveBeenCalled()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('1000文字以内')
    expect(alert.textContent).toContain('希望条件を短く')
    expect(preferences.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(preferences)

    // 短くすれば案内が消え、そのまま送れる。送る理由は上限に収まる。
    await user.clear(preferences)
    expect(screen.queryByRole('alert')).toBeNull()
    await user.paste('い'.repeat(100))
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(generate.mock.calls[0][0].reason.length).toBeLessThanOrEqual(1000)
  })

  it('候補生成サービス未接続時は操作できるかのように見せない', () => {
    render(<OnSiteReplanningFlow trip={sampleTrip} />)
    expect(screen.getByText(/候補生成サービスを接続すると利用できます/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /この予定だけ変更する/ })).toBeNull()
  })
})
