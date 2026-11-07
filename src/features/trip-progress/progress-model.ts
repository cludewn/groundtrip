import { evidenceStatusLabels, type Evidence, type EvidenceStatus, type Stop } from '@/domain'

// 旅行中の「いまの予定・次の予定」表示が使う、純粋ロジック。
// 進行状態は、利用者の手動操作だけで変わる。現在時刻・位置情報から進行状態を推測しない（ここでも使わない）。
// 共通契約（Trip・Stop・Evidence）の型だけに依存し、他の機能（trip-mapなど）の内部には依存しない。

// 予定の進行状態。色だけに頼らず、状態ごとに固有の文字・形で表す。
export type StopProgress = 'visited' | 'current' | 'upcoming'

export const stopProgressLabels = {
  visited: '訪問済み',
  current: 'いまここ',
  upcoming: 'これから',
} satisfies Record<StopProgress, string>

// 予定の位置を、0〜予定数-1の整数に収める（範囲外・小数・NaNは安全な側へ寄せる）。
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.min(Math.max(Math.trunc(index), 0), length - 1)
}

export function progressOf(stopIndex: number, currentIndex: number): StopProgress {
  if (stopIndex < currentIndex) return 'visited'
  if (stopIndex === currentIndex) return 'current'
  return 'upcoming'
}

export type StepResult = { moved: true; index: number } | { moved: false; index: number }

// ひとつ先へ進める。最後の予定では進めない（範囲を越えない）。
export function stepForward(currentIndex: number, length: number): StepResult {
  const current = clampIndex(currentIndex, length)
  if (current >= length - 1) return { moved: false, index: current }
  return { moved: true, index: current + 1 }
}

// ひとつ前へ戻す（誤操作の取り消し用）。最初の予定では戻せない。
export function stepBack(currentIndex: number, length: number): StepResult {
  const current = clampIndex(currentIndex, length)
  if (current <= 0) return { moved: false, index: current }
  return { moved: true, index: current - 1 }
}

const toMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

const formatMinutes = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`

// 予定の終了時刻（滞在は当日内に収まる契約）。
export function stopEndTime(stop: Pick<Stop, 'plannedStartTime' | 'durationMinutes'>): string {
  return formatMinutes(toMinutes(stop.plannedStartTime) + stop.durationMinutes)
}

// 前の予定の終了から、次の予定の開始までの、予定上の間隔（分）。負なら、予定が重なっている。
// 計画上の時刻の差であり、現在時刻や実際の移動時間ではない。
export function gapMinutes(
  previous: Pick<Stop, 'plannedStartTime' | 'durationMinutes'>,
  next: Pick<Stop, 'plannedStartTime'>,
): number {
  return toMinutes(next.plannedStartTime) - toMinutes(stopEndTime(previous))
}

const severity: Record<EvidenceStatus, number> = { conflicting: 3, unverifiable: 2, consistent: 1 }

// 重大な矛盾・未確認を、「情報源と整合」の陰に隠さない。
function worstOf(evidence: readonly Evidence[]): Evidence | null {
  let worst: Evidence | null = null
  for (const item of evidence) {
    if (!worst || severity[item.status] > severity[worst.status]) worst = item
  }
  return worst
}

export const evidenceSubjectLabels = {
  place_identity: '施設の存在',
  opening_hours: '営業時間',
  travel_time: '移動時間',
  other: 'その他',
} satisfies Record<Evidence['subject'], string>

const SUBJECT_ORDER: readonly Evidence['subject'][] = [
  'place_identity',
  'opening_hours',
  'travel_time',
  'other',
]

export interface EvidenceLine {
  subject: Evidence['subject']
  subjectLabel: string
  status: EvidenceStatus
  statusLabel: string
}

// 予定の根拠の状態を、確認項目ごとに1行にまとめる（項目ごとに最も重い状態）。根拠が無ければ空。
export function evidenceLines(stop: Pick<Stop, 'evidence'>): EvidenceLine[] {
  const lines: EvidenceLine[] = []
  for (const subject of SUBJECT_ORDER) {
    const worst = worstOf(stop.evidence.filter((item) => item.subject === subject))
    if (worst) {
      lines.push({
        subject,
        subjectLabel: evidenceSubjectLabels[subject],
        status: worst.status,
        statusLabel: evidenceStatusLabels[worst.status],
      })
    }
  }
  return lines
}

// 次の予定までの移動の根拠。根拠が無いことと、確認できなかったことを区別する。
export type TravelBasisKind = 'unchecked' | EvidenceStatus

export interface TravelBasis {
  kind: TravelBasisKind
  text: string
  // 模擬データ由来のときは、実測ではないことを併記するために使う。
  simulated: boolean
}

export const travelBasisTexts = {
  unchecked: '移動時間は未確認',
  consistent: '間に合う見込み（情報源と整合）',
  conflicting: '間に合わない見込み（矛盾あり）',
  unverifiable: '移動時間を確認できない',
} satisfies Record<TravelBasisKind, string>

// 次の予定に付いた「移動時間」の根拠から、前の予定の終了後の移動の見通しを説明する。
// 「情報源と整合」は、現実の正しさを保証しない。根拠が無いときに、間に合うと断定しない。
export function travelBasisOf(nextStop: Pick<Stop, 'evidence'>): TravelBasis {
  const worst = worstOf(nextStop.evidence.filter((item) => item.subject === 'travel_time'))
  if (!worst) return { kind: 'unchecked', text: travelBasisTexts.unchecked, simulated: false }
  return {
    kind: worst.status,
    text: travelBasisTexts[worst.status],
    simulated: worst.source.kind === 'simulation',
  }
}
