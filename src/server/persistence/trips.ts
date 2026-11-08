import 'server-only'

import { isDeepStrictEqual } from 'node:util'

import type { ReviseTripRequest, Trip } from '@/domain'
import type { Actor } from '@/lib/auth/server'
import { getAdminFirestore } from '@/lib/firebase/admin'

import { normalizeModes } from '../verification/segment'
import {
  PendingRevisionSchema,
  CreateTripBodySchema,
  RecordIdSchema,
  ResolveRevisionReportSchema,
  TripIdSchema,
  SaveRevisionBodySchema,
  UpdateTripBodySchema,
  type PendingRevision,
  type SaveRevisionBody,
  type SavedRevision,
} from './contracts'
import {
  fromRevisionDocument,
  fromTripDocument,
  toRevisionDocument,
  toStopDto,
  toTripDocument,
} from './dto'
import { parseInput, parseStored, PersistenceError } from './errors'
import { reserveDocumentSlot, REVISION_LIMIT, TRIP_LIMIT } from './limits'
import { found, listOwned, ownedCollection, readOwned, recordKey } from './paths'
import { applyStoredRevision, type VerifyRevision } from './revision-apply'
import { verifyRevisionProposal } from './revision-provenance'
import {
  changeReportState,
  hasUnresolvedReport,
  readReportStates,
  reportState,
  storedReportStates,
} from './revision-reports'

export class FirestoreTripStore {
  constructor(private readonly db = getAdminFirestore()) {}

  private trips(actor: Actor) {
    return ownedCollection(this.db, actor, 'trips')
  }

  private trip(actor: Actor, id: string) {
    return this.trips(actor).doc(recordKey(id))
  }

  async createTrip(actor: Actor, input: Trip): Promise<Trip> {
    const document = toTripDocument(actor, parseInput(CreateTripBodySchema, input))
    const collection = this.trips(actor)
    const ref = collection.doc(recordKey(document.trip.id))
    const trip = fromTripDocument(document, ref.id)

    await this.db.runTransaction(async (transaction) => {
      if (readOwned(actor, await transaction.get(ref), fromTripDocument)) {
        throw new PersistenceError('already_exists')
      }
      await reserveDocumentSlot(transaction, collection, TRIP_LIMIT)
      transaction.create(ref, { ...document, revisionReports: [] })
    })
    return trip
  }

  async getTrip(actor: Actor, id: string): Promise<Trip> {
    return found(readOwned(actor, await this.trip(actor, id).get(), fromTripDocument))
  }

  async listTrips(actor: Actor) {
    return listOwned(actor, this.trips(actor), TRIP_LIMIT, fromTripDocument)
  }

  async updatePreferences(
    actor: Actor,
    id: string,
    expectedVersion: number,
    preferences: string[],
  ): Promise<Trip> {
    const ref = this.trip(actor, id)
    const update = parseInput(UpdateTripBodySchema, { expectedVersion, preferences })

    return this.db.runTransaction(async (transaction) => {
      const current = found(readOwned(actor, await transaction.get(ref), fromTripDocument))
      if (current.version !== update.expectedVersion) throw new PersistenceError('version_conflict')

      const document = toTripDocument(actor, {
        ...current,
        version: current.version + 1,
        preferences: update.preferences,
      })
      const trip = fromTripDocument(document, ref.id)
      transaction.update(ref, { trip: document.trip })
      return trip
    })
  }

  async prepareRevisionGeneration(actor: Actor, request: ReviseTripRequest) {
    const ref = this.trip(actor, request.trip.id)
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref)
      const trip = readOwned(actor, snapshot, fromTripDocument)
      if (!trip) return
      if (trip.version !== request.trip.version) throw new PersistenceError('version_conflict')
      if (!isDeepStrictEqual(toTripDocument(actor, trip), toTripDocument(actor, request.trip))) {
        throw new PersistenceError('revision_mismatch')
      }
      const target = request.trip.stops.find(({ id }) => id === request.targetStopId)
      if (!target || target.isFixed) throw new PersistenceError('revision_mismatch')
      let states = await readReportStates(transaction, actor, snapshot, trip)
      const reported = hasUnresolvedReport(request.context, target)
      if (reported) states = changeReportState(states, target.id, true)
      if (reported || !storedReportStates(snapshot))
        transaction.update(ref, { revisionReports: states })
      return { ...reportState(states, target.id), reported }
    })
  }

  async revisionReport(
    actor: Actor,
    tripId: string,
    stopId: string,
    input?: import('zod').z.infer<typeof ResolveRevisionReportSchema>,
  ) {
    const ref = this.trip(actor, parseInput(TripIdSchema, tripId))
    const targetId = parseInput(RecordIdSchema, stopId)
    return this.db.runTransaction(
      async (transaction) => {
        const snapshot = await transaction.get(ref)
        const trip = found(readOwned(actor, snapshot, fromTripDocument))
        found(trip.stops.find(({ id }) => id === targetId))
        let states = await readReportStates(transaction, actor, snapshot, trip)
        if (input) {
          if (trip.version !== input.expectedVersion) throw new PersistenceError('version_conflict')
          const state = reportState(states, targetId)
          if (state.reportVersion !== input.expectedReportVersion)
            throw new PersistenceError('revision_report_changed')
          if (state.blocked) {
            states = changeReportState(states, targetId, false)
            transaction.update(ref, { revisionReports: states })
          }
        }
        return { tripVersion: trip.version, ...reportState(states, targetId) }
      },
      input ? undefined : { readOnly: true },
    )
  }

  async saveRevision(
    actor: Actor,
    tripId: string,
    input: SaveRevisionBody,
  ): Promise<PendingRevision> {
    const { travelModes, proposalToken, ...candidate } = parseInput(SaveRevisionBodySchema, input)
    const document = toRevisionDocument(actor, candidate, normalizeModes(travelModes))
    const normalizedTripId = parseInput(RecordIdSchema, tripId)
    const tripRef = this.trip(actor, normalizedTripId)
    const collection = tripRef.collection('revisions')
    const ref = collection.doc(recordKey(document.revision.id))
    if (document.revision.tripId !== normalizedTripId) throw new PersistenceError('invalid_request')
    const revision = parseStored(
      PendingRevisionSchema,
      fromRevisionDocument(document, normalizedTripId, ref.id),
    )

    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(tripRef)
      const trip = found(readOwned(actor, snapshot, fromTripDocument))
      if (trip.version !== revision.baseTripVersion) throw new PersistenceError('version_conflict')
      const currentStop = trip.stops.find(({ id }) => id === revision.targetStopId)
      if (
        !currentStop ||
        currentStop.isFixed ||
        !isDeepStrictEqual(toStopDto(currentStop), document.revision.diff.before)
      ) {
        throw new PersistenceError('revision_mismatch')
      }
      const existing = await transaction.get(ref)
      if (readOwned(actor, existing, (data, key) => fromRevisionDocument(data, trip.id, key))) {
        throw new PersistenceError('already_exists')
      }
      const proof = proposalToken
        ? verifyRevisionProposal(actor, trip, document, proposalToken)
        : undefined
      let states = await readReportStates(transaction, actor, snapshot, trip)
      const state = reportState(states, revision.targetStopId)
      const reported = hasUnresolvedReport(
        revision.context,
        revision.diff.before,
        revision.diff.after,
      )
      if (
        proof &&
        (proof.proposalContext.reportVersion !== state.reportVersion ||
          (state.blocked && !reported))
      ) {
        throw new PersistenceError('revision_report_changed')
      }
      const recordReport = reported && (!proof || !state.blocked)
      if (recordReport) states = changeReportState(states, revision.targetStopId, true)
      await reserveDocumentSlot(transaction, collection, REVISION_LIMIT)
      if (recordReport || !storedReportStates(snapshot))
        transaction.update(tripRef, { revisionReports: states })
      transaction.create(ref, {
        ...document,
        revision: {
          ...document.revision,
          ...proof,
        },
      })
    })
    return revision
  }

  async getRevision(actor: Actor, tripId: string, revisionId: string): Promise<SavedRevision> {
    const trip = await this.getTrip(actor, tripId)
    const snapshot = await this.trip(actor, trip.id)
      .collection('revisions')
      .doc(recordKey(revisionId))
      .get()
    return found(
      readOwned(actor, snapshot, (data, key) => fromRevisionDocument(data, trip.id, key)),
    )
  }

  applyRevision(
    actor: Actor,
    tripId: string,
    revisionId: string,
    expectedVersion: number,
    verify: VerifyRevision,
  ) {
    const tripRef = this.trip(actor, parseInput(TripIdSchema, tripId))
    return applyStoredRevision(this.db, actor, tripRef, revisionId, expectedVersion, verify)
  }

  async listRevisions(actor: Actor, tripId: string) {
    const trip = await this.getTrip(actor, tripId)
    const collection = this.trip(actor, trip.id).collection('revisions')
    return listOwned(actor, collection, REVISION_LIMIT, (data, key) =>
      fromRevisionDocument(data, trip.id, key),
    )
  }
}
