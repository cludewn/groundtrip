import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  init,
  getToken,
  getAuthHeaders,
  getClientAuth,
  provider,
  getAuthSnapshot,
  isAuthSessionCurrent,
  registerAuthSessionOperation,
} = vi.hoisted(() => ({
  init: vi.fn(),
  getToken: vi.fn(),
  getAuthHeaders: vi.fn(),
  getClientAuth: vi.fn(),
  provider: vi.fn(),
  getAuthSnapshot: vi.fn(),
  isAuthSessionCurrent: vi.fn(),
  registerAuthSessionOperation: vi.fn(),
}))

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: init,
  getToken,
  ReCaptchaEnterpriseProvider: class {
    constructor(siteKey: string) {
      provider(siteKey)
    }
  },
}))
vi.mock('../firebase/client', () => ({ getClientAuth }))
vi.mock('./client', () => ({
  getAuthHeaders,
  getAuthSnapshot,
  isAuthSessionCurrent,
  registerAuthSessionOperation,
}))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY', 'test-site-key')
  getClientAuth.mockReturnValue({ app: {} })
  isAuthSessionCurrent.mockReturnValue(true)
  getAuthSnapshot.mockResolvedValue({ uid: 'anonymous', token: 'old.id.token', generation: 0 })
  registerAuthSessionOperation.mockReturnValue(() => undefined)
  vi.stubGlobal('window', new EventTarget())
  init.mockReturnValue({})
  getToken.mockResolvedValue({ token: 'test.app.check' })
  getAuthHeaders.mockImplementation(
    async () => new Headers({ Authorization: 'Bearer user.id.token' }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('保護API用のWebクライアント', () => {
  it('FirebaseアプリのApp Checkを1回初期化し、2種類のヘッダーを返す', async () => {
    const { getProtectedApiHeaders } = await import('./protected-api')
    const headers = await getProtectedApiHeaders()
    await getProtectedApiHeaders()

    expect(provider).toHaveBeenCalledExactlyOnceWith('test-site-key')
    expect(init).toHaveBeenCalledTimes(1)
    expect(getToken).toHaveBeenCalledTimes(2)
    expect(headers.get('Authorization')).toBe('Bearer user.id.token')
    expect(headers.get('X-Firebase-AppCheck')).toBe('test.app.check')
  })

  it('検証エラーをトークンなしの認証成功に変換しない', async () => {
    const { getProtectedApiHeaders } = await import('./protected-api')
    getToken.mockRejectedValue(new Error('app check unavailable'))

    await expect(getProtectedApiHeaders()).rejects.toThrow()
    expect(getAuthHeaders).not.toHaveBeenCalled()
  })

  it('App Check取得中にUIDが切り替わると、旧画面の本文を送信しない', async () => {
    const { runProtectedSession } = await import('./protected-api')
    const { createSessionScope } = await import('./session-scope')
    const scope = createSessionScope('anonymous', 0)
    const pending = Promise.withResolvers<{ token: string }>()
    getToken.mockReturnValue(pending.promise)
    const send = vi.fn()
    vi.stubGlobal('fetch', send)

    const work = runProtectedSession(scope, undefined, (fetchFn) => fetchFn('/api/trips'))
    getAuthSnapshot.mockResolvedValue({ uid: 'demo', token: 'new.id.token', generation: 1 })
    pending.resolve({ token: 'test.app.check' })
    await expect(work).rejects.toMatchObject({ code: 'session_changed' })
    expect(send).not.toHaveBeenCalled()
  })

  it('ページを離れると旧UIDの通信を中断し、遅れて届いた応答を採用しない', async () => {
    const { runProtectedSession } = await import('./protected-api')
    const { createSessionScope } = await import('./session-scope')
    const scope = createSessionScope('anonymous', 0)
    const sent = Promise.withResolvers<RequestInit>()
    const pending = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      sent.resolve(init)
      return pending.promise
    })

    const work = runProtectedSession(scope, undefined, async (fetchFn) => {
      const response = await fetchFn('/api/trips')
      return response.json()
    })
    const init = await sent.promise
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer old.id.token')
    window.dispatchEvent(new Event('pagehide'))
    expect(init.signal?.aborted).toBe(true)
    isAuthSessionCurrent.mockReturnValue(false)
    pending.resolve(Response.json({ trips: ['old data'] }))
    await expect(work).rejects.toMatchObject({ code: 'session_changed', outcome: 'unknown' })
  })
})
