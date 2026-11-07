import { ReflectionFlow } from '@/features/reflection-flow/reflection-flow'

// 実際の保存済み旅程を本人のセッションから取得して振り返る。
// /reflection?tripId=... は選択の補助であり、取得の認可には使わない。
export default async function ReflectionPage({
  searchParams,
}: {
  searchParams: Promise<{ tripId?: string }>
}) {
  const { tripId } = await searchParams
  return <ReflectionFlow initialTripId={tripId} />
}
