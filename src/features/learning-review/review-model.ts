import { ApprovedLearningSchema, type ApprovedLearning, type Learning } from '@/domain'
import {
  approveLearning,
  editLearning,
  rejectLearning,
  type LearningEdit,
} from '@/lib/learnings/lifecycle'

// 学びの候補の確認画面の状態。編集・承認・却下は、共通の純粋ロジック（lifecycle）を通して行い、
// 画面側で承認状態を書き換えない。承認済みの学びだけが、次回の旅程へ渡せる。

export interface ReviewState {
  learnings: Learning[]
  // 学びごとの直近の案内（編集の入力不備など）。操作が成功すれば消える。
  messages: Record<string, string>
}

export type ReviewAction =
  | { type: 'load'; learnings: Learning[] }
  | { type: 'edit'; id: string; edit: LearningEdit }
  | { type: 'approve'; id: string; decidedAt: string }
  | { type: 'reject'; id: string; decidedAt: string }
  // 却下を取り消し、未承認に戻す（承認はしない）。
  | { type: 'reopen'; id: string }

export const initialReviewState: ReviewState = { learnings: [], messages: {} }

const replace = (state: ReviewState, id: string, next: Learning, message?: string): ReviewState => {
  const messages = { ...state.messages }
  if (message) messages[id] = message
  else delete messages[id]
  return { learnings: state.learnings.map((item) => (item.id === id ? next : item)), messages }
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  if (action.type === 'load') return { learnings: action.learnings, messages: {} }

  const target = state.learnings.find((item) => item.id === action.id)
  if (!target) return state

  switch (action.type) {
    case 'edit': {
      const result = editLearning(target, action.edit)
      if (!result.ok) return replace(state, action.id, target, result.reason)
      const wasApproved = target.approval.status === 'approved'
      return replace(
        state,
        action.id,
        result.learning,
        wasApproved ? '内容を変えたので、もう一度、承認してください。' : undefined,
      )
    }
    case 'approve':
      return replace(state, action.id, approveLearning(target, action.decidedAt))
    case 'reject':
      return replace(state, action.id, rejectLearning(target, action.decidedAt))
    case 'reopen':
      return replace(state, action.id, { ...target, approval: { status: 'pending' } })
  }
}

// 次回に使える（保存の対象になる）のは、承認済みだけ。
export function approvedOf(state: ReviewState): ApprovedLearning[] {
  const approved: ApprovedLearning[] = []
  for (const learning of state.learnings) {
    // 状態の申告を信用せず、契約で承認済みであることを確かめる。
    const result = ApprovedLearningSchema.safeParse(learning)
    if (result.success) approved.push(result.data)
  }
  return approved
}
