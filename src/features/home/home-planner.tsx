'use client'

import { TripPlanner } from '@/features/trip-planner/trip-planner'
import type { GenerateTrip } from '@/features/trip-planner/use-trip-generation'
import { VerifiedTripView, type VerifyTrip } from '@/features/trip-verification/verified-trip-view'

// トップ画面：Geminiの旅程提案から、本人の操作でPlaces・Routes照合へ進む。
// 照合は根拠の確認のみで、旅程の内容・固定・承認・保存は変更しない。
// generate・verifyはテスト時の差し替え口。省略時は実APIを呼ぶ。
export function HomePlanner({
  generate,
  verify,
}: {
  generate?: GenerateTrip
  verify?: VerifyTrip
}) {
  return (
    <TripPlanner
      generate={generate}
      renderTrip={(trip) => <VerifiedTripView key={trip.id} trip={trip} verify={verify} />}
    />
  )
}
