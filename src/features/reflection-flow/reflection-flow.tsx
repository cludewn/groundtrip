'use client'

import Link from 'next/link'

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { ApprovedLearning, Trip } from '@/domain'
import {
  ClientAuthError,
  initializeAnonymousSession,
  startNewAnonymousSession,
} from '@/lib/auth/client'
import { LearningReview } from '@/features/learning-review/learning-review'

import {
  createFirestoreLearningStore,
  loadReflectionHistory,
  loadSavedLearnings,
  loadSavedTrips,
  sameLearning,
  type LearningList,
  type ReflectionHistory,
} from './api-client'

type SessionPhase =
  | { kind: 'loading' }
  // canStartNew は、利用できる認証状態が無い（session_ended）ときだけ true。
  // 通信断・保存機能の停止・不正な応答では、新しい利用を始めても直らないため、開始操作を出さない。
  | { kind: 'error'; message: string; canStartNew: boolean }
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

const NO_APPROVED: ApprovedLearning[] = []

export function ReflectionFlow({ initialTripId }: { initialTripId?: string }) {
  const [session, setSession] = useState<SessionPhase>({ kind: 'loading' })
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null)
  // 未保存の承認があるときに、別の旅行へ切り替える前の確認を待っている切り替え先。
  const [pendingTripId, setPendingTripId] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryPhase | null>(null)
  const [reloadAttempt, setReloadAttempt] = useState(0)
  const [saved, setSaved] = useState<LearningList | null>(null)
  const [savedError, setSavedError] = useState('')
  const sessionRequestRef = useRef(0)
  const savedRequestRef = useRef(0)
  // いま画面で承認済みの学び（LearningReviewから通知される）。未保存かどうかの判定に使う。
  const approvedRef = useRef<ApprovedLearning[]>(NO_APPROVED)
  const confirmRef = useRef<HTMLDivElement>(null)
  const switchTriggerRef = useRef<HTMLElement | null>(null)

  const openSession = useCallback(
    async (newAccount: boolean) => {
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
        setSession({
          kind: 'error',
          message: messageOf(error),
          canStartNew: error instanceof ClientAuthError && error.code === 'session_ended',
        })
      }
    },
    [initialTripId],
  )

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

  // 保存済みの学びの取得。保存直後の再取得と重なっても、古い応答が新しい一覧を上書きしない。
  const refreshSaved = useCallback(async () => {
    const request = ++savedRequestRef.current
    try {
      const result = await loadSavedLearnings()
      if (request !== savedRequestRef.current) return
      if (result.listInfo.skippedInvalid || result.listInfo.truncated) {
        setSavedError('保存済みの学びをすべて確認できませんでした。')
        setSaved(null)
        return
      }
      setSaved(result)
      setSavedError('')
    } catch (error) {
      if (request !== savedRequestRef.current) return
      setSaved(null)
      setSavedError(messageOf(error))
    }
  }, [])
  useEffect(
    () => () => {
      savedRequestRef.current += 1
    },
    [],
  )

  const loadedTripId = history?.kind === 'ready' ? history.history.trip.id : null
  useEffect(() => {
    if (loadedTripId) void refreshSaved()
  }, [loadedTripId, refreshSaved])

  const store = useMemo(
    () => createFirestoreLearningStore(() => void refreshSaved()),
    [refreshSaved],
  )

  const handleApprovedChange = useCallback((approved: ApprovedLearning[]) => {
    approvedRef.current = approved
  }, [])

  // 保存先に同じ内容で保存されていない承認済みの学びの数。保存済みの一覧を確認できないときは、すべて未保存とみなす。
  const countUnsaved = () =>
    approvedRef.current.filter(
      (approved) => !saved?.learnings.some((entry) => sameLearning(entry.learning, approved)),
    ).length

  const switchTrip = (tripId: string) => {
    approvedRef.current = NO_APPROVED
    setPendingTripId(null)
    setSelectedTripId(tripId)
  }

  const requestTrip = (tripId: string, trigger: HTMLElement) => {
    if (tripId === selectedTripId) {
      setPendingTripId(null)
      return
    }
    // 別の旅行へ切り替えると、確認中の候補・承認・入力は消える。未保存の承認があるときは、先に確認する。
    if (history?.kind === 'ready' && countUnsaved() > 0) {
      switchTriggerRef.current = trigger
      setPendingTripId(tripId)
      return
    }
    switchTrip(tripId)
  }

  useEffect(() => {
    if (pendingTripId) confirmRef.current?.focus()
  }, [pendingTripId])

  const cancelSwitch = () => {
    setPendingTripId(null)
    switchTriggerRef.current?.focus()
  }
  const confirmSwitch = () => {
    if (!pendingTripId) return
    switchTrip(pendingTripId)
    switchTriggerRef.current?.focus()
  }
  const onConfirmKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') cancelSwitch()
  }

  const sessionTrips = session.kind === 'ready' ? session.trips : []
  const pendingTrip = sessionTrips.find((trip) => trip.id === pendingTripId)
  const sourceTripLabel = (sourceTripId: string): string => {
    const trip = sessionTrips.find((candidate) => candidate.id === sourceTripId)
    return trip ? trip.region + '（' + trip.date + '）' : '保存済みの旅行の一覧にない旅行'
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">保存した旅行を振り返る</h1>
        <p className="text-sm">
          保存した旅程を選び、感想と変更履歴から次の旅のための学びを作ります。
          学びは本人が確認・承認して保存するまで、次回には使われません。
        </p>
      </header>
      {session.kind === 'loading' && <p role="status">保存した旅程と認証状態を確認しています…</p>}
      {session.kind === 'error' && (
        <section className="space-y-3 rounded border border-current/40 p-4">
          <p role="alert">{session.message}</p>
          {session.canStartNew && (
            <>
              <p className="text-sm">
                認証に失敗しても、別の匿名アカウントを自動作成しません。
                以前の旅程がある場合は、まず同じブラウザで再試行してください。
              </p>
              <p id="new-session-warning" className="text-sm font-medium">
                新しい利用を始めると、これまでの旅行や学びの保存データに戻れないことがあります。
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-current/50 px-4 py-3"
              onClick={() => void openSession(false)}
            >
              再試行
            </button>
            {session.canStartNew && (
              <button
                type="button"
                aria-describedby="new-session-warning"
                className="rounded border border-current/50 px-4 py-3"
                onClick={() => void openSession(true)}
              >
                新しい利用を始める
              </button>
            )}
          </div>
        </section>
      )}
      {session.kind === 'ready' && (
        <section className="space-y-3" aria-labelledby="saved-trips-heading">
          <h2 id="saved-trips-heading" className="text-lg font-semibold">
            保存済みの旅行
          </h2>
          {session.warning && (
            <p role="alert" className="text-sm">
              {session.warning}
            </p>
          )}
          {session.trips.length === 0 ? (
            <div className="space-y-2 rounded border border-current/30 p-4 text-sm">
              <p>保存された旅行がありません。</p>
              <p>
                旅行計画を作るだけでは保存されません。保存が完了した旅程だけを、振り返りに使えます。
              </p>
              <Link className="underline" href="/">
                旅行計画へ戻る
              </Link>
            </div>
          ) : (
            <ul className="space-y-2">
              {session.trips.map((trip) => (
                <li key={trip.id}>
                  <button
                    type="button"
                    aria-pressed={selectedTripId === trip.id}
                    onClick={(event) => requestTrip(trip.id, event.currentTarget)}
                    className="w-full rounded border border-current/40 px-4 py-3 text-left aria-pressed:border-2"
                  >
                    <span className="font-medium">{trip.region}</span>
                    <span className="ml-3 text-sm">{trip.date}</span>
                    <span className="block text-sm">
                      {trip.stops.length}地点・保存済み — 振り返る
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pendingTripId && (
            <div
              ref={confirmRef}
              tabIndex={-1}
              role="group"
              aria-labelledby="switch-confirm-heading"
              aria-describedby="switch-confirm-description"
              onKeyDown={onConfirmKeyDown}
              className="space-y-3 rounded border-2 border-current p-4"
            >
              <h3 id="switch-confirm-heading" className="text-base font-semibold">
                まだ保存していない承認済みの学びがあります
              </h3>
              <p id="switch-confirm-description" className="text-sm">
                {pendingTrip ? pendingTrip.region + '（' + pendingTrip.date + '）' : '別の旅行'}
                に切り替えると、保存していない承認済みの学びと、入力した感想・確認中の候補は消えます。
                すでに保存した学びは消えません。
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded border border-current/50 px-4 py-3"
                  onClick={cancelSwitch}
                >
                  この旅行に残る
                </button>
                <button
                  type="button"
                  className="rounded border border-current/50 px-4 py-3"
                  onClick={confirmSwitch}
                >
                  保存せずに切り替える
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      {history?.kind === 'loading' && <p role="status">旅行と変更履歴を読み込んでいます…</p>}
      {history?.kind === 'error' && (
        <section className="space-y-2" role="alert">
          <p>{history.message}</p>
          <p className="text-sm">
            変更履歴が不完全な場合、誤った学びを作らないため振り返りを開始しません。
          </p>
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
            {history.history.trip.region}（{history.history.trip.date}
            ）の保存済みデータを表示しています。 保存された修正案は、すべて未承認です。
            未承認の変更や模擬報告は、実際に起きた出来事として学びにしません。
          </p>
          <LearningReview
            key={history.history.trip.id}
            trip={history.history.trip}
            revisions={history.history.revisions}
            store={store}
            onApprovedChange={handleApprovedChange}
          />
          <section aria-labelledby="saved-learnings-heading" className="space-y-2">
            <h2 id="saved-learnings-heading" className="text-lg font-semibold">
              保存済みの学び
            </h2>
            <button
              type="button"
              className="rounded border border-current/50 px-3 py-2 text-sm"
              onClick={() => void refreshSaved()}
            >
              保存済みの学びを読み込み直す
            </button>
            {savedError && (
              <p role="alert" className="text-sm">
                {savedError}
              </p>
            )}
            {!savedError && !saved && (
              <p role="status" className="text-sm">
                取得中…
              </p>
            )}
            {saved && saved.learnings.length === 0 && (
              <p className="text-sm">保存済みの学びはありません。</p>
            )}
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
                    <p className="break-words">
                      元の旅行：{sourceTripLabel(learning.sourceTripId)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
      )}
    </div>
  )
}
