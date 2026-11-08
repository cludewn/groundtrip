import { createLazyMapsClient } from '@/server/maps'
import {
  ApplyRevisionBodySchema,
  ApplyRevisionResponseSchema,
} from '@/server/persistence/contracts'
import { PersistenceError } from '@/server/persistence/errors'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'
import { createRevisionVerifier } from '@/server/revision/verify-for-apply'

export const runtime = 'nodejs'

const verify = createRevisionVerifier(createLazyMapsClient(process.env))
type Context = { params: Promise<{ tripId: string; revisionId: string }> }

export function POST(request: Request, context: Context): Promise<Response> {
  return withDataActor(request, async (actor) => {
    if (process.env.TRIP_REVISION_APPLY_ENABLED?.trim() !== 'true') {
      throw new PersistenceError('revision_apply_disabled')
    }
    const { tripId, revisionId } = await context.params
    const { expectedVersion } = await readDataBody(request, ApplyRevisionBodySchema)
    const result = await new FirestoreTripStore().applyRevision(
      actor,
      tripId,
      revisionId,
      expectedVersion,
      verify,
    )
    return dataResponse(ApplyRevisionResponseSchema, result)
  })
}
