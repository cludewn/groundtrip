import type { ConstraintCheck, Revision, Stop, Trip } from '@/domain'

import {
  EvidenceDetail,
  StatusBadge,
  UnverifiedBadge,
  checkedAtFormat,
} from '@/features/trip-map/evidence-badge'
import { LockIcon } from '@/features/trip-map/icons'
import { endTime, toMinutes } from '@/features/trip-map/model'

import type { TravelComparison, TravelSlot } from './api-client'

const constraints = {
  satisfied: { tone: 'consistent', label: '予定に収まる' },
  violated: { tone: 'conflicting', label: '予定に合わない' },
  unknown: { tone: 'unverifiable', label: '確認が必要' },
  not_checked: { tone: 'unverified', label: '未確認' },
} as const

export function ConstraintBadge({ status }: { status: ConstraintCheck['status'] }) {
  const { tone, label } = constraints[status]
  return <StatusBadge tone={tone}>{label}</StatusBadge>
}

const travelUnknown = {
  not_queried: '未照会',
  no_route: '経路が見つからない',
  api_error: '経路の取得に失敗',
  transit_unsupported: '公共交通は照会対象外',
}

function knownSegment(slot?: TravelSlot) {
  return slot?.presence === 'segment' && slot.segment.status === 'known' ? slot.segment : undefined
}

function travelDifference(before?: TravelSlot, after?: TravelSlot) {
  const original = knownSegment(before)
  const candidate = knownSegment(after)
  if (
    !original ||
    !candidate ||
    original.mode !== candidate.mode ||
    original.source.kind !== candidate.source.kind
  )
    return null
  const difference = candidate.durationMinutes - original.durationMinutes
  if (difference === 0) return '同じ所要時間'
  return difference < 0 ? `${-difference}分短い` : `${difference}分長い`
}

function TravelValue({ slot, baseline }: { slot?: TravelSlot; baseline?: TravelSlot }) {
  if (!slot) return <>移動時間は未取得</>
  if (slot.presence === 'none') return <>該当区間なし</>
  const { segment } = slot
  const difference = baseline ? travelDifference(baseline, slot) : null
  const checkedAt = segment.checkedAt && checkedAtFormat.format(new Date(segment.checkedAt))
  return (
    <>
      {segment.status === 'known' ? (
        <>
          {segment.mode === 'walk' ? '徒歩' : '車'}
          {segment.durationMinutes}分
          {difference && <span className="block text-sm font-semibold">{difference}</span>}
          <span className="block text-xs text-gt-muted">
            {segment.source.kind === 'simulation' ? '模擬データ' : segment.source.label}
          </span>
        </>
      ) : (
        <>確認できない（{travelUnknown[segment.reason]}）</>
      )}
      {checkedAt && <span className="block text-xs text-gt-muted">照合 {checkedAt}</span>}
    </>
  )
}

function StopEvidence({ stop, label }: { stop: Stop; label: string }) {
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-bold">{label}</h4>
      {stop.evidence.length ? (
        stop.evidence.map((evidence) => <EvidenceDetail key={evidence.id} evidence={evidence} />)
      ) : (
        <UnverifiedBadge />
      )}
    </div>
  )
}

export function CandidateComparison({
  trip,
  revision,
  label,
  comparison,
}: {
  trip: Trip
  revision: Revision
  label: string
  comparison?: TravelComparison
}) {
  const { before, after } = revision.diff
  const index = trip.stops.findIndex((stop) => stop.id === revision.targetStopId)
  const previous = trip.stops[index - 1]
  const next = trip.stops[index + 1]
  const fixedStops = trip.stops.filter((stop) => stop.isFixed)
  const onward = knownSegment(comparison?.after.toNext)
  const arrivesInTime =
    revision.constraintCheck.status === 'satisfied' &&
    next &&
    onward &&
    toMinutes(after.plannedStartTime) + after.durationMinutes + onward.durationMinutes <=
      toMinutes(next.plannedStartTime)
  const rows = [
    { label: '場所', before: before.name, after: after.name },
    {
      label: '時刻・滞在',
      before: `${before.plannedStartTime}〜${endTime(before)}（${before.durationMinutes}分）`,
      after: `${after.plannedStartTime}〜${endTime(after)}（${after.durationMinutes}分）`,
    },
    {
      label: '前の予定から',
      before: previous ? <TravelValue slot={comparison?.before.fromPrevious} /> : '該当区間なし',
      after: previous ? (
        <TravelValue
          slot={comparison?.after.fromPrevious}
          baseline={comparison?.before.fromPrevious}
        />
      ) : (
        '該当区間なし'
      ),
    },
    {
      label: '次の予定まで',
      before: next ? <TravelValue slot={comparison?.before.toNext} /> : '該当区間なし',
      after: next ? (
        <TravelValue slot={comparison?.after.toNext} baseline={comparison?.before.toNext} />
      ) : (
        '該当区間なし'
      ),
    },
  ]
  return (
    <div className="gt-enter space-y-4">
      <section aria-label="予定への影響" className="space-y-2 border-t border-gt-rule pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-bold">予定への影響</h4>
          <ConstraintBadge status={revision.constraintCheck.status} />
        </div>
        {arrivesInTime && (
          <p className="text-base font-semibold">
            {next.plannedStartTime}の予定に間に合う見込みです。
          </p>
        )}
        {revision.constraintCheck.status !== 'satisfied' && (
          <p className="text-sm leading-relaxed wrap-anywhere">
            {revision.constraintCheck.explanation}
          </p>
        )}
        <p className="text-sm leading-relaxed wrap-anywhere">{revision.impactSummary}</p>
        {fixedStops.length > 0 ? (
          <>
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <LockIcon size={14} />
              場所・時刻が変わらない固定予定
            </p>
            <ul className="space-y-1 pl-5 text-sm wrap-anywhere">
              {fixedStops.map((stop) => (
                <li key={stop.id}>
                  {stop.plannedStartTime} {stop.name}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-gt-muted">この旅程に固定予定はありません。</p>
        )}
      </section>
      <table className="w-full table-fixed border-collapse text-left text-sm leading-relaxed wrap-anywhere">
        <caption className="sr-only">現在の予定と選択中の候補の差分</caption>
        <thead>
          <tr>
            <th scope="col" className="w-[26%] p-1.5">
              項目
            </th>
            <th scope="col" className="w-[37%] p-1.5">
              今の予定
            </th>
            <th scope="col" className="p-1.5 text-gt-preview">
              {label}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-gt-rule">
              <th scope="row" className="p-1.5 align-top text-sm">
                {row.label}
              </th>
              <td className="p-1.5 align-top">{row.before}</td>
              <td className="p-1.5 align-top">{row.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="space-y-2 border-t border-gt-rule pt-3" aria-label="根拠と照合日時">
        <details>
          <summary className="min-h-11 cursor-pointer py-2.5 font-semibold">
            根拠・情報源を見る
          </summary>
          <div className="space-y-3 pb-2">
            {revision.constraintCheck.status === 'satisfied' && (
              <p className="text-sm leading-relaxed wrap-anywhere">
                {revision.constraintCheck.explanation}
              </p>
            )}
            <StopEvidence stop={before} label="今の予定" />
            <StopEvidence stop={after} label={label} />
          </div>
        </details>
      </section>
    </div>
  )
}
