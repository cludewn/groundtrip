import { vi } from 'vitest'

// 画面のテスト用に、`@/lib/auth/client` の認証クライアントを差し替える偽物。
// Firebase SDKは使わず、現在のユーザー（UID）と購読者への通知を、テストから操作できるようにする。
// セッションスコープ（session-scope.ts・use-session-scope.ts）は、本物をこの上で動かす。
//
// 使い方（テストファイルの先頭）：
//   vi.mock('@/lib/auth/client', async (importOriginal) => {
//     const actual = await importOriginal<typeof import('@/lib/auth/client')>()
//     const { fakeAuth } = await import('../../../tests/helpers/fake-auth-client')
//     fakeAuth.useErrorClass(actual.ClientAuthError)
//     return { ...actual, ...fakeAuth.client }
//   })
// IDトークンは `token-of-<uid>` 。疑似バックエンドは、このトークンからUIDを読み取る。

type AuthUser = { uid: string; isAnonymous: boolean }
type AuthStateLike =
  | { status: 'restoring' }
  | { status: 'session_ended'; error: Error }
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'error'; error: Error }
type ErrorClass = new (code: 'session_ended' | 'unavailable') => Error

export const tokenOf = (uid: string) => `token-of-${uid}`
export const uidOfToken = (header: string | null) => {
  const match = /^Bearer token-of-(.+)$/.exec(header ?? '')
  return match ? match[1] : undefined
}

function createFakeAuth() {
  let ErrorClassRef: ErrorClass | undefined
  let uid: string | null = null
  const listeners = new Set<(state: AuthStateLike) => void>()
  const issued: Array<{ uid: string; token: string }> = []

  const state = {
    // 復元（initializeAnonymousSession）で得られるUID。
    restoredUid: 'user-1' as string | null,
    // 復元を失敗させたいとき。
    restoreError: undefined as Error | undefined,
    // トークンを取るたびに呼ばれる（同期的に、その瞬間のUIDを切り替えるために使う）。
    onSnapshot: undefined as ((count: number) => void) | undefined,
    // UIDからIDトークンを作る。省略時は `token-of-<uid>`（Emulatorの本物のトークンを使うテストで差し替える）。
    tokenFor: undefined as ((uid: string) => string) | undefined,
  }

  const authenticated = (): AuthStateLike =>
    uid ? { status: 'authenticated', user: { uid, isAnonymous: true } } : { status: 'restoring' }
  const notify = (next: AuthStateLike) => listeners.forEach((listener) => listener(next))

  const fail = (code: 'session_ended' | 'unavailable') => {
    if (!ErrorClassRef) throw new Error('useErrorClass を先に呼んでください')
    return new ErrorClassRef(code)
  }

  const client = {
    observeAuthState: vi.fn((listener: (state: AuthStateLike) => void) => {
      listeners.add(listener)
      listener({ status: 'restoring' })
      if (uid) listener(authenticated())
      return () => {
        listeners.delete(listener)
      }
    }),
    getAuthSnapshot: vi.fn(async () => {
      state.onSnapshot?.(client.getAuthSnapshot.mock.calls.length)
      if (!uid) throw fail('session_ended')
      const snapshot = { uid, token: state.tokenFor?.(uid) ?? tokenOf(uid) }
      issued.push(snapshot)
      return snapshot
    }),
    initializeAnonymousSession: vi.fn(async (): Promise<AuthUser> => {
      if (state.restoreError) throw state.restoreError
      if (!uid && state.restoredUid) api.signInAs(state.restoredUid)
      if (!uid) throw fail('session_ended')
      return { uid, isAnonymous: true }
    }),
    startNewAnonymousSession: vi.fn(async (): Promise<AuthUser> => {
      if (!uid) api.signInAs('new-user')
      return { uid: uid ?? 'new-user', isAnonymous: true }
    }),
  }

  const api = {
    client,
    useErrorClass(errorClass: ErrorClass) {
      ErrorClassRef = errorClass
    },
    state,
    /** 発行したトークンの記録。 */
    issued,
    get uid() {
      return uid
    },
    /** 指定のUIDでサインインし、購読者へ通知する（別のUIDへの切り替えにも使う）。 */
    signInAs(next: string) {
      uid = next
      notify(authenticated())
    },
    /** Firebase側のUIDだけを切り替え、購読者へは通知しない（通知より先に変わる場合の再現）。 */
    switchSilently(next: string | null) {
      uid = next
    },
    /** 購読者へ、いまの状態を通知する。 */
    notifyCurrent() {
      notify(authenticated())
    },
    /** サインアウト（セッション終了）。購読者へ通知する。 */
    endSession() {
      uid = null
      notify({ status: 'session_ended', error: fail('session_ended') })
    },
    /** 認証の確認中に戻す（UIDは変えない）。 */
    restoring() {
      notify({ status: 'restoring' })
    },
    reset() {
      uid = null
      listeners.clear()
      issued.length = 0
      state.restoredUid = 'user-1'
      state.restoreError = undefined
      state.onSnapshot = undefined
      state.tokenFor = undefined
      for (const fn of Object.values(client)) fn.mockClear()
    },
  }
  return api
}

export const fakeAuth = createFakeAuth()
