// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import type { VerificationResult } from './api-client'
import { useTripVerification, type VerifyTrip } from './use-trip-verification'
import { VerificationPanel } from './verification-panel'

afterEach(() => {
  cleanup()
})

describe('useTripVerification', () => {
  it('実行中の再送信は受け付けず、APIを1回だけ呼ぶ', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi.fn<VerifyTrip>().mockReturnValue(pending.promise)
    const { result } = renderHook(() => useTripVerification(verify))

    let first!: Promise<unknown>
    let second!: Promise<unknown>
    act(() => {
      first = result.current.run(sampleTrip)
      second = result.current.run(sampleTrip)
    })
    expect(verify).toHaveBeenCalledOnce()
    expect(await second).toBeNull()

    await act(async () => pending.resolve({ ok: true, trip: sampleTrip }))
    expect(await first).toBe(sampleTrip)
    expect(result.current.state).toEqual({ phase: 'idle' })
  })

  it('失敗は種類ごとに state に出し、成功を返さない。次の実行ができる', async () => {
    const verify = vi
      .fn<VerifyTrip>()
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: 'service_unavailable', message: '停止中' },
      })
      .mockResolvedValueOnce({ ok: true, trip: sampleTrip })
    const { result } = renderHook(() => useTripVerification(verify))

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.run(sampleTrip)
    })
    expect(outcome).toBeNull()
    expect(result.current.state).toEqual({
      phase: 'failed',
      failure: { kind: 'service_unavailable', message: '停止中' },
    })

    await act(async () => {
      outcome = await result.current.run(sampleTrip)
    })
    expect(outcome).toBe(sampleTrip)
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('cancel で通信を中止し、その結果は返さず、すぐ次の実行ができる', async () => {
    const pending = Promise.withResolvers<VerificationResult>()
    const verify = vi
      .fn<VerifyTrip>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true, trip: sampleTrip })
    const { result } = renderHook(() => useTripVerification(verify))

    let cancelled!: Promise<unknown>
    act(() => {
      cancelled = result.current.run(sampleTrip)
    })
    act(() => result.current.cancel())
    expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(result.current.state).toEqual({ phase: 'idle' })

    let next: unknown
    await act(async () => {
      next = await result.current.run(sampleTrip)
    })
    expect(next).toBe(sampleTrip)

    await act(async () => pending.resolve({ ok: true, trip: sampleTrip }))
    expect(await cancelled).toBeNull()
  })

  it('画面を離れたら通信を中止する', () => {
    const verify = vi.fn<VerifyTrip>().mockReturnValue(new Promise(() => {}))
    const { result, unmount } = renderHook(() => useTripVerification(verify))
    act(() => {
      void result.current.run(sampleTrip)
    })
    unmount()
    expect(verify.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
})

describe('VerificationPanel のボタン', () => {
  it('確認中は押しても onVerify を呼ばず、フォーカスと名前を保つ', async () => {
    const onVerify = vi.fn()
    render(
      <VerificationPanel
        status={{ kind: 'unverified' }}
        phase={{ phase: 'verifying' }}
        onVerify={onVerify}
      />,
    )
    const button = screen.getByRole('button', { name: '確認しています…' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await userEvent.setup().click(button)
    expect(onVerify).not.toHaveBeenCalled()
  })

  it('未確認なら押せて、onVerify を1回呼ぶ', async () => {
    const onVerify = vi.fn()
    render(
      <VerificationPanel
        status={{ kind: 'unverified' }}
        phase={{ phase: 'idle' }}
        onVerify={onVerify}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: '根拠を確認する' }))
    expect(onVerify).toHaveBeenCalledOnce()
  })
})
