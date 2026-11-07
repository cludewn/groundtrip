import type { Stop, Trip } from '@/domain'

// 照合を行った旅程の記録。basisは照合に送った旅程、resultは返ってきた旅程（根拠つき）。
export interface VerificationRecord {
  basis: Trip
  result: Trip
}

const sameEvidence = (a: Stop, b: Stop): boolean =>
  JSON.stringify(a.evidence) === JSON.stringify(b.evidence)

// 旅程が変わったあと、前回の照合で付いた根拠（とPlace ID）だけを取り下げて、未照合に戻す。
// - 前回の照合結果とまったく同じ根拠を持つ予定は、照合前の状態（basis）に戻す。
// - 変更で新しく付いた根拠（部分修正で差し替えた予定の根拠など）や、新しい予定は、そのまま残す。
// 予定の名称・時刻・固定は、引数のchangedのまま変えない。
export function withdrawVerification(changed: Trip, record: VerificationRecord): Trip {
  const stops = changed.stops.map((stop) => {
    const verified = record.result.stops.find((item) => item.id === stop.id)
    const original = record.basis.stops.find((item) => item.id === stop.id)
    if (!verified || !sameEvidence(stop, verified)) return stop
    const evidence = original?.evidence ?? []
    const placeId = original?.placeId ?? null
    if (stop.evidence.length === 0 && stop.placeId === placeId) return stop
    return { ...stop, evidence, placeId }
  })
  return { ...changed, stops }
}
