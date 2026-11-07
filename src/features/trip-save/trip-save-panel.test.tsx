// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'
import {
  initializeAnonymousSession,
  startNewAnonymousSession,
  getAuthHeaders,
} from '@/lib/auth/client'
import { TripSavePanel } from './trip-save-panel'

vi.mock('@/lib/auth/client', () => ({
  initializeAnonymousSession: vi.fn(),
  startNewAnonymousSession: vi.fn(),
  getAuthHeaders: vi.fn(),
}))

const trip = { ...sampleTrip, learningApplications: [] }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('旅程の明示的保存', () => {
  it('利用者の操作までは保存せず、認証失敗でも匿名UIDを勝手に発行しない', async () => {
    vi.mocked(initializeAnonymousSession).mockRejectedValue(new Error('missing'))
    render(<TripSavePanel trip={trip} />)
    expect(initializeAnonymousSession).not.toHaveBeenCalled()
    expect(startNewAnonymousSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '本人の操作で旅程を保存する' }))
    expect(await screen.findByRole('button', { name: '新しい利用を始める' })).toBeTruthy()
    expect(startNewAnonymousSession).not.toHaveBeenCalled()
  })

  it('本人認証・サーバー応答を確認してから保存済みリンクを表示する', async () => {
    vi.mocked(initializeAnonymousSession).mockResolvedValue({
      uid: 'user-1',
      isAnonymous: true,
    })
    vi.mocked(getAuthHeaders).mockResolvedValue(new Headers({ Authorization: 'Bearer token' }))
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ trip }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchFn)
    render(<TripSavePanel trip={trip} />)
    fireEvent.click(screen.getByRole('button', { name: '本人の操作で旅程を保存する' }))
    expect(await screen.findByText('Firestoreへの保存を確認しました。')).toBeTruthy()
    const [url, options] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/trips')
    expect(options?.method).toBe('POST')
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer token')
    expect(screen.getByRole('link', { name: '保存した旅程を振り返る' }).getAttribute('href')).toBe(
      '/reflection?tripId=trip-demo',
    )
  })

  it('503では保存済みとは表示しない', async () => {
    vi.mocked(initializeAnonymousSession).mockResolvedValue({
      uid: 'user-1',
      isAnonymous: true,
    })
    vi.mocked(getAuthHeaders).mockResolvedValue(new Headers({ Authorization: 'Bearer token' }))
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'persistence_disabled' } }), { status: 503 }),
    )
    vi.stubGlobal('fetch', fetchFn)
    render(<TripSavePanel trip={trip} />)
    fireEvent.click(screen.getByRole('button', { name: '本人の操作で旅程を保存する' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('保存サービス'))
    expect(screen.queryByText('Firestoreへの保存を確認しました。')).toBeNull()
  })
})
