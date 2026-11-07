import { z } from 'zod'

import { GenerateTripRequestSchema } from '@/domain'
import { IdSchema } from '@/domain/primitives'
import { requireActor } from '@/lib/auth/server'
import { FirestoreLearningStore } from '@/server/persistence/learnings'
import { createLazyVertexGeminiClient } from '@/server/gemini/client'
import { LearningSelectionError, resolveSelectedLearnings } from '@/server/learning-reuse/selection'
import { generateTrip } from '@/server/trip-generation/generate-trip'
import {
  handleGenerateTripRequest,
  isTripGenerationEnabled,
  MAX_REQUEST_BYTES,
} from '@/server/trip-generation/handler'
import { readBodyWithLimit } from '@/server/http'

export const runtime = 'nodejs'

// 既存の「学びを直接送れる生成API」と混同しない独立入口。
// 本人の保存済みLearningのIDだけ受け取り、サーバーで承認と地域を再確認する。
const InputSchema = z.strictObject({
  request: GenerateTripRequestSchema,
  selectedLearningIds: z
    .array(IdSchema)
    .min(1)
    .max(40)
    .refine((ids) => new Set(ids).size === ids.length),
})

const error = (status: number, code: string, message: string) =>
  Response.json(
    { status: code, message },
    { status, headers: { 'Cache-Control': 'private, no-store' } },
  )

const client = createLazyVertexGeminiClient(process.env)

export async function POST(request: Request): Promise<Response> {
  // FirestoreとGeminiの利用条件が整うまで、どちらかのフラグが無効なら何も呼ばない。
  if (
    !isTripGenerationEnabled(process.env) ||
    process.env.PERSISTENCE_ENABLED?.trim() !== 'true'
  ) {
    return error(503, 'service_unavailable', '学びを使った旅程生成は現在利用できません。')
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return error(400, 'invalid_request', 'JSONで旅行条件を送信してください。')
  }

  let actor
  try {
    actor = await requireActor(request)
  } catch {
    return error(401, 'auth_required', '本人の認証を確認できませんでした。')
  }

  const body = await readBodyWithLimit(request, MAX_REQUEST_BYTES)
  if (!body.ok) {
    return body.reason === 'too_large'
      ? error(413, 'payload_too_large', '旅行条件のデータが大きすぎます。')
      : error(400, 'invalid_request', '旅行条件を読み取れませんでした。')
  }
  let raw: unknown
  try {
    raw = JSON.parse(body.text)
  } catch {
    return error(400, 'invalid_request', 'JSONの形式が正しくありません。')
  }
  const parsed = InputSchema.safeParse(raw)
  if (!parsed.success || parsed.data.request.learnings.length !== 0) {
    return error(400, 'invalid_request', '旅行条件または学びの選択内容が不正です。')
  }

  let learnings
  try {
    learnings = await resolveSelectedLearnings(
      new FirestoreLearningStore(),
      actor.uid,
      parsed.data.request.region,
      parsed.data.selectedLearningIds,
    )
  } catch (reason) {
    if (reason instanceof LearningSelectionError) {
      return reason.code === 'selection_changed'
        ? error(409, 'selection_changed', reason.message)
        : error(400, 'invalid_request', reason.message)
    }
    return error(503, 'service_unavailable', '保存済みの学びを安全に確認できませんでした。')
  }

  // 本人が承認した学びだけを共通生成ハンドラーに渡す。候補は未照合・未保存の提案。
  const trusted = { ...parsed.data.request, learnings }
  const safeRequest = new Request('http://localhost/api/trips/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trusted),
  })
  return handleGenerateTripRequest(safeRequest, {
    isEnabled: () => isTripGenerationEnabled(process.env),
    generate: (input) => generateTrip(input, { client }),
  })
}
