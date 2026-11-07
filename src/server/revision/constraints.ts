import type { ConstraintCheck, Evidence, Stop, Trip } from '../../domain'

// 候補を旅程へ入れた状態で照合した結果（verifyTrip）から、決定論的な制約検証の結果を導く純粋ロジック。
// 他の予定の時刻は動かさないため、次の予定が固定予定でも、「候補の終了＋移動時間 ≦ 次の予定の開始」で、
// 固定予定への到達も判定できる。

export interface CandidateChecks {
  identity: Evidence | null
  hours: Evidence | null
  // 前の予定 → 候補。対象が最初の予定なら無い。
  travelBefore: Evidence | null
  // 候補 → 次の予定。対象が最後の予定なら無い。
  travelAfter: Evidence | null
}

const byId = (stop: Stop, suffix: string): Evidence | null =>
  stop.evidence.find((item) => item.id === `evidence-${stop.id}-${suffix}`) ?? null

// 照合済みの旅程から、対象の予定（候補）と、その次の予定の根拠を取り出す。
export function collectChecks(verified: Trip, targetStopId: string): CandidateChecks {
  const index = verified.stops.findIndex((stop) => stop.id === targetStopId)
  const target = verified.stops[index]
  const next = verified.stops[index + 1]
  return {
    identity: target ? byId(target, 'place') : null,
    hours: target ? byId(target, 'hours') : null,
    travelBefore: target ? byId(target, 'travel') : null,
    travelAfter: next ? byId(next, 'travel') : null,
  }
}

export type CandidateJudgement =
  | { status: 'excluded'; reason: 'unidentified' | 'violated'; explanation: string }
  | { status: 'candidate'; constraintCheck: ConstraintCheck }

// 候補として残すかと、残す場合の制約検証の結果。
// - 施設を特定できない（候補なし・名称不一致・複数で絞れない・検索失敗）：実在を確認できないため、候補にしない。
// - 営業時間が矛盾、または前後どちらかの移動が間に合わない：成立しないため、候補にしない（violated）。
// - すべて「情報源と整合」：satisfied。それ以外（確認できない項目がある）：unknown（承認はできない）。
export function judgeCandidate(checks: CandidateChecks): CandidateJudgement {
  if (checks.identity?.status !== 'consistent') {
    return {
      status: 'excluded',
      reason: 'unidentified',
      explanation: '施設を特定できないため、候補にできません。',
    }
  }

  const items: { label: string; evidence: Evidence | null }[] = [
    { label: '営業時間', evidence: checks.hours },
    { label: '前の予定からの移動', evidence: checks.travelBefore },
    { label: '次の予定への移動', evidence: checks.travelAfter },
  ]
  const present = items.filter(
    (item): item is { label: string; evidence: Evidence } => item.evidence !== null,
  )

  const conflicting = present.filter((item) => item.evidence.status === 'conflicting')
  if (conflicting.length > 0) {
    return {
      status: 'excluded',
      reason: 'violated',
      explanation: `${conflicting.map((item) => item.label).join('・')}が成立しないため、候補にできません。`,
    }
  }

  // 営業時間は必須の確認項目。移動は、対象の位置によって、前後のどちらかが無いことがある。
  const allConsistent =
    checks.hours !== null && present.every((i) => i.evidence.status === 'consistent')
  if (allConsistent) {
    return {
      status: 'candidate',
      constraintCheck: {
        status: 'satisfied',
        explanation: `${present.map((item) => item.label).join('・')}は、情報源と整合しています。臨時休業・渋滞・遅延は考慮していません。`,
      },
    }
  }
  const unverified = present.filter((item) => item.evidence.status !== 'consistent')
  return {
    status: 'candidate',
    constraintCheck: {
      status: 'unknown',
      explanation: `${unverified.map((item) => item.label).join('・')}を確認できていません。確認できるまで、承認できません。`,
    },
  }
}
