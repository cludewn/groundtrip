import { TripSchema, type Trip } from '@/domain'
import { SavedRevisionSchema } from '@/server/persistence/contracts'

// 結果不明の適用を、対象Revisionと元のTrip版の組として保持する。
type UnresolvedApply = Readonly<{ baseVersion: number; revisionId: string }>
const unresolved = new Map<string, UnresolvedApply>()

export function markApplyUnresolved(
  tripId: string,
  baseVersion: number,
  revisionId: string,
): void {
  unresolved.set(tripId, { baseVersion, revisionId })
}

export function clearApplyUnresolved(tripId: string): void {
  unresolved.delete(tripId)
}

export function isApplyUnresolved(tripId: string): boolean {
  return unresolved.has(tripId)
}

export function unresolvedApply(tripId: string): UnresolvedApply | undefined {
  return unresolved.get(tripId)
}

export function resetUnresolvedApplies(): void {
  unresolved.clear()
}

export type LatestTripVerdict = { kind: 'applied'; trip: Trip } | { kind: 'unverified' }

// 同じ版のGETは遅延コミットを否定せず、版増加も別の更新かもしれない。
// 対象Revisionの承認記録と版が揃った場合だけ、適用済みと確認する。
export function judgeLatestTrip(
  tripId: string,
  baseVersion: number,
  revisionId: string,
  latest: unknown,
  savedRevision: unknown,
): LatestTripVerdict {
  const trip = TripSchema.safeParse(latest)
  const revision = SavedRevisionSchema.safeParse(savedRevision)
  if (!trip.success || !revision.success) return { kind: 'unverified' }
  if (
    trip.data.id !== tripId ||
    trip.data.version <= baseVersion ||
    revision.data.id !== revisionId ||
    revision.data.tripId !== tripId ||
    revision.data.baseTripVersion !== baseVersion ||
    revision.data.approval.status !== 'approved'
  )
    return { kind: 'unverified' }
  return { kind: 'applied', trip: trip.data }
}
