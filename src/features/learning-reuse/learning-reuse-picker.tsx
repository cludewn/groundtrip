'use client'

import { useEffect, useRef, useState, type ChangeEvent } from 'react'

import type { ApprovedLearning } from '@/domain'
import { normalizeLearningRegion, selectApplicableLearnings } from '@/lib/learnings/lifecycle'
import type { LearningSelection, VersionedLearning } from '@/server/persistence/contracts'

import { loadApprovedLearningOptions, type LearningLoadResult } from './api-client'

export type LoadLearningOptions = (signal: AbortSignal) => Promise<LearningLoadResult>

interface LearningReusePickerProps {
  region: string
  // 選んだ学びを、画面に表示した版つきで通知する。サーバーは版が現行と一致するときだけ採用する。
  onSelectionChange?: (selection: LearningSelection[]) => void
  // テスト・他の画面での依存性注入に使う。省略時は本人のFirestore保存APIを読む。
  // 読み込みは地域の変更と「再読み込み」のときだけ行い、この関数の差し替えでは再実行しない。
  load?: LoadLearningOptions
}

type PickerState =
  | { region: string; status: 'loading' }
  | { region: string; status: 'error'; message: string }
  | {
      region: string
      status: 'ready'
      items: VersionedLearning[]
      selected: LearningSelection[]
    }

const defaultLoad: LoadLearningOptions = (signal) => loadApprovedLearningOptions({ signal })

const categoryLabels: Record<ApprovedLearning['category'], string> = {
  verification: '情報の確認について',
  preference: '好み・過ごし方について',
}

// 読み上げ用の常設領域に出す文。領域は常に描画し、中身だけを入れ替える
// （中身と同時に挿入された領域は、読み上げられないことがある）。
function statusMessage(state: PickerState): string {
  if (state.status === 'loading') return '保存済みの学びを確認しています…'
  if (state.status === 'error') return ''
  if (state.items.length === 0) {
    return '今回の地域に使える、承認済みの学びはありません。学びを使わずに旅程を作れます。'
  }
  return `${state.items.length}件の学びから選べます。現在${state.selected.length}件を選択中です。`
}

// このUIは、選んだ学びのIDと表示した版だけを返す。画面で受け取った学びの内容・承認状態は
// 次回生成APIの信頼できる入力とはしない（サーバーで本人の保存データを再取得し、版を照合する）。
export function LearningReusePicker({
  region,
  onSelectionChange,
  load = defaultLoad,
}: LearningReusePickerProps) {
  // サーバーと同じ正規化（前後の空白を除く）を、入口で1回だけ行う。
  const normalizedRegion = normalizeLearningRegion(region)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<PickerState>({ region: normalizedRegion, status: 'loading' })
  const statusRef = useRef<HTMLDivElement>(null)
  // 親が毎回新しい関数を渡しても、読み込みの再実行や通知の連鎖を起こさないよう、
  // 最新の関数はrefで持つ。
  const loadRef = useRef(load)
  const changeRef = useRef(onSelectionChange)
  useEffect(() => {
    loadRef.current = load
    changeRef.current = onSelectionChange
  }, [load, onSelectionChange])

  useEffect(() => {
    const controller = new AbortController()
    setState({ region: normalizedRegion, status: 'loading' })
    // 地域が変わった・再読み込みした場合も、前の選択を次の生成に流用しない。
    changeRef.current?.([])
    if (!normalizedRegion) {
      setState({
        region: normalizedRegion,
        status: 'error',
        message: '先に旅行先の地域を入力してください。',
      })
      return () => controller.abort()
    }

    void loadRef.current(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        if (!result.ok) {
          setState({ region: normalizedRegion, status: 'error', message: result.message })
          return
        }
        const applicable = selectApplicableLearnings(
          result.items.map(({ learning }) => learning),
          normalizedRegion,
        )
        const ids = new Set(applicable.map(({ id }) => id))
        setState({
          region: normalizedRegion,
          status: 'ready',
          items: result.items.filter(({ learning }) => ids.has(learning.id)),
          selected: [],
        })
      },
      () => {
        if (!controller.signal.aborted) {
          setState({
            region: normalizedRegion,
            status: 'error',
            message: '学びを取得できませんでした。もう一度お試しください。',
          })
        }
      },
    )
    return () => controller.abort()
  }, [normalizedRegion, attempt])

  const visible: PickerState =
    state.region === normalizedRegion ? state : { region: normalizedRegion, status: 'loading' }

  const toggle = (event: ChangeEvent<HTMLInputElement>, item: VersionedLearning) => {
    if (visible.status !== 'ready') return
    const { id } = item.learning
    const next = event.target.checked
      ? [...visible.selected, { id, version: item.version }]
      : visible.selected.filter((value) => value.id !== id)
    setState({ ...visible, selected: next })
    changeRef.current?.(next)
  }

  const retry = () => {
    // 押したボタンは読み込み中に消える。フォーカスがページ先頭へ落ちないよう、
    // 常設の状況表示へ移してから再読み込みする。
    statusRef.current?.focus()
    setAttempt((count) => count + 1)
  }

  return (
    <section
      aria-label="次の旅に使う学び"
      className="space-y-3 rounded-xl border border-current/20 p-4"
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">前の旅の学びを使う</h2>
        <p className="text-sm text-gt-muted">
          自分で承認した学びから、今回の旅に使いたいものだけを選べます。
          選んだだけではまだ旅程に反映されません。
        </p>
        <p className="text-sm text-gt-muted">
          地域を限定した学びは、旅行先の地域と同じ表記のものだけが表示されます。
          例：「京都」と「京都市」は別の地域として扱います。
        </p>
      </div>

      <div ref={statusRef} role="status" tabIndex={-1} className="text-sm">
        {statusMessage(visible)}
      </div>
      {visible.status === 'error' && (
        <div role="alert" className="space-y-2">
          <p className="text-sm">{visible.message}</p>
          <button
            type="button"
            onClick={retry}
            className="min-h-11 rounded-lg border border-current/40 px-4 text-sm"
          >
            再読み込み
          </button>
        </div>
      )}
      {visible.status === 'ready' && visible.items.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">今回使う学び</legend>
          {visible.items.map((item) => {
            const { learning } = item
            return (
              <label
                key={learning.id}
                className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-current/20 p-3"
              >
                <input
                  type="checkbox"
                  checked={visible.selected.some(({ id }) => id === learning.id)}
                  onChange={(event) => toggle(event, item)}
                  className="mt-1 h-5 w-5 shrink-0"
                />
                <span className="min-w-0 space-y-1 break-words [overflow-wrap:anywhere]">
                  <span className="block text-sm font-medium">{learning.content}</span>
                  <span className="block text-xs text-gt-muted">
                    {categoryLabels[learning.category]}・
                    {learning.scope.kind === 'all_trips'
                      ? 'すべての地域'
                      : 'この地域だけ（' + learning.scope.region + '）'}
                  </span>
                </span>
              </label>
            )
          })}
          <p className="text-xs text-gt-muted">
            選択した学びは、次回生成時にサーバーが改めて確認します。
            ここに表示した後で内容が変わっていた場合は、そのまま使わず選び直しをお願いします。
            学びによる変更かどうかは、生成結果だけでは断定できません。
          </p>
        </fieldset>
      )}
    </section>
  )
}
