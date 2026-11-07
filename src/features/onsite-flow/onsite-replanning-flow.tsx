'use client'

import { useState } from 'react'

import type { Trip } from '@/domain'
import { OnSiteReportForm } from '@/features/onsite-report/onsite-report-form'
import type { OnSiteReportSubmission } from '@/features/onsite-report/report-model'
import { RevisionReview } from '@/features/revision-review/revision-review'
import { sameTrip, type ApplyRevision, type GenerateRevisions } from '@/features/revision-review/api-client'
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

// 再計画だけの画面導線。進行状態は保存しない。候補生成・検証・適用は既存の部分修正処理を使う。
export function OnSiteReplanningFlow({
  trip: sourceTrip,
  generate,
  apply,
  onTripChange,
  initialIndex,
}: OnSiteReplanningFlowProps) {
  const [local, setLocal] = useState<{ source: Trip; value: Trip } | null>(null)
  const trip = local?.source === sourceTrip ? local.value : sourceTrip
  const [step, setStep] = useState<Step>('progress')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [applyUnresolved, setApplyUnresolved] = useState(false)
  const [notice, setNotice] = useState('')

  const target = session && trip.stops.find((stop) => stop.id === session.submission.targetStopId)
  const activeReview =
    step === 'review' &&
    session !== null &&
    target != null &&
    !target.isFixed &&
    sameTrip(session.trip, trip)

  const startReport = (stopId: string) => {
    if (!generate || !trip.stops.some((stop) => stop.id === stopId && !stop.isFixed)) return
    setTargetId(stopId)
    setSession(null)
    setApplyUnresolved(false)
    setNotice('')
    setStep('report')
  }

  const submitReport = (submission: OnSiteReportSubmission) => {
    if (
      !generate ||
      !trip.stops.some((stop) => stop.id === submission.targetStopId && !stop.isFixed)
    ) {
      setNotice('修正できる予定を確認してください。元の旅程は変更していません。')
      return
    }
    setSession({ trip, submission })
    setApplyUnresolved(false)
    setNotice('')
    setStep('review')
  }

  const cancelReview = () => {
    if (applyUnresolved) {
      setNotice('適用結果を確認できませんでした。再操作の前に最新の旅程を確認してください。')
      setSession(null)
      setTargetId(null)
      setStep('progress')
      return
    }
    setSession(null)
    setNotice('報告内容を見直せます。旅程は変更されていません。')
    setStep('report')
  }

  const applied = (next: Trip) => {
    setLocal({ source: sourceTrip, value: next })
    setSession(null)
    setTargetId(null)
    setApplyUnresolved(false)
    setStep('progress')
    setNotice('承認した1件の変更を旅程に反映しました。')
    onTripChange?.(next)
  }

  return (
    <section aria-label="旅行中の再計画" className="mx-auto w-full max-w-xl space-y-3">
      <p role="status" aria-live="polite" className="text-sm not-empty:rounded-lg not-empty:border not-empty:border-gt-rule not-empty:p-3">
        {notice}
      </p>

      {/* 画面を隠してもマウントを維持することで、手動で進めた現在位置を保持する。 */}
      <div hidden={step !== 'progress'}>
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
        <div hidden={step !== 'report'}>
          <div className="px-4 pt-3">
            <button
              type="button"
              className="min-h-11 text-sm font-bold underline"
              onClick={() => {
                setTargetId(null)
                setSession(null)
                setStep('progress')
                setNotice('元の旅程を表示しています。')
              }}
            >
              旅行中の画面に戻る
            </button>
          </div>
          <OnSiteReportForm
            key={`${trip.id}:${trip.version}:${targetId}`}
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
            apply={session.submission.context.report.kind === 'actual' ? apply : undefined}
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

      {step === 'review' && !activeReview && (
        <div role="alert" className="rounded-lg border-2 border-gt-rule p-4 text-sm">
          <p>旅程または固定予定が更新されたため、古い報告からの再計画を中止しました。</p>
          <button
            type="button"
            className="mt-3 min-h-11 font-bold underline"
            onClick={() => {
              setSession(null)
              setTargetId(null)
              setStep('progress')
              setNotice('最新の旅程を確認してから報告し直してください。')
            }}
          >
            旅行中の画面に戻る
          </button>
        </div>
      )}
    </section>
  )
}
