'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Trip } from '@/domain'
import {
  initializeAnonymousSession,
  startNewAnonymousSession,
} from '@/lib/auth/client'
import { LearningReview } from '@/features/learning-review/learning-review'

import {
  createFirestoreLearningStore,
  loadReflectionHistory,
  loadSavedLearnings,
  loadSavedTrips,
  type LearningList,
  type ReflectionHistory,
} from './api-client'

type SessionPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; trips: Trip[]; warning: string }

type HistoryPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; history: ReflectionHistory }

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : '情報を取得できませんでした。もう一度お試しください。'
}

export function ReflectionFlow({ initialTripId }: { initialTripId?: string }) {
  const [session, setSession] = useState<SessionPhase>({ kind: 'loading' })
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryPhase | null>(null)
  const [reloadAttempt, setReloadAttempt] = useState(0)
  const [saved, setSaved] = useState<LearningList | null>(null)
  const [savedError, setSavedError] = useState('')
  const sessionRequestRef = useRef(0)

  const openSession = useCallback(async (newAccount: boolean) => {
    const request = ++sessionRequestRef.current
    setSession({ kind: 'loading' })
    try {
      if (newAccount) {
        // 過去の匿名UIDを復旧できない可能性を説明したボタンからだけ実行する。
        await startNewAnonymousSession()
      } else {
        await initializeAnonymousSession()
      }
      const list = await loadSavedTrips()
      if (request !== sessionRequestRef.current) return
      const warning =
        list.listInfo.skippedInvalid || list.listInfo.truncated
          ? '一部の旅程を表示できません。保存データの状態を確認してください。'
          : ''
      setSession({ kind: 'ready', trips: list.trips, warning })
      if (initialTripId && list.trips.some((trip) => trip.id === initialTripId)) {
        setSelectedTripId(initialTripId)
      }
    } catch (error) {
      if (request !== sessionRequestRef.current) return
      setSession({ kind: 'error', message: messageOf(error) })
    }
  }, [initialTripId])

  useEffect(() => {
    void openSession(false)
    return () => {
      sessionRequestRef.current += 1
    }
  }, [openSession])

  useEffect(() => {
    if (!selectedTripId || session.kind !== 'ready') {
      setHistory(null)
      return
    }
    const controller = new AbortController()
    setHistory({ kind: 'loading' })
    void loadReflectionHistory(selectedTripId, { signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) setHistory({ kind: 'ready', history: result })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setHistory({ kind: 'error', message: messageOf(error) })
        }
      },
    )
    return () => controller.abort()
  }, [selectedTripId, session.kind, reloadAttempt])

  const refreshSaved = useCallback(async () => {
    try {
      const result = await loadSavedLearnings()
      if (result.listInfo.skippedInvalid || result.listInfo.truncated) {
        setSavedError('保存済みの学びをすべて確認できませんでした。')
        setSaved(null)
        return
      }
      setSaved(result)
      setSavedError('')
    } catch (error) {
      setSaved(null)
      setSavedError(messageOf(error))
    }
  }, [])

  const loadedTripId = history?.kind === 'ready' ? history.history.trip.id : null
  useEffect(() => {
    if (loadedTripId) void refreshSaved()
  }, [loadedTripId, refreshSaved])

  const store = useMemo(
    () => createFirestoreLearningStore(() => void refreshSaved()),
    [refreshSaved],
  )

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">旅の振り返り</h1>
        <p className="text-sm">
          保存した旅程を選び、感想と変更履歴から次の旅のための学びを作ります。
          学びは本人が確認・承認して保存するまで、次回には使われません。
        </p>
      </header>
      {session.kind === 'loading' && (
        <p role="status">保存した旅程と認証状態を確認しています…</p>
      )}
      {session.kind === 'error' && (
        <section className="space-y-3 rounded border border-current/40 p-4">
          <p role="alert">{session.message}</p>
          <p className="text-sm">
            認証に失敗しても、別の匿名アカウントを自動作成しません。
            以前の旅程がある場合は、まず同じブラウザで再試行してください。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-current/50 px-4 py-3"
              onClick={() => void openSession(false)}
            >
              再試行
            </button>
            <button
              type="button"
              className="rounded border border-current/50 px-4 py-3"
              onClick={() => void openSession(true)}
            >
              新しい利用を始める
            </button>
          </div>
          <p className="text-xs">
            新しい利用では別のUIDが使われることがあります。以前の匿名データに戻れるとは限りません。
          </p>
        </section>
      )}
      {session.kind === 'ready' && (
        <section className="space-y-3" aria-labelledby="saved-trips-heading">
          <h2 id="saved-trips-heading" className="text-lg font-semibold">
            保存済みの旅行
          </h2>
          {session.warning && <p role="alert" className="text-sm">{session.warning}</p>}
          {session.trips.length === 0 ? (
            <div className="space-y-2 rounded border border-current/30 p-4 text-sm">
              <p>保存された旅行がありません。</p>
              <p>旅行計画を作るだけではFirestoreに保存されません。保存が完了した旅程だけを振り返りに利用できます。</p>
              <a className="underline" href="/">旅行計画へ戻る</a>
            </div>
          ) : (
            <ul className="space-y-2">
              {session.trips.map((trip) => (
                <li key={trip.id}>
                  <button
                    type="button"
                    aria-pressed={selectedTripId === trip.id}
                    onClick={() => setSelectedTripId(trip.id)}
                    className="w-full rounded border border-current/40 px-4 py-3 text-left aria-pressed:border-2"
                  >
                    <span className="font-medium">{trip.region}</span>
                    <span className="ml-3 text-sm">{trip.date}</span>
                    <span className="block text-sm">
                      {trip.stops.length}地点・{trip.version}版 — 振り返る
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {history?.kind === 'loading' && (
        <p role="status">旅行と変更履歴を読み込んでいます…</p>
      )}
      {history?.kind === 'error' && (
        <section className="space-y-2" role="alert">
          <p>{history.message}</p>
          <p className="text-sm">変更履歴が不完全な場合、誤った学びを作らないため振り返りを開始しません。</p>
          {selectedTripId && (
            <button
              className="rounded border border-current/50 px-4 py-3"
              type="button"
              onClick={() => setReloadAttempt((value) => value + 1)}
            >
              読み込み直す
            </button>
          )}
        </section>
      )}
      {history?.kind === 'ready' && (
        <section className="space-y-4">
          <p className="rounded border border-current/30 p-3 text-sm">
            {history.history.trip.region}（{history.history.trip.date}）の保存済みデータを表示しています。
            保存された変更履歴には、まだ承認されていない提案が含まれる場合があります。
            未承認の変更や模擬報告は、実際に起きた出来事として学びにしません。
          </p>
          <LearningReview
            key={history.history.trip.id}
            trip={history.history.trip}
            revisions={history.history.revisions}
            store={store}
          />
          <section aria-labelledby="saved-learnings-heading" className="space-y-2">
            <h2 id="saved-learnings-heading" className="text-lg font-semibold">
              Firestoreに保存済みの学び
            </h2>
            <button
              type="button"
              className="rounded border border-current/50 px-3 py-2 text-sm"
              onClick={() => void refreshSaved()}
            >
              保存済みの内容を再取得
            </button>
            {savedError && <p role="alert" className="text-sm">{savedError}</p>}
            {!savedError && !saved && <p role="status" className="text-sm">取得中…</p>}
            {saved && saved.learnings.length === 0 && <p className="text-sm">保存済みの学びはありません。</p>}
            {saved && saved.learnings.length > 0 && (
              <ul className="space-y-2">
                {saved.learnings.map(({ learning }) => (
                  <li key={learning.id} className="rounded border border-current/30 p-3 text-sm">
                    <p className="break-words font-medium">{learning.content}</p>
                    <p>
                      適用範囲：
                      {learning.scope.kind === 'all_trips'
                        ? 'すべての旅行'
                        : learning.scope.region + 'の旅行'}
                    </p>
                    <p>元の旅程：{learning.sourceTripId}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
      )}
    </main>
  )
}
