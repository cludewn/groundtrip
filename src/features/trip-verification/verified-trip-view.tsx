'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

import type { Trip } from '@/domain'
import { GoogleMapsSourceBox } from '@/features/legal/google-maps-attribution'
import { RevisionRouteView } from '@/features/revision-review/revision-route-view'

import {
  requestTripVerification,
  type VerificationFailure,
  type VerificationOptions,
  type VerificationResult,
} from './api-client'

export type VerifyTrip = (trip: Trip, options?: VerificationOptions) => Promise<VerificationResult>

type Phase =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'verified' }
  | { kind: 'failed'; failure: VerificationFailure }

// 固定・版・Place ID・根拠以外に変更があった場合、古い照合結果を重ねない。
// 固定は照合中でも操作できるため、同じ予定の内容を維持していれば根拠だけ取り込める。
function itineraryFingerprint(trip: Trip): string {
  const { version: _version, stops, ...remaining } = trip
  return JSON.stringify({
    ...remaining,
    stops: stops.map(({ isFixed: _fixed, placeId: _placeId, evidence: _evidence, ...stop }) => stop),
  })
}

function combineEvidence(current: Trip, verified: Trip): Trip {
  return {
    ...current,
    stops: current.stops.map((stop, index) => ({
      ...stop,
      placeId: verified.stops[index].placeId,
      evidence: verified.stops[index].evidence,
    })),
  }
}

const hasMapsEvidence = (trip: Trip): boolean =>
  trip.stops.some((stop) =>
    stop.evidence.some((evidence) => ['places', 'routes'].includes(evidence.source.kind)),
  )

// 生成結果は未照合のAI提案。利用者の明示的な操作で照合し、根拠のみを反映する。
// 固定の変更は画面上の状態であり、照合の成功は旅程の承認・永続保存を意味しない。
export function VerifiedTripView({
  trip,
  verify = requestTripVerification,
}: {
  trip: Trip
  verify?: VerifyTrip
}) {
  const [displayTrip, setDisplayTrip] = useState(trip)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const latestRef = useRef(trip)
  const sequenceRef = useRef(0)
  const busyRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      // 画面を離れた後に、古い結果を適用しない。
      sequenceRef.current += 1
      abortRef.current?.abort()
    },
    [],
  )

  async function runVerification() {
    if (busyRef.current) return

    busyRef.current = true
    const sequence = ++sequenceRef.current
    const sent = latestRef.current
    const controller = new AbortController()
    abortRef.current = controller
    setPhase({ kind: 'verifying' })

    let result: VerificationResult
    try {
      result = await verify(sent, { signal: controller.signal })
    } catch {
      result = {
        ok: false,
        failure: { kind: 'unexpected', message: '旅程の照合中に予期しないエラーが発生しました。' },
      }
    }

    if (sequence !== sequenceRef.current || controller.signal.aborted) return
    busyRef.current = false
    abortRef.current = null

    if (!result.ok) {
      setPhase({ kind: 'failed', failure: result.failure })
      return
    }

    const current = latestRef.current
    const sentFingerprint = itineraryFingerprint(sent)
    if (
      sentFingerprint !== itineraryFingerprint(current) ||
      sentFingerprint !== itineraryFingerprint(result.trip) ||
      result.trip.version !== sent.version
    ) {
      setPhase({
        kind: 'failed',
        failure: {
          kind: 'unexpected',
          message: '照合中に旅程の内容が変わりました。最新の内容で照合し直してください。',
        },
      })
      return
    }

    // 照合中の固定切り替えを残し、施設・営業時間・徒歩移動に関する証拠だけを反映する。
    const merged = combineEvidence(current, result.trip)
    latestRef.current = merged
    setDisplayTrip(merged)
    setPhase({ kind: 'verified' })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-xl border border-gt-rule p-3 text-sm">
        <div role="status" aria-live="polite" aria-label="照合の状況">
          {phase.kind === 'idle' && (
            <p>これはAIが提案した旅程です。施設や移動時間はまだ照合していません。</p>
          )}
          {phase.kind === 'verifying' && (
            <p>施設・営業時間・徒歩移動を確認しています。確認中も旅程を見られます。</p>
          )}
          {phase.kind === 'verified' && (
            <p>
              情報源と照合しました。整合していても、実際の営業や当日の状況を保証するものではありません。
            </p>
          )}
        </div>
        {phase.kind === 'failed' && (
          <p role="alert" className="font-medium text-gt-warn">
            {phase.failure.message}
            {hasMapsEvidence(displayTrip)
              ? ' 表示中の根拠は以前の照合結果です。'
              : ' 旅程は未照合のまま表示しています。'}
          </p>
        )}
        <button
          type="button"
          onClick={() => void runVerification()}
          disabled={phase.kind === 'verifying'}
          className="min-h-11 rounded-lg border-2 border-gt-ink px-4 py-2 font-semibold disabled:cursor-wait disabled:opacity-60"
        >
          {phase.kind === 'verifying'
            ? '確認中…'
            : phase.kind === 'idle'
              ? '根拠を確認する'
              : 'もう一度、照合する'}
        </button>
        <p className="text-xs text-gt-muted">
          この操作は旅程を確定・予約・保存するものではありません。
        </p>
      </div>

      <RevisionRouteView
        trip={displayTrip}
        onTripChange={(next) => {
          latestRef.current = next
        }}
      />

      {hasMapsEvidence(displayTrip) && (
        <GoogleMapsSourceBox caption="確認に使った情報源">
          <p>
            施設・通常営業時間・徒歩移動の照合に使ったGoogle由来の情報です。臨時休業や交通状況は保証しません。
          </p>
          <Link href="/terms" className="mt-2 inline-block min-h-11 py-2 font-semibold underline">
            利用規約・プライバシーを見る
          </Link>
        </GoogleMapsSourceBox>
      )}
    </div>
  )
}
