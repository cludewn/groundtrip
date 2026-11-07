import { useId, type ReactNode } from 'react'

import { evidenceStatusLabels } from '@/domain'
import { GoogleMapsSourceBox } from '@/features/legal/google-maps-attribution'
import { checkedAtFormat, StatusBadge } from '@/features/trip-map/evidence-badge'

import { verificationFailureGuidance } from './failure-messages'
import type { VerificationPhase } from './use-trip-verification'
import type { VerificationSummary } from './verification-summary'

// 旅程の根拠の確認状態。通信の状態（確認中・失敗）と、旅程に対する結果（未確認・照合結果あり・変更後は未確認）を合わせて表示する。
export type PanelStatus =
  | { kind: 'unverified' }
  | { kind: 'withdrawn' }
  | { kind: 'verified'; summary: VerificationSummary }

interface VerificationPanelProps {
  status: PanelStatus
  phase: VerificationPhase
  onVerify: () => void
}

// 確認した範囲（適用範囲）。確認していないことも併記し、整合を正しさの保証と受け取らせない。
function Scope() {
  return (
    <p className="text-sm text-gt-muted">
      確認した範囲：施設の存在（名称と地域）、通常の営業時間、徒歩での移動。臨時休業・混雑・公共交通は確認していません。
      「情報源と整合」は、確認できた情報と一致したという意味で、現実の正しさや当日の営業を保証するものではありません。
    </p>
  )
}

const statusOrder = ['consistent', 'conflicting', 'unverifiable'] as const

function VerifiedResult({ summary }: { summary: VerificationSummary }) {
  const body = (
    <div className="space-y-1">
      <p className="font-semibold">状態：照合結果あり</p>
      {summary.total === 0 ? (
        <p className="text-sm">照合しましたが、根拠を付けられた予定はありませんでした。</p>
      ) : (
        <p className="text-sm">
          {statusOrder.map((key, index) => (
            <span key={key}>
              {index > 0 && '／'}
              {evidenceStatusLabels[key]} {summary.counts[key]}件
            </span>
          ))}
          {summary.latestCheckedAt &&
            `（${checkedAtFormat.format(new Date(summary.latestCheckedAt))}時点）`}
        </p>
      )}
      <p className="text-sm">各予定の詳細で、確認項目・情報源・照合日時・理由を見られます。</p>
      <Scope />
    </div>
  )
  // Google Maps Platform由来の内容は、枠で囲み、枠の下に帰属を付ける。
  return summary.usesGoogle ? (
    <GoogleMapsSourceBox caption="確認に使った情報源">{body}</GoogleMapsSourceBox>
  ) : (
    body
  )
}

function Failure({
  failure,
}: {
  failure: Extract<VerificationPhase, { phase: 'failed' }>['failure']
}) {
  const guidance = verificationFailureGuidance[failure.kind]
  return (
    <div className="gt-notice" data-tone="error">
      <p className="flex items-center gap-2 font-black text-gt-warn">
        <span
          aria-hidden="true"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-gt-warn text-xs text-white"
        >
          !
        </span>
        エラー：{guidance.title}
      </p>
      <p className="mt-1 text-sm">{guidance.action}</p>
      <p className="mt-1 text-sm">詳細：{failure.message}</p>
    </div>
  )
}

export function VerificationPanel({ status, phase, onVerify }: VerificationPanelProps) {
  const headingId = useId()
  const verifying = phase.phase === 'verifying'

  let content: ReactNode
  if (verifying) {
    content = (
      <p className="text-sm font-semibold">根拠を確認しています。しばらくお待ちください。</p>
    )
  } else if (status.kind === 'verified') {
    content = <VerifiedResult summary={status.summary} />
  } else {
    content = (
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          状態：
          <StatusBadge tone="unverified">
            {status.kind === 'withdrawn' ? '変更後は未確認' : '未確認'}
          </StatusBadge>
        </p>
        <p className="text-sm">
          {status.kind === 'withdrawn'
            ? '旅程を変更したため、前回の照合結果は取り下げました。変更後の旅程は、施設の存在・営業時間・移動をまだ外部の情報源と照合していません。'
            : '施設の存在・営業時間・移動を、まだ外部の情報源と照合していません。AIが作った提案のままです。'}
        </p>
      </div>
    )
  }

  const label = verifying
    ? '確認しています…'
    : status.kind === 'verified' || phase.phase === 'failed'
      ? 'もう一度確認する'
      : '根拠を確認する'

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-2xl border border-gt-rule bg-gt-paper p-4"
    >
      <h3 id={headingId} className="text-base font-semibold">
        根拠の確認
      </h3>
      {/* 結果の通知。状態が変わるたびに、テキストの更新として読み上げる。 */}
      <div role="status" aria-live="polite" aria-atomic="true" className="space-y-3">
        {content}
        {!verifying && phase.phase === 'failed' && <Failure failure={phase.failure} />}
      </div>
      <div className="space-y-1">
        {/* 実行中も同じ位置に残し（フォーカスを失わない）、押下は受け付けない。 */}
        <button
          type="button"
          aria-disabled={verifying}
          onClick={() => {
            if (!verifying) onVerify()
          }}
          className="min-h-12 w-full rounded-xl bg-gt-ink px-4 py-3 text-base font-semibold text-white aria-disabled:cursor-progress aria-disabled:opacity-60"
        >
          {label}
        </button>
        <p className="text-xs text-gt-muted">
          押したときに1回だけ、外部の情報源（Google Maps
          Platform）へ問い合わせます。自動では行いません。旅程は変わりません。
        </p>
      </div>
    </section>
  )
}
