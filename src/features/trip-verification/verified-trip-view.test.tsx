// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TripSchema, type Evidence, type Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'

import type { VerificationResult } from './api-client'
import { VerifiedTripView, type VerifyTrip } from './verified-trip-view'

afterEach(() => cleanup())

const generated = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, isFixed: false, placeId: null, evidence: [] })),
})

function evidence(stopId: string, status: Evidence['status'], subject: Evidence['subject']) {
  return {
    id: `evidence-${stopId}-${subject}`,
    subject,
    claim: subject === 'travel_time' ? '徒歩移動が予定の時間内に収まる' : '施設の名称・地域を照合',
    applicability: subject === 'travel_time' ? '前の予定からの徒歩移動' : '施設の存在のみ',
    source: {
      kind: subject === 'travel_time' ? ('routes' as const) : ('places' as const),
      label: subject === 'travel_time' ? 'Google Routes' : 'Google Places',
    },
    checkedAt: '2026-11-08T11:00:00+09:00',
    status,
    explanation: 'Google Maps Platformから得られた情報との照合結果です。',
  }
}

function verifiedOf(trip: Trip, status: Evidence['status'] = 'consistent'): Trip {
  return TripSchema.parse({
    ...trip,
    stops: trip.stops.map((stop, index) => ({
      ...stop,
      placeId: `place-${stop.id}`,
      evidence: [
        evidence(stop.id, status, 'place_identity'),
        ...(index > 0 ? [evidence(stop.id, status, 'travel_time')] : []),
      ],
    })),
  })
}

function deferred() {
  let resolve: (result: VerificationResult) => void = () => undefined
  const promise = new Promise<VerificationResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const route = () => screen.getByRole('list', { name: '旅程の路線図' })

describe('VerifiedTripView: 根拠照合の画面接続', () => {
  it('初期状態は未照合で、ボタンを押して初めてAPIを呼ぶ', async () => {
    const verify = vi.fn<VerifyTrip>().mockResolvedValue({ ok: true, trip: verifiedOf(generated) })
    const user = userEvent.setup()
    render(<VerifiedTripView trip={generated} verify={verify} />)

    expect(verify).not.toHaveBeenCalled()
    expect(route().textContent).toContain('未照合')
    await user.click(screen.getByRole('button', { name: '根拠を確認する' }))

    await waitFor(() => expect(route().textContent).toContain('情報源と整合'))
    expect(verify).toHaveBeenCalledTimes(1)
    expect(route().textContent).toContain('徒歩移動は情報源と整合')
    expect(screen.getByRole('status', { name: '照合の状況' }).textContent).toContain('保証')
    expect(screen.getByRole('group', { name: '確認に使った情報源' }).textContent).toContain(
      'Google Maps',
    )
    expect(screen.getByRole('link', { name: '利用規約・プライバシーを見る' })).toHaveAttribute(
      'href',
      '/terms',
    )
  })

  it('照合中は重複リクエストを防ぎ、未照合の旅程を表示し続ける', async () => {
    const pending = deferred()
    const verify = vi.fn<VerifyTrip>(() => pending.promise)
    const user = userEvent.setup()
    render(<VerifiedTripView trip={generated} verify={verify} />)

    await user.click(screen.getByRole('button', { name: '根拠を確認する' }))
    expect(verify).toHaveBeenCalledTimes(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '確認中…' }).disabled).toBe(true)
    expect(route().textContent).toContain('未照合')
    await act(async () => pending.resolve({ ok: true, trip: verifiedOf(generated) }))
    expect(route().textContent).toContain('情報源と整合')
  })

  it('照合待ちに行った固定は結果の到着後も残る', async () => {
    const pending = deferred()
    const verify = vi.fn<VerifyTrip>(() => pending.promise)
    const user = userEvent.setup()
    render(<VerifiedTripView trip={generated} verify={verify} />)

    await user.click(screen.getByRole('button', { name: '根拠を確認する' }))
    await user.click(screen.getByRole('button', { name: /昼食店A/ }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'この予定を固定する' }),
    )
    await act(async () => pending.resolve({ ok: true, trip: verifiedOf(generated) }))
    expect(route().textContent).toContain('固定予定')
    expect(route().textContent).toContain('情報源と整合')
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('502/503などのエラーでも元の旅程は残り、再試行できる', async () => {
    const verify = vi.fn<VerifyTrip>()
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: 'service_unavailable', message: '旅程の照合は現在利用できません。' },
      })
      .mockResolvedValueOnce({ ok: true, trip: verifiedOf(generated, 'unverifiable') })
    const user = userEvent.setup()
    render(<VerifiedTripView trip={generated} verify={verify} />)

    await user.click(screen.getByRole('button', { name: '根拠を確認する' }))
    expect((await screen.findByRole('alert')).textContent).toContain('利用できません')
    expect(route().textContent).toContain('未照合')

    await user.click(screen.getByRole('button', { name: 'もう一度、照合する' }))
    await waitFor(() => expect(route().textContent).toContain('確認できない'))
    expect(verify).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('照合中に予定そのものが変更された応答は取り込まない', async () => {
    const tampered = TripSchema.parse({
      ...generated,
      stops: generated.stops.map((stop, index) =>
        index === 0 ? { ...stop, name: '違う目的地' } : stop,
      ),
    })
    const verify = vi.fn<VerifyTrip>().mockResolvedValue({ ok: true, trip: tampered })
    const user = userEvent.setup()
    render(<VerifiedTripView trip={generated} verify={verify} />)

    await user.click(screen.getByRole('button', { name: '根拠を確認する' }))
    expect((await screen.findByRole('alert')).textContent).toContain('照合し直してください')
    expect(route().textContent).not.toContain('違う目的地')
  })

  it('画面を離れたらAbortSignalを中断し、後着の結果を使わない', async () => {
    const pending = deferred()
    const verify = vi.fn<VerifyTrip>(() => pending.promise)
    const user = userEvent.setup()
    const view = render(<VerifiedTripView trip={generated} verify={verify} />)
    await user.click(screen.getByRole('button', { name: '根拠を確認する' }))
    const options = verify.mock.calls[0][1]
    view.unmount()
    expect(options?.signal?.aborted).toBe(true)
    await act(async () => pending.resolve({ ok: true, trip: verifiedOf(generated) }))
  })
})
