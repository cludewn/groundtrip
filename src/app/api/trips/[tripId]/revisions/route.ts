import {
  PendingRevisionSchema,
  RevisionListResponseSchema,
  RevisionResponseSchema,
} from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'

type Context = { params: Promise<{ tripId: string }> }

export function GET(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { tripId } = await context.params
    const revisions = await new FirestoreTripStore().listRevisions(actor, tripId)
    return dataResponse(RevisionListResponseSchema, { revisions })
  })
}

export function POST(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    const { tripId } = await context.params
    const input = await readDataBody(request, PendingRevisionSchema)
    const revision = await new FirestoreTripStore().saveRevision(actor, tripId, input)
    return dataResponse(RevisionResponseSchema, { revision }, 201)
  })
}
