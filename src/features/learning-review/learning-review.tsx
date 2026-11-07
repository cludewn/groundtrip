'use client'

import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react'

import type { ApprovedLearning, Learning, Revision, Trip } from '@/domain'
import { MAX_LEARNING_CONTENT_LENGTH, editLearning } from '@/lib/learnings/lifecycle'

import {
  requestLearningCandidates,
  type CandidatesFailure,
  type CandidatesOptions,
  type CandidatesRequest,
  type CandidatesResult,
} from './api-client'
import { approvedOf, initialReviewState, reviewReducer, type ReviewAction } from './review-model'

const MAX_FEEDBACK_LENGTH = 1000

export type RequestCandidates = (
  request: CandidatesRequest,
  options?: CandidatesOptions,
) => Promise<CandidatesResult>

interface LearningReviewProps {
  trip: Trip
  // 旅行中に行った部分修正の履歴。承認したものだけが、学びの材料になる。
  revisions?: Revision[]
  // テスト・先行開発で差し替える。省略時は実際のAPIを呼ぶ。
  requestCandidates?: RequestCandidates
  now?: () => Date
  // 承認済みの学びが変わるたびに呼ぶ（保存は呼び出し側の責務。承認済みだけが渡る）。
  onApprovedChange?: (approved: ApprovedLearning[]) => void
}

const CATEGORY_LABEL: Record<Learning['category'], string> = {
  verification: '情報源との不一致',
  preference: '個人の好み・経験',
}

const STATUS_LABEL = {
  pending: '未承認',
  approved: '承認済み',
  rejected: '却下',
} as const

const fieldClass =
  'w-full rounded border border-current/40 bg-transparent px-3 py-3 text-base aria-[invalid=true]:border-2'
const buttonClass =
  'rounded border border-current/50 px-4 py-3 text-sm font-medium aria-disabled:opacity-50'

type Phase =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'failed'; failure: CandidatesFailure }
  | { kind: 'ready' }

// 旅行後の振り返り：感想と変更履歴から学びの候補（1〜3件）を作り、本人が編集・承認・却下する。
// 候補は提案であり、承認するまで次回の旅程には使われない。学びはAIの再学習ではなく、本人の設定である。
export function LearningReview({
  trip,
  revisions = [],
  requestCandidates = requestLearningCandidates,
  now = () => new Date(),
  onApprovedChange,
}: LearningReviewProps) {
  const [feedback, setFeedback] = useState('')
  const [feedbackError, setFeedbackError] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [review, dispatch] = useReducer(reviewReducer, initialReviewState)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const resultHeadingRef = useRef<HTMLHeadingElement>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])
  useEffect(() => {
    if (phase.kind === 'ready') resultHeadingRef.current?.focus()
  }, [phase.kind])

  const approved = approvedOf(review)
  // 承認済みの内容が変わったときだけ、呼び出し側へ通知する。
  const approvedKey = JSON.stringify(approved)
  const notifyRef = useRef(onApprovedChange)
  const approvedRef = useRef(approved)
  useEffect(() => {
    notifyRef.current = onApprovedChange
    approvedRef.current = approved
  })
  useEffect(() => {
    notifyRef.current?.(approvedRef.current)
  }, [approvedKey])

  const approvedRevisions = revisions.filter((revision) => revision.approval.status === 'approved')
  const generating = phase.kind === 'generating'

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (generating) return
    const text = feedback.trim()
    if (text.length > MAX_FEEDBACK_LENGTH) {
      setFeedbackError(`感想は${MAX_FEEDBACK_LENGTH}文字以内にしてください。`)
      feedbackRef.current?.focus()
      return
    }
    if (text.length === 0 && approvedRevisions.length === 0) {
      // ボタンは常に押せるようにし、押されたら不備の欄を示して移動する。
      setFeedbackError('感想を入力してください（承認した変更が無いため、材料が必要です）。')
      feedbackRef.current?.focus()
      return
    }
    setFeedbackError('')

    const controller = new AbortController()
    controllerRef.current = controller
    setPhase({ kind: 'generating' })
    let result: CandidatesResult
    try {
      result = await requestCandidates(
        { trip, revisions, feedback: text },
        { signal: controller.signal },
      )
    } catch {
      result = {
        ok: false,
        failure: { kind: 'unexpected', message: '予期しないエラーが発生しました。' },
      }
    }
    if (controller.signal.aborted) return
    controllerRef.current = null
    if (result.ok) {
      dispatch({ type: 'load', learnings: result.learnings })
      setPhase({ kind: 'ready' })
    } else {
      // 失敗しても、感想の入力と、すでに確認中の候補は残す。
      setPhase({ kind: 'failed', failure: result.failure })
    }
  }

  return (
    <section aria-labelledby="reflection-heading" className="space-y-6">
      <div>
        <h2 id="reflection-heading" className="text-lg font-semibold">
          旅の振り返り
        </h2>
        <p className="mt-1 text-sm">
          感想と変更の履歴から、次の旅に活かせる「学び」の候補を作ります。承認した学びだけが、次回の旅程づくりに使われます（AIが学習し直すわけではありません）。
        </p>
      </div>

      <section aria-labelledby="revision-history-heading" className="space-y-2">
        <h3 id="revision-history-heading" className="text-base font-semibold">
          変更の履歴
        </h3>
        {revisions.length === 0 ? (
          <p className="text-sm">この旅程の変更履歴はありません。</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {revisions.map((revision) => (
              <li key={revision.id} className="rounded border border-current/30 p-3">
                <p>
                  <b>{revision.diff.before.name}</b> → <b>{revision.diff.after.name}</b>
                </p>
                <p>理由：{revision.reason}</p>
                <p>
                  {revision.approval.status === 'approved'
                    ? '承認済み（学びの材料にします）'
                    : '未承認または却下（学びの材料にしません）'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={handleSubmit} noValidate className="space-y-3">
        <div>
          <label htmlFor="reflection-feedback" className="block text-sm font-medium">
            感想・変更した理由
          </label>
          <textarea
            id="reflection-feedback"
            ref={feedbackRef}
            rows={4}
            value={feedback}
            onChange={(event) => {
              setFeedback(event.target.value)
              setFeedbackError('')
            }}
            aria-invalid={feedbackError ? true : undefined}
            aria-describedby={feedbackError ? 'reflection-feedback-error' : undefined}
            className={`${fieldClass} mt-1`}
            readOnly={generating}
          />
          <p className="mt-1 text-xs">
            {feedback.length} / {MAX_FEEDBACK_LENGTH}文字
          </p>
          {feedbackError && (
            <p id="reflection-feedback-error" role="alert" className="mt-1 text-sm font-medium">
              {feedbackError}
            </p>
          )}
        </div>
        <button type="submit" className={buttonClass} aria-disabled={generating || undefined}>
          {generating ? '学びの候補を作っています…' : '学びの候補を作る'}
        </button>
      </form>

      <div role="status" aria-live="polite">
        {generating && <p className="text-sm">AIが候補を考えています。しばらくお待ちください。</p>}
      </div>
      {phase.kind === 'failed' && (
        <p role="alert" className="rounded border-2 border-current p-3 text-sm">
          {phase.failure.message}
          {review.learnings.length > 0 && '（すでに確認中の候補は、そのまま残っています。）'}
        </p>
      )}

      {review.learnings.length > 0 && (
        <section aria-labelledby="candidates-heading" className="space-y-3">
          <h3
            id="candidates-heading"
            ref={resultHeadingRef}
            tabIndex={-1}
            className="text-base font-semibold outline-none"
          >
            学びの候補（{review.learnings.length}件）
          </h3>
          <p className="text-sm">
            内容と適用範囲を直してから、承認または却下してください。AIの提案は、承認するまで使われません。
          </p>
          <ul className="space-y-3">
            {review.learnings.map((learning) => (
              <CandidateCard
                key={learning.id}
                learning={learning}
                region={trip.region}
                message={review.messages[learning.id]}
                decidedAt={() => now().toISOString()}
                dispatch={dispatch}
              />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="approved-heading" className="space-y-2">
        <h3 id="approved-heading" className="text-base font-semibold">
          承認済みの学び（{approved.length}件）
        </h3>
        {approved.length === 0 ? (
          <p className="text-sm">承認した学びはまだありません。</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {approved.map((item) => (
              <li key={item.id}>
                {item.content}（
                {item.scope.kind === 'all_trips' ? 'すべての旅行' : `${item.scope.region}の旅行`}）
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs">
          承認した内容は、いまはこの画面の中だけにあり、まだ保存されません（保存は、ログインの機能が入ってから使えるようになります）。
        </p>
      </section>
    </section>
  )
}

interface CandidateCardProps {
  learning: Learning
  region: string
  message: string | undefined
  decidedAt: () => string
  dispatch: (action: ReviewAction) => void
}

function CandidateCard({ learning, region, message, decidedAt, dispatch }: CandidateCardProps) {
  const [content, setContent] = useState(learning.content)
  const [scopeKind, setScopeKind] = useState<'all_trips' | 'region'>(learning.scope.kind)
  const status = learning.approval.status
  const contentId = `learning-content-${learning.id}`
  const scopeId = `learning-scope-${learning.id}`

  const draftScope: Learning['scope'] =
    scopeKind === 'all_trips' ? { kind: 'all_trips' } : { kind: 'region', region }
  const dirty = content.trim() !== learning.content || scopeKind !== learning.scope.kind

  // 画面に見えている内容（編集中のものを含む）に対して、承認する。
  // 入力が不正なら承認せず、理由を案内する。
  const applyDraft = (): boolean => {
    if (!dirty) return true
    const check = editLearning(learning, { content, scope: draftScope })
    dispatch({ type: 'edit', id: learning.id, edit: { content, scope: draftScope } })
    return check.ok
  }

  return (
    <li className="space-y-3 rounded border border-current/40 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded border border-current/50 px-2 py-0.5">
          {CATEGORY_LABEL[learning.category]}
        </span>
        <span className="rounded border-2 border-current px-2 py-0.5 font-medium">
          {STATUS_LABEL[status]}
        </span>
      </div>
      <div>
        <label htmlFor={contentId} className="block text-sm font-medium">
          学びの内容
        </label>
        <textarea
          id={contentId}
          rows={2}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className={`${fieldClass} mt-1`}
          aria-describedby={message ? `${contentId}-message` : undefined}
        />
        <p className="mt-1 text-xs">
          {content.trim().length} / {MAX_LEARNING_CONTENT_LENGTH}文字
        </p>
      </div>
      <div>
        <label htmlFor={scopeId} className="block text-sm font-medium">
          適用範囲
        </label>
        <select
          id={scopeId}
          value={scopeKind}
          onChange={(event) =>
            setScopeKind(event.target.value === 'region' ? 'region' : 'all_trips')
          }
          className={`${fieldClass} mt-1`}
        >
          <option value="region">{region}の旅行だけ</option>
          <option value="all_trips">すべての旅行</option>
        </select>
      </div>
      {message && (
        <p id={`${contentId}-message`} role="status" className="text-sm font-medium">
          {message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            if (applyDraft()) dispatch({ type: 'approve', id: learning.id, decidedAt: decidedAt() })
          }}
        >
          {status === 'approved' && !dirty ? '承認済み（再承認）' : '承認する'}
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => dispatch({ type: 'reject', id: learning.id, decidedAt: decidedAt() })}
        >
          却下する
        </button>
        {status === 'rejected' && (
          <button
            type="button"
            className={buttonClass}
            onClick={() => dispatch({ type: 'reopen', id: learning.id })}
          >
            却下を取り消す
          </button>
        )}
      </div>
    </li>
  )
}
