import {
  ResolveRevisionReportSchema,
  RevisionReportResponseSchema,
} from '@/server/persistence/contracts'
import { dataResponse, readDataBody, withDataActor } from '@/server/persistence/http'
import { FirestoreTripStore } from '@/server/persistence/trips'

export const runtime = 'nodejs'
type Context = { params: Promise<{ tripId: string; stopId: string }> }

export function GET(request: Request, context: Context) {
  return withDataActor(request, async (actor) => {
    const { tripId, stopId } = await context.params
    return dataResponse(
      RevisionReportResponseSchema,
      await new FirestoreTripStore().revisionReport(actor, tripId, stopId),
    )
  })
}

export function POST(request: Request, context: Context) {
  return withDataActor(request, async (actor) => {
    const { tripId, stopId } = await context.params
    const input = await readDataBody(request, ResolveRevisionReportSchema)
    return dataResponse(
      RevisionReportResponseSchema,
      await new FirestoreTripStore().revisionReport(actor, tripId, stopId, input),
    )
  })
}
