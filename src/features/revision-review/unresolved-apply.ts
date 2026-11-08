import { TripSchema, type Trip } from '@/domain'

// 結果不明の適用を、Trip ID ごとに「不明になった時点の版」で覚える。
// 比較画面を閉じたり、コンポーネントが外れて再表示されたりしても消えないよう、モジュール内に持つ。
// ページを再読み込みしたときは、親がサーバーから取得し直した旅程の版で判定する。
const unresolved = new Map<string, number>()

export function markApplyUnresolved(tripId: string, baseVersion: number): void {
  unresolved.set(tripId, baseVersion)
}

export function clearApplyUnresolved(tripId: string): void {
  unresolved.delete(tripId)
}

// 親から新しい版の旅程を渡されても解禁しない（親の旅程が正本とは限らない）。
// 解禁は、確定した適用応答か、サーバーの最新の旅程との照合（judgeLatestTrip）だけで行う。
export function isApplyUnresolved(tripId: string): boolean {
  return unresolved.has(tripId)
}

export function unresolvedBaseVersion(tripId: string): number | undefined {
  return unresolved.get(tripId)
}

// テストの前後で状態を戻すために使う。
export function resetUnresolvedApplies(): void {
  unresolved.clear()
}

export type LatestTripVerdict =
  { kind: 'applied'; trip: Trip } | { kind: 'not_applied' } | { kind: 'unverified' }

// サーバーの最新の旅程と、結果不明になった時点の版を照合する。
// 版が進んでいれば適用済み（またはその後に更新済み）、同じなら未適用。
// 別の旅程・形式不正・古い版は、確認できたことにしない。
export function judgeLatestTrip(
  tripId: string,
  baseVersion: number,
  latest: unknown,
): LatestTripVerdict {
  const parsed = TripSchema.safeParse(latest)
  if (!parsed.success || parsed.data.id !== tripId) return { kind: 'unverified' }
  if (parsed.data.version > baseVersion) return { kind: 'applied', trip: parsed.data }
  if (parsed.data.version === baseVersion) return { kind: 'not_applied' }
  return { kind: 'unverified' }
}
