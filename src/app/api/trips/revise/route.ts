import { authErrorResponse, requireActor, type Actor } from '@/lib/auth/server'
import { issueRevisionProposalTokens } from '@/server/persistence/revision-provenance'
import { FirestoreTripStore } from '@/server/persistence/trips'

import { createLazyVertexGeminiClient } from '../../../../server/gemini/client'
import { createLazyMapsClient } from '../../../../server/maps'
import { handleReviseTripRequest, isTripRevisionEnabled } from '../../../../server/revision/handler'
import { reviseTrip, type RevisionFailureEvent } from '../../../../server/revision/revise-trip'

// Vertex AIのSDKとMapsのADC認証は、Node.jsで動かす（Edgeでは使わない）。
export const runtime = 'nodejs'

// 接続の準備は最初のリクエストまで遅らせる。環境変数が未設定でもビルドは失敗しない。
const client = createLazyVertexGeminiClient(process.env)
const maps = createLazyMapsClient(process.env)

const logFailure = (event: RevisionFailureEvent) => {
  console.error('[trip-revision] 候補の作成に失敗', event)
}

export async function POST(request: Request): Promise<Response> {
  const enabled = isTripRevisionEnabled(process.env)
  let actor: Actor | undefined
  if (enabled) {
    try {
      actor = await requireActor(request)
    } catch (error) {
      return authErrorResponse(error)
    }
  }
  return handleReviseTripRequest(request, {
    isEnabled: () => enabled,
    revise: async (tripRequest) => {
      const report =
        actor && process.env.PERSISTENCE_ENABLED?.trim() === 'true'
          ? await new FirestoreTripStore().prepareRevisionGeneration(actor, tripRequest)
          : undefined
      if (report?.blocked && !report.reported) {
        return {
          status: 'insufficient_information',
          message: '未解消の本人報告があります。報告の状態を確認してください。',
        }
      }
      const result = await reviseTrip(tripRequest, { client, maps, report: logFailure })
      return actor && report
        ? issueRevisionProposalTokens(actor, tripRequest, result, report.reportVersion)
        : result
    },
  })
}
