// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TripSchema } from '@/domain'
import { sampleTrip } from '@/domain/samples'
import type { GenerateTrip } from '@/features/trip-planner/use-trip-generation'
import type { VerifyTrip } from '@/features/trip-verification/verified-trip-view'

import { HomePlanner } from './home-planner'

afterEach(() => {
  cleanup()
})

// 生成直後の旅程は、AIの提案であり未照合（根拠は空）。
const generatedTrip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, isFixed: false, evidence: [] })),
})

describe('HomePlanner: 入力から路線図まで', () => {
  it('生成した旅程から根拠照合ボタンを使い、Places・Routesの結果を路線図に反映する', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue({ ok: true, trip: generatedTrip })
    const verified = TripSchema.parse({
      ...generatedTrip,
      stops: generatedTrip.stops.map((stop) => ({
        ...stop,
        placeId: `place-${stop.id}`,
        evidence: [
          {
            id: `evidence-${stop.id}`,
            subject: 'place_identity' as const,
            claim: '施設の一致',
            applicability: '施設の存在',
            source: { kind: 'places' as const, label: 'Google Places' },
            checkedAt: '2026-11-08T12:00:00+09:00',
            status: 'consistent' as const,
            explanation: '名称と地域が一致しました。',
          },
        ],
      })),
    })
    const verify = vi.fn<VerifyTrip>().mockResolvedValue({ ok: true, trip: verified })
    const user = userEvent.setup()
    render(<HomePlanner generate={generate} verify={verify} />)

    await user.type(screen.getByLabelText(/旅行先/), '京都市東山エリア')
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    expect(verify).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: '根拠を確認する' }))
    const route = await screen.findByRole('list', { name: '旅程の路線図' })
    await screen.findByText('情報源と照合しました。', { exact: false })
    expect(within(route).getAllByRole('listitem')).toHaveLength(3)
    expect(route.textContent).toContain('情報源と整合')
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('生成された旅程を路線図で表示し、未照合であることを示す', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue({ ok: true, trip: generatedTrip })
    const user = userEvent.setup()
    render(<HomePlanner generate={generate} />)

    await user.type(screen.getByLabelText(/旅行先/), '京都市東山エリア')
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))

    const route = await screen.findByRole('list', { name: '旅程の路線図' })
    expect(within(route).getAllByRole('listitem')).toHaveLength(3)
    expect(route.textContent).toContain('朝の庭園（架空）')
    expect(route.textContent?.match(/未照合/g)).toHaveLength(3)
    expect(route.textContent).not.toContain('情報源と整合')
  })

  it('生成された旅程から、本人が選んだ地点の部分修正へ進める', async () => {
    const generate = vi.fn<GenerateTrip>().mockResolvedValue({ ok: true, trip: generatedTrip })
    const user = userEvent.setup()
    render(<HomePlanner generate={generate} />)

    await user.type(screen.getByLabelText(/旅行先/), '京都')
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    await user.click(await screen.findByRole('button', { name: /昼食店A/ }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'この予定を固定する' })).toBeTruthy()
    expect(dialog.textContent).toContain('照合していません')
    expect(within(dialog).getByRole('button', { name: 'この予定だけ変更' })).toBeTruthy()
  })

  it('再生成に失敗すると、以前の旅程は表示から消える。保持されていると案内しない（保持されるのは入力内容だけ）', async () => {
    const generate = vi
      .fn<GenerateTrip>()
      .mockResolvedValueOnce({ ok: true, trip: generatedTrip })
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: 'external_service_error', message: '接続できませんでした' },
      })
    const user = userEvent.setup()
    render(<HomePlanner generate={generate} />)

    await user.type(screen.getByLabelText(/旅行先/), '京都市東山エリア')
    fireEvent.change(screen.getByLabelText(/日付/), { target: { value: '2026-11-14' } })
    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    expect(await screen.findByRole('list', { name: '旅程の路線図' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '旅程を作成する' }))
    const alert = await screen.findByRole('alert')

    expect(screen.queryByRole('list', { name: '旅程の路線図' })).toBeNull()
    expect(alert.textContent).toContain('入力内容は保持されています。')
    expect(alert.textContent).not.toContain('元の旅程')
    expect((screen.getByLabelText(/旅行先/) as HTMLInputElement).value).toBe('京都市東山エリア')
  })
})
