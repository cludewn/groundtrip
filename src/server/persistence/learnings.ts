import 'server-only'

import { ApprovedLearningSchema, type ApprovedLearning } from '@/domain'
import { AuthError, type Actor } from '@/lib/auth/server'
import { getAdminFirestore } from '@/lib/firebase/admin'
import { approveLearning, editLearning } from '@/lib/learnings/lifecycle'

import { LearningStoreError, type LearningStore } from '../learnings/store'
import {
  ApproveLearningBodySchema,
  RecordIdSchema,
  VersionSchema,
  type ApproveLearningBody,
  type VersionedLearning,
} from './contracts'
import {
  fromLearningDocument,
  fromTripDocument,
  toLearningDocument,
  toRevokedLearningDocument,
} from './dto'
import { parseInput, PersistenceError } from './errors'
import { found, ownedCollection, readOwned, recordKey } from './paths'

export class FirestoreLearningStore implements LearningStore {
  constructor(private readonly db = getAdminFirestore()) {}

  private learnings(actor: Actor) {
    return ownedCollection(this.db, actor, 'learnings')
  }

  async approve(actor: Actor, id: string, input: ApproveLearningBody): Promise<VersionedLearning> {
    const { expectedVersion, ...draft } = parseInput(ApproveLearningBodySchema, input)
    const edited = editLearning(
      { ...draft, id: parseInput(RecordIdSchema, id), approval: { status: 'pending' } },
      draft,
    )
    if (!edited.ok) throw new PersistenceError('invalid_request')
    // この専用操作を認証済み本人が送った時だけ、サーバーで承認を発行する。
    const learning = approveLearning(edited.learning, new Date().toISOString())
    await this.saveApproved(actor.uid, learning, expectedVersion)
    return { version: expectedVersion + 1, learning }
  }

  // 信頼済みサーバー処理専用。HTTP入力からApprovedLearningを直接渡さない。
  async saveApproved(ownerUid: string, learning: ApprovedLearning, expectedVersion: number) {
    const parsed = ApprovedLearningSchema.safeParse(learning)
    if (!parsed.success) {
      throw new LearningStoreError('not_approved', '承認済みの学びだけを保存できます')
    }
    const approved = parsed.data
    const actor = { uid: ownerUid }
    const ref = this.learnings(actor).doc(recordKey(approved.id))
    const source = ownedCollection(this.db, actor, 'trips').doc(recordKey(approved.sourceTripId))
    const version = parseInput(VersionSchema, expectedVersion)
    const document = toLearningDocument(actor, { version: version + 1, learning: approved })

    await this.db.runTransaction(async (transaction) => {
      const [snapshot, tripSnapshot] = await transaction.getAll(ref, source)
      const trip = found(readOwned(actor, tripSnapshot, fromTripDocument))
      const current = readOwned(actor, snapshot, fromLearningDocument)
      if (!current && version !== 0) throw new AuthError('not_found')
      if (current === null || (current?.version ?? 0) !== version) {
        throw new PersistenceError('version_conflict')
      }
      if (
        (current &&
          (current.learning.sourceTripId !== approved.sourceTripId ||
            current.learning.category !== approved.category)) ||
        (approved.scope.kind === 'region' && approved.scope.region !== trip.region)
      ) {
        throw new PersistenceError('invalid_request')
      }
      transaction.set(ref, document)
    })
  }

  async get(actor: Actor, id: string): Promise<VersionedLearning> {
    const snapshot = await this.learnings(actor).doc(recordKey(id)).get()
    return found(readOwned(actor, snapshot, fromLearningDocument))
  }

  async list(actor: Actor): Promise<VersionedLearning[]> {
    const result = await this.learnings(actor).where('ownerUid', '==', actor.uid).get()
    return result.docs.flatMap((doc) => readOwned(actor, doc, fromLearningDocument) ?? [])
  }

  async listApproved(ownerUid: string): Promise<ApprovedLearning[]> {
    return (await this.list({ uid: ownerUid })).map(({ learning }) => learning)
  }

  async remove(ownerUid: string, id: string, expectedVersion: number): Promise<boolean> {
    const actor = { uid: ownerUid }
    const ref = this.learnings(actor).doc(recordKey(id))
    const version = parseInput(VersionSchema, expectedVersion)
    const revoked = toRevokedLearningDocument(actor, id)
    return this.db.runTransaction(async (transaction) => {
      const current = readOwned(actor, await transaction.get(ref), fromLearningDocument)
      if (!current) return false
      if (current.version !== version) throw new PersistenceError('version_conflict')
      // 内容は消し、同じIDへの初回承認リクエストの再送による復活だけを防ぐ。
      transaction.set(ref, revoked)
      return true
    })
  }
}
