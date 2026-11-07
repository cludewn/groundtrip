import 'server-only'

import { isDeepStrictEqual } from 'node:util'

import type { Trip } from '@/domain'
import type { Actor } from '@/lib/auth/server'
import { getAdminFirestore } from '@/lib/firebase/admin'

import { RecordIdSchema, UpdateTripBodySchema, type PendingRevision } from './contracts'
import {
  fromRevisionDocument,
  fromTripDocument,
  toRevisionDocument,
  toStopDto,
  toTripDocument,
} from './dto'
import { parseInput, PersistenceError } from './errors'
import { found, ownedCollection, readOwned, recordKey } from './paths'

export class FirestoreTripStore {
  constructor(private readonly db = getAdminFirestore()) {}

  private trips(actor: Actor) {
    return ownedCollection(this.db, actor, 'trips')
  }

  private trip(actor: Actor, id: string) {
    return this.trips(actor).doc(recordKey(id))
  }

  async createTrip(actor: Actor, input: Trip): Promise<Trip> {
    const document = toTripDocument(actor, input)
    const ref = this.trip(actor, document.trip.id)
    const trip = fromTripDocument(document, ref.id)
    if (trip.version !== 0) throw new PersistenceError('invalid_request')

    await this.db.runTransaction(async (transaction) => {
      if (readOwned(actor, await transaction.get(ref), fromTripDocument)) {
        throw new PersistenceError('already_exists')
      }
      transaction.create(ref, document)
    })
    return trip
  }

  async getTrip(actor: Actor, id: string): Promise<Trip> {
    return found(readOwned(actor, await this.trip(actor, id).get(), fromTripDocument))
  }

  async listTrips(actor: Actor): Promise<Trip[]> {
    const result = await this.trips(actor).where('ownerUid', '==', actor.uid).get()
    return result.docs.map((doc) => found(readOwned(actor, doc, fromTripDocument)))
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
      transaction.set(ref, document)
      return trip
    })
  }

  async saveRevision(
    actor: Actor,
    tripId: string,
    input: PendingRevision,
  ): Promise<PendingRevision> {
    const document = toRevisionDocument(actor, input)
    const normalizedTripId = parseInput(RecordIdSchema, tripId)
    const tripRef = this.trip(actor, normalizedTripId)
    const ref = tripRef.collection('revisions').doc(recordKey(document.revision.id))
    if (document.revision.tripId !== normalizedTripId) throw new PersistenceError('invalid_request')
    const revision = fromRevisionDocument(document, normalizedTripId, ref.id)

    await this.db.runTransaction(async (transaction) => {
      const trip = found(readOwned(actor, await transaction.get(tripRef), fromTripDocument))
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
      transaction.create(ref, document)
    })
    return revision
  }

  async getRevision(actor: Actor, tripId: string, revisionId: string): Promise<PendingRevision> {
    const trip = await this.getTrip(actor, tripId)
    const snapshot = await this.trip(actor, trip.id)
      .collection('revisions')
      .doc(recordKey(revisionId))
      .get()
    return found(
      readOwned(actor, snapshot, (data, key) => fromRevisionDocument(data, trip.id, key)),
    )
  }

  async listRevisions(actor: Actor, tripId: string): Promise<PendingRevision[]> {
    const trip = await this.getTrip(actor, tripId)
    const result = await this.trip(actor, trip.id)
      .collection('revisions')
      .where('ownerUid', '==', actor.uid)
      .get()
    return result.docs.map((doc) =>
      found(readOwned(actor, doc, (data, key) => fromRevisionDocument(data, trip.id, key))),
    )
  }
}
