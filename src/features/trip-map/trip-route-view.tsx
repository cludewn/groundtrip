'use client'

import { useState } from 'react'

import type { Trip } from '@/domain'

import { RouteMap } from './route-map'
import { setStopFixed, type RouteMeta } from './model'
import { StopSheet } from './stop-sheet'

interface TripRouteViewProps {
  trip: Trip
  meta?: RouteMeta
  // モックデータであることを明示する（実際の店舗・照合結果ではない）。
  mock?: boolean
  // 部分修正を始める（候補の比較・承認は部分修正の機能の責務）。未指定なら修正の操作は出さない。
  onStartRevision?: (stopId: string) => void
}

// 旅程の一覧（路線図）の表示と、予定の選択・固定の切り替え。
// 固定の切り替えは画面上の状態であり、保存や認可は行わない（保存は#10）。
export function TripRouteView({
  trip: initialTrip,
  meta,
  mock = false,
  onStartRevision,
}: TripRouteViewProps) {
  const [trip, setTrip] = useState(initialTrip)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  const selectedIndex = trip.stops.findIndex((stop) => stop.id === selectedId)
  const selected = selectedIndex >= 0 ? trip.stops[selectedIndex] : null

  const toggleFixed = (stopId: string, fixed: boolean) => {
    const next = setStopFixed(trip, stopId, fixed)
    if (!next) return
    setTrip(next)
    const name = next.stops.find((stop) => stop.id === stopId)?.name ?? ''
    setNotice(
      `「${name}」を${fixed ? '固定しました' : '固定解除しました'}。画面上の変更で、まだ保存されていません。`,
    )
  }

  return (
    <div
      className="rounded-2xl bg-gt-bg p-4 pb-6 text-gt-ink"
      style={{ paddingBottom: selected ? '60vh' : undefined }}
    >
      {mock && (
        <p
          role="note"
          className="mb-4 rounded-md border-[1.5px] border-dashed border-gt-unk bg-gt-unk-bg px-3 py-2 text-xs leading-relaxed text-gt-unk"
        >
          <b>モックデータ（架空）</b>
          ：店名・営業時間・照合結果は、画面確認用のサンプルです。実在の情報ではありません。
        </p>
      )}
      <RouteMap trip={trip} meta={meta} selectedStopId={selectedId} onSelectStop={setSelectedId} />
      <p role="status" aria-live="polite" className="mt-3 text-[13px] text-gt-muted">
        {notice}
      </p>
      <p className="mt-2 text-[11.5px] text-gt-muted">
        路線図は旅の順番を表すもので、実際の地図ではありません。
      </p>
      {selected && (
        <StopSheet
          stop={selected}
          index={selectedIndex}
          meta={meta?.[selected.id] ?? {}}
          kind={meta?.[selected.id]?.kind ?? 'sight'}
          onStartRevision={onStartRevision}
          onToggleFixed={toggleFixed}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}
