'use client'

import { useEffect, useRef, useState } from 'react'

import { observeAuthState, type ClientAuthError } from './client'
import { createSessionScope, type SessionScope } from './session-scope'

// scopeEpochは、認証済みのUIDが別のUIDへ変わるたびに1ずつ増える整数（このフックの利用単位で単調増加）。
// 同じUIDの再通知（トークン更新・再検証）では増えない。最初の認証でも増えない。
// 利用側はscopeEpochまたはscope.uidが変わったら、表示・編集・選択・進行中の読み込みを捨てる。
export type SessionScopeState =
  | { status: 'restoring'; scopeEpoch: number }
  | { status: 'authenticated'; scope: SessionScope; scopeEpoch: number }
  | { status: 'session_ended'; error: ClientAuthError; scopeEpoch: number }
  | { status: 'error'; error: ClientAuthError; scopeEpoch: number }

// 認証状態を購読し、保存・生成などの操作に使うスコープを返す。
// restoring / session_ended / error ではscopeが無く、操作を始められない。
// どの状態でも匿名アカウントは作らない（新規開始は明示操作のstartNewAnonymousSessionだけ）。
export function useSessionScope(): SessionScopeState {
  const [state, setState] = useState<SessionScopeState>({ status: 'restoring', scopeEpoch: 0 })
  // 開発時のStrict Modeによる購読の張り直しでも、世代が戻らないようrefで持つ。
  const epochRef = useRef(0)
  const scopeRef = useRef<SessionScope | undefined>(undefined)

  useEffect(() => {
    const stop = observeAuthState((auth) => {
      if (auth.status === 'authenticated') {
        const { uid } = auth.user
        const previous = scopeRef.current
        if (previous && previous.uid !== uid) epochRef.current += 1
        // 同じUIDの間は同じスコープ（同一参照）を返し、利用側の不要な再実行を避ける。
        const scope = previous?.uid === uid ? previous : createSessionScope(uid)
        scopeRef.current = scope
        // 更新関数は後から実行されうるため、この通知時点の世代を固定して使う。
        const scopeEpoch = epochRef.current
        setState((prev) =>
          prev.status === 'authenticated' && prev.scope === scope && prev.scopeEpoch === scopeEpoch
            ? prev
            : { status: 'authenticated', scope, scopeEpoch },
        )
        return
      }
      const scopeEpoch = epochRef.current
      if (auth.status === 'restoring') {
        setState((prev) =>
          prev.status === 'restoring' && prev.scopeEpoch === scopeEpoch
            ? prev
            : { status: 'restoring', scopeEpoch },
        )
        return
      }
      setState({ status: auth.status, error: auth.error, scopeEpoch })
    })
    return stop
  }, [])

  return state
}
