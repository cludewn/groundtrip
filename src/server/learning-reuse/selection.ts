import { z } from 'zod'

import { IdSchema } from '@/domain/primitives'
import type { ApprovedLearning } from '@/domain'
import {
  getApplicableLearnings,
  type LearningStore,
} from '@/server/learnings/store'

// 認証済みUIDは呼び出し側のサーバーで検証済みActorから渡す。
// クライアントはLearningの本文やapprovalを送らず、選択したIDだけを渡す。
export class LearningSelectionError extends Error {
  constructor(readonly code: 'invalid_selection' | 'selection_changed') {
    super(
      code === 'invalid_selection'
        ? '学びの選択内容が正しくありません。'
        : '承認済みの学びが変更されました。最新の一覧を確認してください。',
    )
    this.name = 'LearningSelectionError'
  }
}

const SelectedIdsSchema = z
  .array(IdSchema)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length)

export async function resolveSelectedLearnings(
  store: Pick<LearningStore, 'listApproved'>,
  ownerUid: string,
  region: string,
  selectedIds: readonly string[],
): Promise<ApprovedLearning[]> {
  const parsed = SelectedIdsSchema.safeParse(selectedIds)
  if (!ownerUid.trim() || !region.trim() || !parsed.success) {
    throw new LearningSelectionError('invalid_selection')
  }
  if (parsed.data.length === 0) return []

  // サーバーに保存された、本人の承認済みで適用地域が一致する学びだけを採用する。
  // 他人の学びや撤回済みID・地域不一致・古い選択は、黙って無視せず拒否する。
  const applicable = await getApplicableLearnings(store, ownerUid, region)
  const byId = new Map(applicable.map((learning) => [learning.id, learning]))
  return parsed.data.map((id) => {
    const learning = byId.get(id)
    if (!learning) throw new LearningSelectionError('selection_changed')
    return learning
  })
}
