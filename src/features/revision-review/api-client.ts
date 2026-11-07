import { z } from 'zod'

import {
  ProposalFailureSchema,
  ReviseTripRequestSchema,
  ReviseTripResponseSchema,
  StopSchema,
  TripSchema,
  type ReviseTripRequest,
  type ReviseTripResponse,
  type Revision,
  type Stop,
  type Trip,
} from '@/domain'
import { IdSchema, TextSchema, TimestampSchema } from '@/domain/primitives'

export type RevisionRequest = ReviseTripRequest & { travelModes?: ('walk' | 'drive')[] }

// PR #28の比較データを、この画面の境界で受け取る。共通契約の統合後はそちらを使用する。
const segmentEnds = { fromStopId: IdSchema, toStopId: IdSchema, explanation: TextSchema }
const segmentSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...segmentEnds,
    status: z.literal('known'),
    mode: z.enum(['walk', 'drive']),
    durationMinutes: z.int().nonnegative(),
    distanceMeters: z.int().nonnegative().optional(),
    source: z.strictObject({ kind: z.enum(['routes', 'simulation']), label: TextSchema }),
    checkedAt: TimestampSchema,
  }),
  z
    .strictObject({
      ...segmentEnds,
      status: z.literal('unknown'),
      mode: z.enum(['walk', 'drive', 'transit']),
      reason: z.enum(['not_queried', 'transit_unsupported', 'no_route', 'api_error']),
      checkedAt: TimestampSchema.optional(),
    })
    .refine(
      ({ reason, checkedAt }) =>
        (reason === 'no_route' || reason === 'api_error') === (checkedAt !== undefined),
      { path: ['checkedAt'], message: '照会を試みた区間にだけ照合時刻が必要です' },
    ),
])

const slotSchema = z.discriminatedUnion('presence', [
  z.strictObject({ presence: z.literal('none'), reason: z.enum(['first_stop', 'last_stop']) }),
  z.strictObject({ presence: z.literal('segment'), segment: segmentSchema }),
])
const comparisonSideSchema = z.strictObject({ fromPrevious: slotSchema, toNext: slotSchema })
const comparisonSchema = z.strictObject({
  revisionId: IdSchema,
  before: comparisonSideSchema,
  after: comparisonSideSchema,
})
const proposalEnvelopeSchema = z.strictObject({
  status: z.literal('proposed'),
  revisions: z.unknown(),
  comparisons: z.array(comparisonSchema).optional(),
})

export type TravelComparison = z.infer<typeof comparisonSchema>
export type TravelSlot = z.infer<typeof slotSchema>
export type RevisionProposal = Extract<ReviseTripResponse, { status: 'proposed' }> & {
  comparisons?: TravelComparison[]
}

export type RevisionResult =
  | RevisionProposal
  | z.infer<typeof ProposalFailureSchema>
  | {
      status: 'unavailable' | 'interrupted' | 'conflict' | 'invalid_request' | 'unexpected'
      message?: string
    }

export type GenerateRevisions = (
  request: RevisionRequest,
  signal: AbortSignal,
) => Promise<RevisionResult>

// 本人の承認操作を受け取る。サーバーで適用を確認した場合にだけ applied を返す。
export type ApplyRevision = (decision: {
  request: RevisionRequest
  revision: Revision
}) => Promise<
  | { status: 'applied'; trip: Trip }
  | { status: 'conflict' | 'unavailable' | 'failed'; message?: string }
>

export const requestRevisions: GenerateRevisions = async (request, signal) => {
  const { travelModes, ...base } = request
  const input = ReviseTripRequestSchema.safeParse(base)
  if (!input.success) return { status: 'invalid_request' }

  let response: Response
  let bodyText: string
  try {
    response = await fetch('/api/trips/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input.data, travelModes }),
      signal,
    })
    if ([404, 405, 503].includes(response.status)) return { status: 'unavailable' }
    if (response.status === 409) return { status: 'conflict' }
    if ([400, 413, 415].includes(response.status)) return { status: 'invalid_request' }
    bodyText = await response.text()
  } catch {
    return { status: 'interrupted' }
  }

  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return { status: 'unexpected' }
  }
  if (response.status === 200) {
    return readRevisionProposal(body, request) ?? { status: 'unexpected' }
  }

  const failure = ProposalFailureSchema.safeParse(body)
  if (failure.success) {
    const expected = failure.data.status === 'external_service_error' ? 502 : 422
    if (response.status === expected) return failure.data
  }
  return { status: 'unexpected' }
}

function sameStop(left: Stop, right: Stop) {
  // 共通スキーマでキー順を揃え、根拠を含む変更前のStopを比較する。
  return JSON.stringify(StopSchema.parse(left)) === JSON.stringify(StopSchema.parse(right))
}

export function sameTrip(left: Trip, right: Trip): boolean {
  const parsedLeft = TripSchema.safeParse(left)
  const parsedRight = TripSchema.safeParse(right)
  return (
    parsedLeft.success &&
    parsedRight.success &&
    JSON.stringify(parsedLeft.data) === JSON.stringify(parsedRight.data)
  )
}

function matchesRevisionTarget(revision: Revision, trip: Trip, target: Stop) {
  return (
    !target.isFixed &&
    revision.approval.status === 'pending' &&
    revision.tripId === trip.id &&
    revision.baseTripVersion === trip.version &&
    revision.targetStopId === target.id &&
    sameStop(revision.diff.before, target)
  )
}

// HTTP応答と差し替えコールバックの両方で検証し、呼び出し元と参照を共有しないデータを返す。
export function readRevisionProposal(
  value: unknown,
  request: RevisionRequest,
): RevisionProposal | null {
  const envelope = proposalEnvelopeSchema.safeParse(value)
  if (!envelope.success) return null
  const { comparisons, ...core } = envelope.data
  const checked = ReviseTripResponseSchema.safeParse(core)
  if (!checked.success || checked.data.status !== 'proposed') return null
  const { revisions } = checked.data
  const { trip, targetStopId } = request
  const index = trip.stops.findIndex((stop) => stop.id === targetStopId)
  const target = trip.stops[index]
  if (!target || !revisions.every((revision) => matchesRevisionTarget(revision, trip, target)))
    return null
  if (!comparisons) return checked.data

  const previous = trip.stops[index - 1]
  const next = trip.stops[index + 1]
  const ids = new Set(revisions.map((revision) => revision.id))
  const comparisonsMatch =
    new Set(comparisons.map((comparison) => comparison.revisionId)).size === comparisons.length &&
    comparisons.every(
      ({ revisionId, before, after }) =>
        ids.has(revisionId) &&
        [before, after].every(({ fromPrevious, toNext }) => {
          const fromMatches = previous
            ? fromPrevious.presence === 'segment' &&
              fromPrevious.segment.fromStopId === previous.id &&
              fromPrevious.segment.toStopId === targetStopId
            : fromPrevious.presence === 'none' && fromPrevious.reason === 'first_stop'
          const toMatches = next
            ? toNext.presence === 'segment' &&
              toNext.segment.fromStopId === targetStopId &&
              toNext.segment.toStopId === next.id
            : toNext.presence === 'none' && toNext.reason === 'last_stop'
          return fromMatches && toMatches
        }),
    )
  return comparisonsMatch ? { ...checked.data, comparisons } : null
}

export function confirmedTrip(base: Trip, revision: Revision, result: Trip): Trip | null {
  const checked = TripSchema.safeParse(result)
  if (!checked.success) return null
  const trip = checked.data
  const index = base.stops.findIndex((stop) => stop.id === revision.targetStopId)
  const target = base.stops[index]
  const applied = trip.stops[index]
  if (
    !target ||
    !applied ||
    trip.version <= base.version ||
    revision.constraintCheck.status !== 'satisfied' ||
    !matchesRevisionTarget(revision, base, target)
  )
    return null

  // 再照合で根拠は更新され得る。承認した予定の内容と、対象外の旅程は一致する必要がある。
  const expected = { ...revision.diff.after, evidence: applied.evidence }
  if (!sameStop(applied, expected)) return null
  const withoutChange = {
    ...trip,
    version: base.version,
    stops: trip.stops.map((stop, position) => (position === index ? target : stop)),
  }
  return sameTrip(withoutChange, base) ? trip : null
}
