'use client'

import { useCallback, useRef } from 'react'

import { LearningReusePicker } from '@/features/learning-reuse/learning-reuse-picker'
import { requestTripGeneration } from '@/features/trip-planner/api-client'
import { requestTripWithSelectedLearnings } from '@/features/learning-reuse/generate-selected-client'
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
  // 本人が選んだIDのみを保持する。内容や承認状態はサーバーで再検証する。
  const selectedIds = useRef<string[]>([])
  const onSelectionChange = useCallback((ids: string[]) => {
    selectedIds.current = ids
  }, [])
  const renderLearningPicker = useCallback(
    (region: string) => (
      <LearningReusePicker region={region} onSelectionChange={onSelectionChange} />
    ),
    [onSelectionChange],
  )
  const generateWithSelection = useCallback<GenerateTrip>(
    (request, options) => {
      if (generate) return generate(request, options)
      return selectedIds.current.length > 0
        ? requestTripWithSelectedLearnings(request, selectedIds.current, options)
        : requestTripGeneration(request, options)
    },
    [generate],
  )

  return (
    <TripPlanner
      generate={generateWithSelection}
      renderLearningPicker={renderLearningPicker}
      renderTrip={(trip) => <VerifiedTripView key={trip.id} trip={trip} verify={verify} />}
    />
  )
}
