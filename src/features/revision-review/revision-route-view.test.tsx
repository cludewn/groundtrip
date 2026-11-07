// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision } from '@/domain/samples'
import { sampleRouteMeta as meta, sampleRouteTrip as trip } from '@/features/trip-map/sample'

import type { ApplyRevision, GenerateRevisions, RevisionProposal } from './api-client'
import { RevisionRouteView } from './revision-route-view'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const target = trip.stops[1]
const after = {
  ...sampleRevision.diff.after,
  evidence: sampleRevision.diff.after.evidence.map((evidence) => ({
    ...evidence,
    status: 'consistent' as const,
    explanation: '説明文にだけ含まれる例示値：徒歩999分',
  })),
}
const first = {
  ...sampleRevision,
  diff: { before: target, after },
  constraintCheck: { status: 'satisfied', explanation: '固定展示に間に合う' },
} satisfies RevisionProposal['revisions'][number]
const second = {
  ...first,
  id: 'candidate-b',
  diff: { before: target, after: { ...after, name: '別の食堂', evidence: [] } },
  constraintCheck: { status: 'unknown', explanation: '営業時間が不明' },
} satisfies RevisionProposal['revisions'][number]

function routes(minutes: number): RevisionProposal['comparisons'] {
  return [
    {
      revisionId: first.id,
      before: {
        fromPrevious: leg(trip.stops[0].id, target.id, 10),
        toNext: leg(target.id, trip.stops[2].id, 10),
      },
      after: {
        fromPrevious: leg(trip.stops[0].id, target.id, minutes),
        toNext: leg(target.id, trip.stops[2].id, 6),
      },
    },
  ]
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
      explanation: '説明に含まれる移動時間の例：999分',
    },
  } as const
}

const proposal: RevisionProposal = {
  status: 'proposed',
  revisions: [first, second],
  comparisons: routes(8),
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /昼食店A/ }))
  await user.click(screen.getByRole('button', { name: 'この予定だけ変更' }))
}
const request = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
  await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
}
const route = () => within(screen.getByRole('list', { name: '旅程の路線図' }))
const approve = () => screen.getByRole<HTMLButtonElement>('button', { name: '承認して適用を依頼' })

describe('部分修正の候補比較', () => {
  it('選択したStopだけを徒歩で生成し、分岐、固定予定、構造化比較を切り替える', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    const apply = vi.fn<ApplyRevision>()
    const original = structuredClone(trip)
    render(<RevisionRouteView trip={trip} meta={meta} generate={generate} apply={apply} />)

    await open(user)
    await user.click(screen.getByRole('button', { name: '変更候補を探す' }))
    expect(screen.getByRole('alert').textContent).toContain('修正理由を入力')
    expect(generate).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('希望条件（任意）'), '静かな店')
    await request(user)
    expect(generate).toHaveBeenCalledWith(
      {
        trip,
        targetStopId: target.id,
        reason: '店が休み\n希望条件：静かな店',
        context: { phase: 'planning' },
        travelModes: ['walk'],
      },
      expect.any(AbortSignal),
    )
    const table = within(await screen.findByRole('table'))
    expect(table.getByText('徒歩8分')).toBeTruthy()
    expect(table.getByText('2分短い')).toBeTruthy()
    expect(table.getByText('4分短い')).toBeTruthy()
    expect(
      screen.getByText(`${trip.stops[2].plannedStartTime}の予定に間に合う見込みです。`),
    ).toBeTruthy()
    expect(table.queryByText(/999分/)).toBeNull()
    expect(
      route().getByText(after.name).closest('[data-variant]')?.getAttribute('data-variant'),
    ).toBe('ticket')
    expect(route().getByText(target.name)).toBeTruthy()
    expect(route().getByText('この先は元の旅程に合流')).toBeTruthy()
    expect(
      route().getByText(trip.stops[2].name).closest('[data-variant]')?.querySelector('svg'),
    ).toBeTruthy()
    expect(screen.getByRole('region', { name: '根拠と照合日時' }).textContent).toContain('矛盾あり')
    expect(screen.getByRole('region', { name: '根拠と照合日時' }).textContent).toContain(
      '情報源と整合',
    )
    expect(route().getByText('営業時間：確認できない')).toBeTruthy()
    expect(approve().disabled).toBe(false)

    await user.click(screen.getByRole('button', { name: /候補 B/ }))
    expect(route().getByText('別の食堂')).toBeTruthy()
    expect(route().queryByText(after.name)).toBeNull()
    expect(within(screen.getByRole('table')).getAllByText('移動時間は未取得')).toHaveLength(4)
    expect(screen.queryByText(/間に合う見込みです/)).toBeNull()
    expect(screen.getByText(/確認できていないため、この候補は選べません/)).toBeTruthy()
    expect(screen.getByRole('region', { name: '根拠と照合日時' }).textContent).toContain('未照合')
    expect(approve().disabled).toBe(true)
    await user.click(approve())
    expect(apply).not.toHaveBeenCalled()
    expect(trip).toEqual(original)

    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(route().queryByText('別の食堂')).toBeNull()
    expect(document.activeElement?.id).toBe('stop-button-stop-lunch')
    expect(trip).toEqual(original)
  })

  it('固定予定の修正を防ぎ、明示したときだけ車を送信する', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    render(<RevisionRouteView trip={trip} meta={meta} generate={generate} />)
    await user.click(screen.getByRole('button', { name: /14時の予約展示/ }))
    const sheet = within(screen.getByRole('dialog'))
    expect(
      sheet.getByRole<HTMLButtonElement>('button', { name: '固定中は変更できません' }).disabled,
    ).toBe(true)
    expect(generate).not.toHaveBeenCalled()

    await user.click(sheet.getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await open(user)
    await user.click(screen.getByRole('checkbox', { name: /車を利用できる/ }))
    await request(user)
    expect(generate.mock.calls[0][0].travelModes).toEqual(['walk', 'drive'])
    expect(await screen.findByText('承認・適用サービスは未接続です。')).toBeTruthy()
    expect(approve().disabled).toBe(true)
  })

  it.each([
    ['no_candidates', '条件に合う候補が見つかりませんでした'],
    ['insufficient_information', '情報が不足しています'],
    ['external_service_error', '外部サービスでエラー'],
    ['unavailable', 'APIは現在利用できません'],
    ['interrupted', '通信が中断されました'],
    ['conflict', '旅程が更新されています'],
  ] as const)('%s を区別して表示し、入力と旅程を保持する', async (status, message) => {
    const user = userEvent.setup()
    const generate = vi
      .fn<GenerateRevisions>()
      .mockResolvedValue({ status, message: 'テスト用の詳細' })
    render(<RevisionRouteView trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(route().getByText(target.name)).toBeTruthy()
    expect(route().queryByText(after.name)).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>('修正理由（必須）').value).toBe('店が休み')
  })

  it('待機中にTabでキャンセルへ移ると、502の後もEnterで再送信しない', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Response>()
    const fetchFn = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetchFn)
    const { container } = render(<RevisionRouteView trip={trip} />)
    const liveRegion = container.querySelector('[role="status"][aria-atomic="true"]')
    expect(liveRegion?.textContent).toBe('')
    await open(user)
    expect(container.querySelector('[role="status"][aria-atomic="true"]')).toBe(liveRegion)
    await request(user)
    const cancel = screen.getByRole('button', { name: 'キャンセル' })
    await user.tab({ shift: document.activeElement !== document.body })
    expect(document.activeElement).toBe(cancel)

    await act(async () =>
      pending.resolve(
        Response.json(
          { status: 'external_service_error', message: '候補生成サービスの障害' },
          { status: 502 },
        ),
      ),
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('外部サービスでエラー')
    expect(alert.getAttribute('data-tone')).toBe('error')
    expect(document.activeElement).toBe(cancel)
    await user.keyboard('{Enter}')
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(screen.getByText('部分修正をキャンセルしました。').closest('[role="status"]')).toBe(
      liveRegion,
    )
  })

  it('409でフォーカスを失った場合はキャンセルへ移す', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(pending.promise))
    render(<RevisionRouteView trip={trip} />)
    await open(user)
    await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '変更候補を探す' })
    submit.focus()
    await user.keyboard('{Enter}')
    submit.blur()
    expect(document.activeElement).toBe(document.body)

    await act(async () => pending.resolve(new Response(null, { status: 409 })))
    expect(screen.getByRole('alert').textContent).toContain('旅程が更新されています')
    expect(submit.disabled).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'キャンセル' }))
  })

  it('フォーカスを失った状態で404が返ると送信ボタンに戻り、Enterで再試行できる', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<Response>()
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json(proposal))
    vi.stubGlobal('fetch', fetchFn)
    render(<RevisionRouteView trip={trip} />)
    await open(user)
    await user.type(screen.getByLabelText('修正理由（必須）'), '店が休み')
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '変更候補を探す' })
    submit.focus()
    await user.keyboard('{Enter}')
    expect(submit.disabled).toBe(true)
    // jsdomではボタンを無効にしてもフォーカスが残るため、失われた状態を再現する。
    submit.blur()
    expect(document.activeElement).toBe(document.body)
    await act(async () => pending.resolve(new Response(null, { status: 404 })))
    expect(submit.disabled).toBe(false)
    expect(document.activeElement).toBe(submit)
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('table')).toBeTruthy()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it.each(['failed', 'proposed'] as const)(
    '生成コールバックが入力を書き換えて %s を返しても、元のTripは変わらない',
    async (status) => {
      const user = userEvent.setup()
      const source = structuredClone(trip)
      const generate: GenerateRevisions = async ({ trip: input }) => {
        input.stops[1].name = '改変された変更前の予定'
        input.stops[2].isFixed = false
        input.stops[2].evidence[0].explanation = '改変された根拠'
        input.version += 1
        return status === 'failed'
          ? { status: 'external_service_error', message: '生成失敗' }
          : {
              status: 'proposed',
              revisions: [
                {
                  ...first,
                  baseTripVersion: input.version,
                  diff: { ...first.diff, before: input.stops[1] },
                },
              ],
            }
      }
      render(<RevisionRouteView trip={source} generate={generate} />)
      await open(user)
      await request(user)
      expect((await screen.findByRole('alert')).textContent).toContain(
        status === 'failed' ? '外部サービスでエラー' : '候補の応答を確認できません',
      )
      expect(source).toEqual(trip)
      expect(route().getByText(target.name)).toBeTruthy()
      expect(route().queryByText(/改変された/)).toBeNull()
      expect(screen.queryByRole('table')).toBeNull()
    },
  )

  it('生成中のキャンセルで通信を中断し、遅れて届いた候補を破棄する', async () => {
    const user = userEvent.setup()
    const pending = Promise.withResolvers<RevisionProposal>()
    const generate = vi.fn<GenerateRevisions>().mockReturnValue(pending.promise)
    render(<RevisionRouteView trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(generate.mock.calls[0][1].aborted).toBe(true)
    await act(async () => pending.resolve(proposal))
    expect(screen.queryByRole('table')).toBeNull()
    expect(route().getByText(target.name)).toBeTruthy()
  })

  it('比較中に旅程の版や固定状態が変われば候補を破棄する', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    const view = render(<RevisionRouteView trip={trip} generate={generate} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    view.rerender(
      <RevisionRouteView
        trip={{ ...trip, version: 1, stops: trip.stops.with(1, { ...target, isFixed: true }) }}
        generate={generate}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('旅程が更新された')
    expect(screen.queryByRole('table')).toBeNull()
    expect(route().getByRole('button', { name: /昼食店A.*固定予定/ })).toBeTruthy()
  })
})

describe('本人承認とサーバー適用', () => {
  it('適用中は元の旅程を保持し、サーバー成功後にだけ置き換える', async () => {
    const user = userEvent.setup()
    const generate = vi.fn<GenerateRevisions>().mockResolvedValue(proposal)
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const original = structuredClone(trip)
    const { container } = render(
      <RevisionRouteView trip={trip} meta={meta} generate={generate} apply={apply} />,
    )
    const liveRegion = container.querySelector('[role="status"][aria-atomic="true"]')
    expect(liveRegion?.textContent).toBe('')
    await open(user)
    expect(container.querySelector('[role="status"][aria-atomic="true"]')).toBe(liveRegion)
    await request(user)
    await screen.findByRole('table')
    await user.click(approve())
    expect(apply).toHaveBeenCalledOnce()
    expect(apply.mock.calls[0][0]).toMatchObject({
      request: { trip, targetStopId: target.id, travelModes: ['walk'] },
      revision: first,
    })
    expect(route().getByText(target.name)).toBeTruthy()
    expect(screen.getByText('承認操作済み・適用結果を確認中')).toBeTruthy()
    expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
    expect(route().queryByText('変更を反映済み')).toBeNull()
    expect(trip).toEqual(original)

    const saved = structuredClone({ ...trip, version: 1, stops: trip.stops.with(1, after) })
    await act(async () => pending.resolve({ status: 'applied', trip: saved }))
    expect(route().getByRole('button', { name: /昼食店B/ })).toBeTruthy()
    expect(route().queryByText(target.name)).toBeNull()
    expect(route().getByRole('button', { name: /14時の予約展示.*固定予定/ })).toBeTruthy()
    const notice = screen.getByText(/旅程に反映されました/)
    expect(notice.closest('[role="status"]')).toBe(liveRegion)
    expect(notice.getAttribute('data-tone')).toBe('success')
    expect(route().getByText('変更を反映済み')).toBeTruthy()
    expect(trip).toEqual(original)

    const appliedButton = route().getByRole('button', { name: /昼食店B/ })
    saved.stops[1].name = '応答後に変更された店'
    await user.click(appliedButton)
    expect(within(screen.getByRole('dialog')).getByRole('heading').textContent).toBe(after.name)
  })

  it('生成コールバックが入力や返却済みの候補を変更しても、承認時の条件と候補は変わらない', async () => {
    const user = userEvent.setup()
    const returned = structuredClone(proposal)
    const generate: GenerateRevisions = async (input) => {
      input.reason = '改変された理由'
      input.travelModes?.push('drive')
      return returned
    }
    const apply = vi.fn<ApplyRevision>().mockResolvedValue({ status: 'failed' })
    render(<RevisionRouteView trip={trip} generate={generate} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    returned.revisions[0].diff.after.name = '応答後に変更された候補'
    returned.revisions[0].constraintCheck.status = 'unknown'
    await user.click(screen.getByRole('button', { name: /候補 B/ }))
    await user.click(screen.getByRole('button', { name: /候補 A/ }))
    expect(route().getByText(after.name)).toBeTruthy()
    await user.click(approve())
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ reason: '店が休み', travelModes: ['walk'] }),
        revision: first,
      }),
    )
  })

  it('適用コールバックが引数を直接書き換えて失敗しても、候補と固定予定を保持する', async () => {
    const user = userEvent.setup()
    const source = structuredClone(trip)
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>(({ request: { trip: input }, revision }) => {
      input.stops[2].isFixed = false
      input.stops[2].evidence[0].explanation = '改変された根拠'
      input.preferences.push('改変された希望条件')
      revision.diff.after.name = '改変された候補'
      revision.diff.after.evidence[0].explanation = '改変された候補の根拠'
      return pending.promise
    })
    render(<RevisionRouteView trip={source} generate={async () => proposal} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    await user.click(approve())
    expect(source).toEqual(trip)
    expect(route().getByText(after.name)).toBeTruthy()
    await act(async () => pending.resolve({ status: 'failed' }))
    expect((await screen.findByRole('alert')).textContent).toContain('候補を適用できませんでした')
    expect(source).toEqual(trip)
    expect(route().getByText(after.name)).toBeTruthy()
    expect(route().queryByText('改変された候補')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(route().getByRole('button', { name: /14時の予約展示.*固定予定/ })).toBeTruthy()
  })

  it.each(['fixed', 'outside', 'revision', 'version'] as const)(
    '適用コールバックが %s を書き換えたTripを成功応答に使っても拒否する',
    async (change) => {
      const user = userEvent.setup()
      const source = structuredClone(trip)
      source.version = 4
      source.stops[0].isFixed = false
      const original = structuredClone(source)
      const apply: ApplyRevision = async ({ request: { trip: input }, revision }) => {
        if (change === 'fixed') input.stops[2].isFixed = false
        if (change === 'outside') input.stops[0].name = '対象外の予定の改変'
        if (change === 'revision') revision.diff.after.name = '承認していない候補'
        if (change === 'version') input.version = 0
        input.stops[1] = revision.diff.after
        return { status: 'applied', trip: { ...input, version: input.version + 1 } }
      }
      render(
        <RevisionRouteView
          trip={source}
          generate={async () => ({
            status: 'proposed',
            revisions: [{ ...first, baseTripVersion: source.version }],
          })}
          apply={apply}
        />,
      )
      await open(user)
      await request(user)
      await screen.findByRole('table')
      await user.click(approve())
      expect((await screen.findByRole('alert')).textContent).toContain(
        '適用結果を確認できませんでした',
      )
      expect(source).toEqual(original)
      expect(route().getByText(target.name)).toBeTruthy()
      expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
      expect(approve().disabled).toBe(true)
    },
  )

  it('適用中に親Tripが変わると更新通知へフォーカスを移し、古い成功応答を破棄する', async () => {
    const user = userEvent.setup()
    const generate: GenerateRevisions = async () => proposal
    const pending = Promise.withResolvers<Awaited<ReturnType<ApplyRevision>>>()
    const apply = vi.fn<ApplyRevision>().mockReturnValue(pending.promise)
    const view = render(<RevisionRouteView trip={trip} generate={generate} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    approve().focus()
    await user.keyboard('{Enter}')
    expect(apply).toHaveBeenCalledOnce()

    const latest = {
      ...trip,
      version: 1,
      stops: trip.stops.with(1, { ...target, name: '親が更新した昼食', isFixed: true }),
    }
    view.rerender(<RevisionRouteView trip={latest} generate={generate} apply={apply} />)
    const update = screen.getByRole('alert')
    expect(document.activeElement).toBe(update)
    expect(update.textContent).toContain('最新の旅程')
    expect(route().getByRole('button', { name: /親が更新した昼食.*固定予定/ })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    await user.tab()
    expect(document.activeElement).toBe(
      within(update).getByRole('button', { name: '比較を閉じる' }),
    )
    await act(async () =>
      pending.resolve({
        status: 'applied',
        trip: { ...trip, version: 2, stops: trip.stops.with(1, after) },
      }),
    )
    expect(route().getByRole('button', { name: /親が更新した昼食/ })).toBeTruthy()
    expect(route().queryByText(after.name)).toBeNull()
    expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
  })

  it.each([
    ['conflict', '旅程が更新され'],
    ['failed', '候補を適用できませんでした'],
    ['unavailable', '適用するサービスは現在利用できません'],
    ['network', '適用結果を確認できませんでした'],
    ['invalid-success', '適用結果を確認できませんでした'],
  ] as const)('適用時の %s では変更も成功表示もしない', async (status, message) => {
    const user = userEvent.setup()
    const apply = vi.fn<ApplyRevision>()
    if (status === 'network') {
      apply.mockRejectedValue(new TypeError('offline'))
    } else if (status === 'invalid-success') {
      // サーバーが成功を返しても、固定予定まで変わっていれば結果は受け入れない。
      apply.mockResolvedValue({
        status: 'applied',
        trip: {
          ...trip,
          version: 1,
          stops: [trip.stops[0], after, { ...trip.stops[2], isFixed: false }],
        },
      })
    } else {
      apply.mockResolvedValue({ status })
    }
    render(<RevisionRouteView trip={trip} generate={async () => proposal} apply={apply} />)
    await open(user)
    await request(user)
    await screen.findByRole('table')
    await user.click(approve())
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(route().getByText(target.name)).toBeTruthy()
    expect(screen.queryByText(/旅程に反映されました/)).toBeNull()
    expect(approve().disabled).toBe(['conflict', 'network', 'invalid-success'].includes(status))
  })

  it.each(['not_checked', 'violated'] as const)('%s の候補は承認できない', async (status) => {
    const user = userEvent.setup()
    render(
      <RevisionRouteView
        trip={trip}
        generate={async () => ({
          status: 'proposed',
          revisions: [{ ...first, constraintCheck: { ...first.constraintCheck, status } }],
        })}
        apply={vi.fn<ApplyRevision>()}
      />,
    )
    await open(user)
    await request(user)
    await screen.findByRole('table')
    expect(approve().disabled).toBe(true)
  })
})
