import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleTrip } from '@/domain/samples'

import { verifyTripFromBrowser, withAuthHeaders } from './browser-verify'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('withAuthHeaders（認証ヘッダーを付ける唯一の場所）', () => {
  it('提供元がなければ、fetchをそのまま使う（挙動を変えない）', () => {
    const base = vi.fn() as unknown as typeof fetch
    expect(withAuthHeaders(base)).toBe(base)
  })

  it('取得できたヘッダーを、元のヘッダーに足して送る', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'))
    const wrapped = withAuthHeaders(base as unknown as typeof fetch, async () => {
      return new Headers({ Authorization: 'Bearer token-1' })
    })

    await wrapped('/api/trips/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
    })

    const init = base.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer token-1')
    expect(headers.get('Content-Type')).toBe('text/plain')
    expect(init.method).toBe('POST')
  })

  it('トークンを取得できなくても、ヘッダーなしでそのまま送る', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'))
    const wrapped = withAuthHeaders(base as unknown as typeof fetch, async () => {
      throw new Error('session_ended')
    })

    await wrapped('/api/trips/verify', { method: 'POST' })

    expect(base).toHaveBeenCalledWith('/api/trips/verify', { method: 'POST' })
  })
})

describe('verifyTripFromBrowser', () => {
  it('今は認証ヘッダーを付けず、/api/trips/verify に旅程を送る', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'service_unavailable', message: '停止中' }), {
        status: 503,
      }),
    )
    vi.stubGlobal('fetch', fetchFn)

    const result = await verifyTripFromBrowser(sampleTrip)

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'service_unavailable', message: '停止中' },
    })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/trips/verify')
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
  })
})
