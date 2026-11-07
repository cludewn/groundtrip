'use client'

import { useEffect, useState } from 'react'

import type { Trip } from '@/domain'
import { RevisionRouteView } from '@/features/revision-review/revision-route-view'

import { useTripVerification, type VerifyTrip } from './use-trip-verification'
import { VerificationPanel, type PanelStatus } from './verification-panel'
import { summarizeVerification } from './verification-summary'
import { withdrawVerification, type VerificationRecord } from './withdraw-verification'

// 画面に出している旅程の状態。
// - source：親から渡された旅程（新しい生成に切り替わったかの判定に使う）。
// - prop：路線図へ渡す旅程。照合に成功したときだけ、照合結果に差し替える。
// - current：いま画面に出ている旅程（固定の切り替えや部分修正で変わる）。
// - verified：直近の照合の記録。currentが照合結果そのものである間だけ「照合結果あり」とする。
interface View {
  source: Trip
  prop: Trip
  current: Trip
  verified: VerificationRecord | null
}

const fresh = (source: Trip): View => ({ source, prop: source, current: source, verified: null })

// 生成された旅程の路線図と、根拠の確認（照合）の操作。
// 照合は利用者が「根拠を確認する」を押したときだけ、1回行う。失敗しても旅程は変わらず、再試行できる。
// 旅程が変わったら、前回の照合結果は取り下げて「変更後は未確認」に戻す。
export function VerifiableTrip({ trip: source, verify }: { trip: Trip; verify?: VerifyTrip }) {
  const [stored, setStored] = useState<View>(() => fresh(source))
  const view = stored.source === source ? stored : fresh(source)
  const { state, run, cancel } = useTripVerification(verify)

  const update = (change: (current: View) => View) =>
    setStored((previous) => change(previous.source === source ? previous : fresh(source)))

  // 別の旅程に切り替わったら、進行中の確認を取り消す（古い旅程の結果を反映しない）。
  useEffect(() => {
    cancel()
  }, [source, cancel])

  const verifyNow = async () => {
    const sent = view.current
    const result = await run(sent)
    if (!result) return
    // 確認中に旅程が変わると、通信を中止して結果を返さない（adoptChangeのcancel）ので、ここへは来ない。
    update(() => ({ source, prop: result, current: result, verified: { basis: sent, result } }))
  }

  // 固定の切り替え・部分修正の適用で旅程が変わったとき、画面に採用する旅程を返す。
  const adoptChange = (changed: Trip): Trip => {
    const adopted = view.verified ? withdrawVerification(changed, view.verified) : changed
    update((previous) => ({ ...previous, current: adopted }))
    cancel()
    return adopted
  }

  const isVerified = view.verified !== null && view.current === view.verified.result
  const status: PanelStatus = isVerified
    ? { kind: 'verified', summary: summarizeVerification(view.current) }
    : view.verified
      ? { kind: 'withdrawn' }
      : { kind: 'unverified' }

  return (
    <div className="space-y-4">
      <VerificationPanel status={status} phase={state} onVerify={() => void verifyNow()} />
      <RevisionRouteView trip={view.prop} adoptTripChange={adoptChange} />
    </div>
  )
}
