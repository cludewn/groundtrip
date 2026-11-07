// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assertSameScope, SessionChangedError, type ScopedValue } from './session-scope'
import { useSessionScope, type SessionScopeState } from './use-session-scope'

type FakeUser = { uid: string; isAnonymous: boolean; getIdToken: ReturnType<typeof vi.fn> }

// 実際のclient.tsを使い、Firebase SDKだけをモックする（認証状態の検証・通知の流れを本物のまま通す）。
const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as FakeUser | null, authStateReady: vi.fn() },
  signIn: vi.fn(),
  reload: vi.fn(),
  observe: vi.fn(),
  unsubscribe: vi.fn(),
  getAuth: vi.fn(),
}))

vi.mock('../firebase/client', () => ({ getClientAuth: mocks.getAuth }))
vi.mock('firebase/auth', () => ({
  signInAnonymously: mocks.signIn,
  onIdTokenChanged: mocks.observe,
  reload: mocks.reload,
}))

function userWith(uid: string): FakeUser {
  return { uid, isAnonymous: true, getIdToken: vi.fn().mockResolvedValue(`test-only-${uid}`) }
}

beforeEach(() => {
  vi.resetAllMocks()
  // client.tsのセッション管理はAuthインスタンス単位。テストごとに新しいAuthを使い、状態を持ち越さない。
  mocks.auth = { currentUser: null, authStateReady: vi.fn().mockResolvedValue(undefined) }
  mocks.getAuth.mockImplementation(() => mocks.auth)
  mocks.reload.mockResolvedValue(undefined)
  mocks.observe.mockReturnValue(mocks.unsubscribe)
})

afterEach(() => {
  cleanup()
})

// SDKの認証変更通知を送る。currentUserを先に差し替えるのは実際のSDKと同じ順序。
async function emit(user: FakeUser | null) {
  mocks.auth.currentUser = user
  const notify = mocks.observe.mock.calls.at(-1)?.[1]
  if (typeof notify !== 'function') throw new Error('SDK購読が登録されていません')
  await act(async () => {
    notify(user)
  })
}

function renderScope() {
  const seen: SessionScopeState[] = []
  const hook = renderHook(() => {
    const state = useSessionScope()
    seen.push(state)
    return state
  })
  return { ...hook, seen }
}

function authenticatedScope(state: SessionScopeState) {
  if (state.status !== 'authenticated') throw new Error(`認証済みではありません: ${state.status}`)
  return state.scope
}

describe('useSessionScope', () => {
  it('復元中はrestoringでscopeがなく、世代は0から始まる', () => {
    const { result } = renderScope()
    expect(result.current).toEqual({ status: 'restoring', scopeEpoch: 0 })
    expect(result.current).not.toHaveProperty('scope')
  })

  it('認証後はUIDだけを持つ不変のscopeを返す', async () => {
    const { result } = renderScope()
    await emit(userWith('user-a'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    const scope = authenticatedScope(result.current)
    expect(scope).toEqual({ uid: 'user-a' })
    expect(Object.isFrozen(scope)).toBe(true)
    expect(result.current.scopeEpoch).toBe(0)
  })

  it('AからBへ変わるとscopeが替わり、世代が進む（検証中はAのscopeを返さない）', async () => {
    const { result, seen } = renderScope()
    await emit(userWith('user-a'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    const scopeOfA = authenticatedScope(result.current)
    const before = seen.length

    await emit(userWith('user-b'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    expect(authenticatedScope(result.current).uid).toBe('user-b')
    expect(result.current.scopeEpoch).toBe(1)
    expect(authenticatedScope(result.current)).not.toBe(scopeOfA)

    // Bへの切替通知以降、Aのscopeを返した描画はない。世代は戻らない。
    const afterSwitch = seen.slice(before)
    expect(afterSwitch.some((s) => s.status === 'authenticated' && s.scope.uid === 'user-a')).toBe(
      false,
    )
    const epochs = seen.map((s) => s.scopeEpoch)
    expect(epochs).toEqual([...epochs].sort((a, b) => a - b))
  })

  it('同じUIDの再通知では世代もscopeの参照も変えない', async () => {
    const user = userWith('user-a')
    const { result, seen } = renderScope()
    await emit(user)
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    const scope = authenticatedScope(result.current)

    // 同じUserの再通知（トークン更新）と、同じUIDの新しいUserオブジェクト（再検証が走る）。
    await emit(user)
    await emit(userWith('user-a'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    expect(result.current.scopeEpoch).toBe(0)
    expect(authenticatedScope(result.current)).toBe(scope)
    expect(new Set(seen.map((s) => s.scopeEpoch))).toEqual(new Set([0]))
  })

  it('セッション終了を挟んでAからBになった場合も世代が進む', async () => {
    const { result } = renderScope()
    await emit(userWith('user-a'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))

    await emit(null)
    expect(result.current.status).toBe('session_ended')
    expect(result.current).not.toHaveProperty('scope')

    await emit(userWith('user-b'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    expect(authenticatedScope(result.current).uid).toBe('user-b')
    expect(result.current.scopeEpoch).toBe(1)
  })

  it('セッション終了を挟んで同じUIDに戻った場合は世代を進めない', async () => {
    const { result } = renderScope()
    await emit(userWith('user-a'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    await emit(null)
    expect(result.current.status).toBe('session_ended')
    await emit(userWith('user-a'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    expect(result.current.scopeEpoch).toBe(0)
  })

  it('session_endedではscopeを返さず、匿名アカウントを自動作成しない', async () => {
    const { result } = renderScope()
    await emit(null)
    expect(result.current).toMatchObject({
      status: 'session_ended',
      error: expect.objectContaining({ code: 'session_ended' }),
    })
    expect(result.current).not.toHaveProperty('scope')
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  it('検証の通信失敗ではerrorでscopeを返さず、匿名アカウントを自動作成しない', async () => {
    mocks.reload.mockRejectedValue({ code: 'auth/network-request-failed' })
    const { result, seen } = renderScope()
    await emit(userWith('user-a'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current).toMatchObject({
      error: expect.objectContaining({ code: 'unavailable' }),
    })
    expect(result.current).not.toHaveProperty('scope')
    expect(seen.some((s) => s.status === 'authenticated')).toBe(false)
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  it('アンマウントで購読を解除し、以後の通知を処理しない', async () => {
    const { result, unmount } = renderScope()
    await emit(userWith('user-a'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    expect(mocks.unsubscribe).not.toHaveBeenCalled()

    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)

    // 解除後の通知では検証も行わず、匿名アカウントも作らない。
    const reloads = mocks.reload.mock.calls.length
    await emit(userWith('user-b'))
    await emit(null)
    expect(mocks.reload).toHaveBeenCalledTimes(reloads)
    expect(mocks.signIn).not.toHaveBeenCalled()
  })

  it('Strict Modeの購読の張り直しでも世代が戻らず、購読が残らない', async () => {
    // renderHookのwrapperではStrict Modeの二重実行が起きないため、コンポーネントを直接描画する。
    let latest: SessionScopeState | undefined
    function Probe() {
      latest = useSessionScope()
      return null
    }
    const { unmount } = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    )
    // 開発時は購読→解除→再購読となる。
    expect(mocks.observe.mock.calls.length).toBe(2)
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)

    await emit(userWith('user-a'))
    await waitFor(() => expect(latest?.status).toBe('authenticated'))
    await emit(userWith('user-b'))
    await waitFor(() =>
      expect(latest?.status === 'authenticated' && latest.scope.uid).toBe('user-b'),
    )
    expect(latest?.scopeEpoch).toBe(1)

    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('Aで取得したデータは、フックが返したBのscopeでは使えない', async () => {
    const { result } = renderScope()
    await emit(userWith('user-a'))
    await waitFor(() => expect(result.current.status).toBe('authenticated'))
    // 同じID・同じversionで、本文だけが違うAとBのデータ。
    const dataOfA: ScopedValue<{ id: string; version: number; body: string }> = {
      scope: authenticatedScope(result.current),
      value: { id: 'trip-1', version: 3, body: 'Aだけの本文' },
    }
    expect(() => assertSameScope(dataOfA, authenticatedScope(result.current))).not.toThrow()

    await emit(userWith('user-b'))
    await waitFor(() => expect(authenticatedScope(result.current).uid).toBe('user-b'))
    const scopeOfB = authenticatedScope(result.current)
    const dataOfB: ScopedValue<{ id: string; version: number; body: string }> = {
      scope: scopeOfB,
      value: { id: 'trip-1', version: 3, body: 'Bだけの本文' },
    }
    expect(() => assertSameScope(dataOfA, scopeOfB)).toThrow(SessionChangedError)
    expect(() => assertSameScope(dataOfB, scopeOfB)).not.toThrow()
  })
})
