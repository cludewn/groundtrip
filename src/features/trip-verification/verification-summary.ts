import type { EvidenceStatus, Trip } from '@/domain'
import { isGoogleSource } from '@/features/trip-map/model'

export interface VerificationSummary {
  counts: Record<EvidenceStatus, number>
  total: number
  // 根拠のうち、最も新しい照合日時（根拠がなければnull）。
  latestCheckedAt: string | null
  // Google Maps Platform（Places・Routes）由来の根拠を含むか。帰属表示の要否に使う。
  usesGoogle: boolean
}

export function summarizeVerification(trip: Trip): VerificationSummary {
  const counts: Record<EvidenceStatus, number> = { consistent: 0, conflicting: 0, unverifiable: 0 }
  let latest: string | null = null
  let usesGoogle = false
  for (const stop of trip.stops) {
    for (const item of stop.evidence) {
      counts[item.status] += 1
      if (!latest || new Date(item.checkedAt).getTime() > new Date(latest).getTime()) {
        latest = item.checkedAt
      }
      if (isGoogleSource(item.source.kind)) usesGoogle = true
    }
  }
  return {
    counts,
    total: counts.consistent + counts.conflicting + counts.unverifiable,
    latestCheckedAt: latest,
    usesGoogle,
  }
}
