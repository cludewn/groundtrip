'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { Trip } from '@/domain'
import { OnSiteReportForm } from '@/features/onsite-report/onsite-report-form'
import type { OnSiteReportSubmission } from '@/features/onsite-report/report-model'
import { RevisionReview } from '@/features/revision-review/revision-review'
import {
  sameTrip,
  type ApplyRevision,
  type GenerateRevisions,
} from '@/features/revision-review/api-client'
import { TripProgressView } from '@/features/trip-progress/trip-progress-view'

interface OnSiteReplanningFlowProps {
  trip: Trip
  generate?: GenerateRevisions
  apply?: ApplyRevision
  onTripChange?: (trip: Trip) => void
  initialIndex?: number
}

type Step = 'progress' | 'report' | 'review'
type Session = { trip: Trip; submission: OnSiteReportSubmission }
// 画面を切り替えたあとにフォーカスを移す先。
type FocusTarget = 'progress' | 'report' | 'unresolved'

const unresolvedMessage =
  '適用結果を確認できませんでした。再操作する前に最新の旅程を確認してください。'
// 子の画面の見出し。画面ごとの切り替えでフォーカスを失わないよう、ここから探して移す。
const progressHeadingSelector = '#trip-progress-current'
const reportHeadingSelector = 'h2'

// 同じ内容でも、トップレベルの参照が違うだけの旅程は同じものとして扱う。
const sameSource = (left: Trip, right: Trip) => left === right || sameTrip(left, right)

// 再計画だけの画面導線。進行状態は保存しない。候補生成・検証・適用は既存の部分修正処理を使う。
export function OnSiteReplanningFlow({
  trip: sourceTrip,
  generate,
  apply,
  onTripChange,
  initialIndex,
}: OnSiteReplanningFlowProps) {
  const [local, setLocal] = useState<{ source: Trip; value: Trip } | null>(null)
  const trip = local && sameSource(local.source, sourceTrip) ? local.value : sourceTrip

  const [step, setStep] = useState<Step>('progress')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [applyUnresolved, setApplyUnresolved] = useState(false)
  // 同じ文言が続いても読み上げ直されるよう、更新のたびに数える。
  const [notice, setNotice] = useState({ text: '', tick: 0 })
  const [focusRequest, setFocusRequest] = useState<{ to: FocusTarget } | null>(null)
  const progressArea = useRef<HTMLDivElement>(null)
  const reportArea = useRef<HTMLDivElement>(null)
  const unresolvedNote = useRef<HTMLDivElement>(null)
  const staleAlert = useRef<HTMLDivElement>(null)

  const announce = (text: string) => setNotice((previous) => ({ text, tick: previous.tick + 1 }))
  const moveFocus = (to: FocusTarget) => setFocusRequest({ to })

  // 報告の入力中に旅程の版が変わると、フォームは作り直される。無言で消さずに知らせる。
  const tripKey = `${trip.id}:${trip.version}`
  const [seenTripKey, setSeenTripKey] = useState(tripKey)
  if (seenTripKey !== tripKey) {
    setSeenTripKey(tripKey)
    if (step === 'report' && targetId) announce('旅程が更新されたため入力をリセットしました。')
  }

  const target = session && trip.stops.find((stop) => stop.id === session.submission.targetStopId)
  const activeReview =
    step === 'review' &&
    session !== null &&
    target != null &&
    !target.isFixed &&
    sameTrip(session.trip, trip)
  const stale = step === 'review' && !activeReview

  // 切り替えた先の見出しなどへフォーカスを移す。隠していた画面は、このコミットで表示される。
  useEffect(() => {
    if (!focusRequest) return
    const element =
      focusRequest.to === 'unresolved'
        ? unresolvedNote.current
        : focusRequest.to === 'report'
          ? reportArea.current?.querySelector<HTMLElement>(reportHeadingSelector)
          : progressArea.current?.querySelector<HTMLElement>(progressHeadingSelector)
    if (!element) return
    // 見出しは通常フォーカスできない。プログラムからだけフォーカスできるようにする。
    if (!element.hasAttribute('tabindex')) element.tabIndex = -1
    element.focus()
  }, [focusRequest])

  // 親の更新で比較画面が消えると、フォーカスが失われる。中止の通知へ移す。
  useLayoutEffect(() => {
    if (stale && document.activeElement === document.body) staleAlert.current?.focus()
  }, [stale])

  const startReport = (stopId: string) => {
    if (!generate || !trip.stops.some((stop) => stop.id === stopId && !stop.isFixed)) return
    if (applyUnresolved) {
      // 前回の適用結果が分からないまま、古い旅程から報告を始めさせない。
      announce('適用結果を確認できていません。最新の旅程を確認してから、報告を始めてください。')
      moveFocus('unresolved')
      return
    }
    setTargetId(stopId)
    setSession(null)
    announce('')
    setStep('report')
    moveFocus('report')
  }

  const submitReport = (submission: OnSiteReportSubmission) => {
    if (
      !generate ||
      !trip.stops.some((stop) => stop.id === submission.targetStopId && !stop.isFixed)
    ) {
      announce('修正できる予定を確認してください。元の旅程は変更していません。')
      return
    }
    setSession({ trip, submission })
    announce('')
    setStep('review')
  }

  // 適用結果が不明なまま進行画面へ戻る。確認するまで、不明の状態は保つ。
  const leaveUnresolved = () => {
    announce(unresolvedMessage)
    setSession(null)
    setTargetId(null)
    setStep('progress')
    moveFocus('unresolved')
  }

  const cancelReview = () => {
    if (applyUnresolved) {
      leaveUnresolved()
      return
    }
    setSession(null)
    announce('報告内容を見直せます。旅程は変更されていません。')
    setStep('report')
    moveFocus('report')
  }

  const applied = (next: Trip) => {
    // 応答は送信時点の画面の関数で受けるため、sourceTripの参照が古いことがある。
    // 参照ではなく内容（sameSource）で比べるので、同じ内容の旅程なら適用後の表示を保つ。
    setLocal({ source: sourceTrip, value: next })
    setSession(null)
    setTargetId(null)
    setApplyUnresolved(false)
    setStep('progress')
    announce('承認した1件の変更を旅程に反映しました。')
    moveFocus('progress')
    onTripChange?.(next)
  }

  const confirmLatestTrip = () => {
    setApplyUnresolved(false)
    announce('最新の旅程を確認したものとして、再計画を始められます。')
    moveFocus('progress')
  }

  return (
    <section aria-label="旅行中の再計画" className="mx-auto w-full max-w-xl space-y-3">
      <p
        role="status"
        aria-live="polite"
        className="text-sm not-empty:rounded-lg not-empty:border not-empty:border-gt-rule not-empty:p-3"
      >
        {notice.text && <span key={notice.tick}>{notice.text}</span>}
      </p>

      {/* 画面を隠してもマウントを維持することで、手動で進めた現在位置を保持する。 */}
      <div hidden={step !== 'progress'} ref={progressArea}>
        {applyUnresolved && (
          <div
            ref={unresolvedNote}
            role="note"
            tabIndex={-1}
            className="mx-4 mt-3 space-y-2 rounded-lg border-2 border-gt-rule p-3 text-sm"
          >
            <p className="font-bold">
              直前の適用結果を確認できていません。最新の旅程を確認してから、報告を始めてください。
            </p>
            <button
              type="button"
              className="min-h-11 text-sm font-bold underline"
              onClick={confirmLatestTrip}
            >
              最新の旅程を確認した
            </button>
          </div>
        )}
        <TripProgressView
          trip={trip}
          initialIndex={initialIndex}
          onReplan={generate ? startReport : undefined}
        />
        {!generate && (
          <p className="px-4 text-sm text-gt-muted">
            現地報告からの再計画は、候補生成サービスを接続すると利用できます。
          </p>
        )}
      </div>

      {/* 報告を修正するために戻っても入力内容を維持する。 */}
      {targetId && (
        <div hidden={step !== 'report'} ref={reportArea}>
          <div className="px-4 pt-3">
            <button
              type="button"
              className="min-h-11 text-sm font-bold underline"
              onClick={() => {
                setTargetId(null)
                setSession(null)
                setStep('progress')
                announce('元の旅程を表示しています。')
                moveFocus('progress')
              }}
            >
              旅行中の画面に戻る
            </button>
          </div>
          <OnSiteReportForm
            key={`${tripKey}:${targetId}`}
            trip={trip}
            initialTargetStopId={targetId}
            status={{ phase: 'idle' }}
            onSubmit={submitReport}
          />
        </div>
      )}

      {activeReview && session && target && generate && (
        <div className="space-y-3">
          {session.submission.context.report.kind === 'simulated' && (
            <p role="note" className="rounded-lg border-2 border-dashed border-gt-rule p-3 text-sm">
              デモ用の想定です。現地で実際に起きたことではありません。候補を比較できますが、旅程には適用しません。
            </p>
          )}
          {session.submission.context.report.kind === 'actual' && (
            <p className="rounded-lg border border-gt-rule p-3 text-sm text-gt-muted">
              現地での報告は利用者による申告です。Placesなどの照合結果と区別して扱います。
            </p>
          )}
          <RevisionReview
            key={`${trip.id}:${trip.version}:${target.id}`}
            trip={trip}
            target={target}
            generate={generate}
            // 模擬報告では適用の経路そのものを渡さず、承認が旅程へ届かないようにする。
            apply={session.submission.context.report.kind === 'actual' ? apply : undefined}
            applyUnavailableReason={
              session.submission.context.report.kind === 'simulated'
                ? '模擬報告のため適用できません。'
                : undefined
            }
            onSiteReport={{
              reason: session.submission.reason,
              context: session.submission.context,
            }}
            onCancel={cancelReview}
            onApplied={applied}
            onApplyUnresolvedChange={setApplyUnresolved}
          />
        </div>
      )}

      {stale && (
        <div
          ref={staleAlert}
          role="alert"
          tabIndex={-1}
          className="rounded-lg border-2 border-gt-rule p-4 text-sm"
        >
          <p>
            {applyUnresolved
              ? unresolvedMessage
              : '旅程または固定予定が更新されたため、古い報告からの再計画を中止しました。'}
          </p>
          <button
            type="button"
            className="mt-3 min-h-11 font-bold underline"
            onClick={() => {
              if (applyUnresolved) {
                leaveUnresolved()
                return
              }
              setSession(null)
              setTargetId(null)
              setStep('progress')
              announce('最新の旅程を確認してから報告し直してください。')
              moveFocus('progress')
            }}
          >
            旅行中の画面に戻る
          </button>
        </div>
      )}
    </section>
  )
}
