import { ApproveLearningBodySchema, VersionedLearningSchema } from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreLearningStore } from '@/server/persistence/learnings'

export const runtime = 'nodejs'

type Context = { params: Promise<{ learningId: string }> }

export function POST(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { learningId } = await context.params
    const input = await readDataBody(request, ApproveLearningBodySchema)
    const result = await new FirestoreLearningStore().approve(actor, learningId, input)
    return dataResponse(VersionedLearningSchema, result)
  })
}
