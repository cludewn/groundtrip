'use client'

import { useEffect, useRef, useState, type ChangeEvent } from 'react'

import type { ApprovedLearning } from '@/domain'
import { selectApplicableLearnings } from '@/lib/learnings/lifecycle'
import type { VersionedLearning } from '@/server/persistence/contracts'

import {
  loadApprovedLearningOptions,
  type LearningLoadResult,
} from './api-client'

export type LoadLearningOptions = (signal: AbortSignal) => Promise<LearningLoadResult>

interface LearningReusePickerProps {
  region: string
  onSelectionChange?: (learningIds: string[]) => void
  // テスト・他の画面での依存性注入に使う。省略時は本人のFirestore保存APIを読む。
  load?: LoadLearningOptions
}

type PickerState =
  | { region: string; status: 'loading' }
  | { region: string; status: 'error'; message: string }
  | {
      region: string
      status: 'ready'
      items: VersionedLearning[]
      selectedIds: string[]
    }

const defaultLoad: LoadLearningOptions = (signal) => loadApprovedLearningOptions({ signal })

const categoryLabels: Record<ApprovedLearning['category'], string> = {
  verification: '情報の確認について',
  preference: '好み・過ごし方について',
}

// このUIは選択IDだけを返す。画面で受け取った学びの内容・承認状態は
// 次回生成APIの信頼できる入力とはしない（サーバーで本人の保存データを再取得する）。
export function LearningReusePicker({
  region,
  onSelectionChange,
  load = defaultLoad,
}: LearningReusePickerProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<PickerState>({ region, status: 'loading' })
  const changeRef = useRef(onSelectionChange)
  useEffect(() => {
    changeRef.current = onSelectionChange
  }, [onSelectionChange])

  useEffect(() => {
    const controller = new AbortController()
    setState({ region, status: 'loading' })
    // 地域が変わった場合も、前の地域の選択を次の生成に流用しない。
    changeRef.current?.([])
    if (!region.trim()) {
      setState({ region, status: 'error', message: '先に旅行先の地域を入力してください。' })
      return () => controller.abort()
    }

    void load(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        if (!result.ok) {
          setState({ region, status: 'error', message: result.message })
          return
        }
        const applicable = selectApplicableLearnings(
          result.items.map(({ learning }) => learning),
          region,
        )
        const ids = new Set(applicable.map(({ id }) => id))
        setState({
          region,
          status: 'ready',
          items: result.items.filter(({ learning }) => ids.has(learning.id)),
          selectedIds: [],
        })
      },
      () => {
        if (!controller.signal.aborted) {
          setState({
            region,
            status: 'error',
            message: '学びを取得できませんでした。もう一度お試しください。',
          })
        }
      },
    )
    return () => controller.abort()
  }, [region, load, attempt])

  const visible: PickerState =
    state.region === region ? state : { region, status: 'loading' }

  const toggle = (event: ChangeEvent<HTMLInputElement>, id: string) => {
    if (visible.status !== 'ready') return
    const next = event.target.checked
      ? [...visible.selectedIds, id]
      : visible.selectedIds.filter((value) => value !== id)
    setState({ ...visible, selectedIds: next })
    changeRef.current?.(next)
  }

  return (
    <section aria-label="次の旅に使う学び" className="space-y-3 rounded-xl border border-current/20 p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">前の旅の学びを使う</h2>
        <p className="text-sm text-current/75">
          自分で承認した学びから、今回の旅に使いたいものだけを選べます。
          選んだだけではまだ旅程に反映されません。
        </p>
      </div>

      {visible.status === 'loading' && (
        <p role="status" className="text-sm">保存済みの学びを確認しています…</p>
      )}
      {visible.status === 'error' && (
        <div role="alert" className="space-y-2">
          <p className="text-sm">{visible.message}</p>
          <button
            type="button"
            onClick={() => setAttempt((count) => count + 1)}
            className="min-h-11 rounded-lg border border-current/40 px-4 text-sm"
          >
            再読み込み
          </button>
        </div>
      )}
      {visible.status === 'ready' && visible.items.length === 0 && (
        <p role="status" className="text-sm">
          今回の地域に使える、承認済みの学びはありません。学びを使わずに旅程を作れます。
        </p>
      )}
      {visible.status === 'ready' && visible.items.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">
            今回使う学び（{visible.selectedIds.length}件選択中）
          </legend>
          {visible.items.map(({ learning }) => (
            <label
              key={learning.id}
              className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-current/20 p-3"
            >
              <input
                type="checkbox"
                checked={visible.selectedIds.includes(learning.id)}
                onChange={(event) => toggle(event, learning.id)}
                className="mt-1 h-5 w-5 shrink-0"
              />
              <span className="min-w-0 space-y-1 break-words [overflow-wrap:anywhere]">
                <span className="block text-sm font-medium">{learning.content}</span>
                <span className="block text-xs text-current/70">
                  {categoryLabels[learning.category]}・
                  {learning.scope.kind === 'all_trips'
                    ? 'すべての地域'
                    : 'この地域だけ（' + learning.scope.region + '）'}
                </span>
              </span>
            </label>
          ))}
          <p className="text-xs text-current/70">
            選択した学びは次回生成時にサーバーで改めて確認します。
            学びによる変更かどうかは、生成結果だけでは断定できません。
          </p>
        </fieldset>
      )}
    </section>
  )
}
