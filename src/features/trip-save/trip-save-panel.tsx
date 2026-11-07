'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'

import type { Trip } from '@/domain'
import { initializeAnonymousSession, startNewAnonymousSession, getAuthHeaders } from '@/lib/auth/client'
import { CreateTripBodySchema, TripResponseSchema } from '@/server/persistence/contracts'

type SaveState =
  | { phase: 'idle' | 'checking' | 'starting' | 'saving' | 'needs_session' }
  | { phase: 'error'; message: string }
  | { phase: 'saved'; tripId: string }

// 旅程の提案を、本人が明示的に保存するときだけFirestore APIへ送る。
// 保存の応答を契約で検証し、確認できない変更を「保存済み」にしない。
export function TripSavePanel({ trip }: { trip: Trip }) {
  const [state, setState] = useState<SaveState>({ phase: 'idle' })
  const [knownTrip, setKnownTrip] = useState(trip)
  const busy = useRef(false)
  // 別の旅程や画面上の固定変更では、以前の保存成功を流用しない。
  if (knownTrip !== trip) {
    setKnownTrip(trip)
    setState({ phase: 'idle' })
  }

  async function startSession() {
    if (busy.current) return
    busy.current = true
    setState({ phase: 'starting' })
    try {
      await startNewAnonymousSession()
      setState({ phase: 'idle' })
    } catch {
      setState({ phase: 'error', message: '利用の開始に失敗しました。認証設定を確認してください。' })
    } finally {
      busy.current = false
    }
  }

  async function save() {
    if (busy.current) return
    const checked = CreateTripBodySchema.safeParse(trip)
    if (!checked.success) {
      setState({
        phase: 'error',
        message: trip.learningApplications.length > 0
          ? '学びの適用履歴がある旅程の保存は、サーバーの適用確認に未接続です。'
          : 'この旅程は保存用の条件を満たしていません。',
      })
      return
    }
    busy.current = true
    setState({ phase: 'checking' })
    try {
      // 復元のみ。エラー時に勝手に匿名UIDを作らない。
      await initializeAnonymousSession()
    } catch {
      setState({ phase: 'needs_session' })
      busy.current = false
      return
    }
    try {
      setState({ phase: 'saving' })
      const headers = await getAuthHeaders()
      headers.set('Content-Type', 'application/json')
      const response = await fetch('/api/trips', {
        method: 'POST',
        headers,
        body: JSON.stringify(checked.data),
        cache: 'no-store',
      })
      const parsed = TripResponseSchema.safeParse(await response.json())
      if (!response.ok || !parsed.success || parsed.data.trip.id !== checked.data.id) {
        throw new Error(
          response.status === 409
            ? 'この旅程はすでに保存済みか、保存件数の上限です。保存済み一覧を確認してください。'
            : response.status === 503
              ? '保存サービスは現在利用できません。'
              : response.status === 401
                ? '認証状態を確認できません。'
                : '保存を確認できませんでした。再操作する前に保存済み一覧を確認してください。',
        )
      }
      setState({ phase: 'saved', tripId: parsed.data.trip.id })
    } catch (error) {
      setState({
        phase: 'error',
        message: error instanceof Error
          ? error.message
          : '保存結果を確認できませんでした。保存済み一覧で確認してください。',
      })
    } finally {
      busy.current = false
    }
  }

  return (
    <section aria-label="旅程を保存して振り返る" className="space-y-3 rounded-xl border border-gt-rule p-4">
      <h2 className="text-lg font-semibold">この旅程を保存する</h2>
      <p className="text-sm">
        AIの提案を確認したうえで、本人が選ぶ操作です。
        保存されても施設の予約や、当日の営業を保証するものではありません。
      </p>
      {state.phase === 'saved' ? (
        <div role="status" className="space-y-2">
          <p>Firestoreへの保存を確認しました。</p>
          <Link
            className="inline-flex min-h-11 items-center font-semibold underline"
            href={'/reflection?tripId=' + encodeURIComponent(state.tripId)}
          >
            保存した旅程を振り返る
          </Link>
        </div>
      ) : (
        <>
          <button
            type="button"
            disabled={busy.current || state.phase === 'checking' || state.phase === 'saving' || state.phase === 'starting'}
            onClick={() => void save()}
            className="min-h-11 rounded-lg border-2 border-gt-ink px-4 py-2 font-semibold disabled:opacity-50"
          >
            {state.phase === 'saving' || state.phase === 'checking'
              ? '保存を確認中…'
              : '本人の操作で旅程を保存する'}
          </button>
          {state.phase === 'needs_session' && (
            <div role="alert" className="space-y-2 text-sm">
              <p>保存するにはFirebaseの利用者識別が必要です。新しい匿名利用を始めると、以前のUIDのデータにアクセスできなくなる場合があります。</p>
              <button
                type="button"
                onClick={() => void startSession()}
                className="min-h-11 rounded border border-gt-rule px-3 py-2 font-semibold"
              >
                新しい利用を始める
              </button>
            </div>
          )}
          {state.phase === 'error' && <p role="alert" className="text-sm">{state.message}</p>}
          <Link className="inline-flex min-h-11 items-center text-sm underline" href="/reflection">
            保存済みの旅程を確認する
          </Link>
        </>
      )}
      <p className="text-xs text-gt-muted">
        保存APIは既定で無効です。安全な公開設定が整うまで、一般公開では有効にしません。
      </p>
    </section>
  )
}
