import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { POST as approveLearning } from '@/app/api/learnings/[learningId]/approve/route'
import {
  DELETE as revokeLearning,
  GET as getLearning,
} from '@/app/api/learnings/[learningId]/route'
import { GET as listLearnings } from '@/app/api/learnings/route'
import { GET as getRevision } from '@/app/api/trips/[tripId]/revisions/[revisionId]/route'
import {
  GET as listRevisions,
  POST as saveRevision,
} from '@/app/api/trips/[tripId]/revisions/route'
import { GET as getTrip, PATCH as updateTrip } from '@/app/api/trips/[tripId]/route'
import { GET as listTrips, POST as createTrip } from '@/app/api/trips/route'
import { ReviseTripRequestSchema } from '@/domain'
import { sampleLearning, sampleRevision, sampleTrip } from '@/domain/samples'
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase/admin'
import { editLearning, rejectLearning } from '@/lib/learnings/lifecycle'
import { getApplicableLearnings } from '@/server/learnings/store'
import {
  RevisionResponseSchema,
  TripResponseSchema,
  VersionedLearningSchema,
} from '@/server/persistence/contracts'
import { FirestoreLearningStore } from '@/server/persistence/learnings'

const apps: FirebaseApp[] = []

async function createSession(name: string) {
  const app = initializeApp({ projectId: 'demo-groundtrip', apiKey: 'demo-api-key' }, name)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const { user } = await signInAnonymously(auth)
  const token = await user.getIdToken()
  return {
    uid: user.uid,
    request(method = 'GET', body?: unknown, query = '') {
      return new Request(`http://localhost/api${query}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
  }
}

let a: Awaited<ReturnType<typeof createSession>>
let b: typeof a

const tripInput = (id: string) => ({ ...sampleTrip, id, learningApplications: [] })
const context = <T>(params: T) => ({ params: Promise.resolve(params) })

async function saveTrip(id: string, session = a) {
  const response = await createTrip(session.request('POST', tripInput(id)))
  expect(response.status).toBe(201)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  return TripResponseSchema.parse(await response.json()).trip
}

function learningInput(
  sourceTripId: string,
  expectedVersion = 0,
  content = sampleLearning.content,
) {
  return {
    sourceTripId,
    expectedVersion,
    content,
    category: sampleLearning.category,
    scope: sampleLearning.scope,
  }
}

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
}

beforeAll(async () => {
  ;[a, b] = await Promise.all([createSession('persistence-a'), createSession('persistence-b')])
})

afterAll(async () => {
  await Promise.all(apps.map(deleteApp))
})

describe('Firestore Emulator＋認証済みRoute Handlers', () => {
  it('Tripを保存・取得し、所有者の一覧にだけ含める。別UIDは取得・更新できない', async () => {
    const trip = await saveTrip('isolated-trip')
    const params = context({ tripId: trip.id })
    const own = await getTrip(a.request(), params)
    expect(TripResponseSchema.parse(await own.json()).trip).toEqual(trip)
    expect(trip.stops[0]).toMatchObject({ isFixed: true, evidence: [] })
    expect(await (await listTrips(a.request())).json()).toMatchObject({ trips: [trip] })
    expect(await (await listTrips(b.request())).json()).toEqual({ trips: [] })
    const wrongOwner = await getTrip(b.request(), params)
    const missing = await getTrip(a.request(), context({ tripId: 'missing-trip' }))
    expect(wrongOwner.status).toBe(404)
    expect(await wrongOwner.json()).toEqual(await missing.json())
    await expectCode(
      await updateTrip(b.request('PATCH', { expectedVersion: 0, preferences: [] }), params),
      404,
      'not_found',
    )
    await expectCode(await createTrip(a.request('POST', tripInput(trip.id))), 409, 'already_exists')
  })

  it('照合に失敗した予定名と照合済みのPlace IDを保持し、Mapsの一時データを保存しない', async () => {
    const tripId = 'places-lookup-trip'
    const input = tripInput(tripId)
    const placesEvidence = {
      ...sampleTrip.stops[0].evidence[0],
      source: { kind: 'places', label: 'Places' },
      claim: 'Places取得の表示名と住所',
      explanation: 'Mapsの営業時間 07:29〜17:00',
    }
    const payload = {
      ...input,
      region: '京都市',
      stops: [
        {
          ...input.stops[0],
          name: '本人入力の庭園',
          evidence: [{ ...placesEvidence, status: 'unverifiable' }],
        },
        {
          ...input.stops[1],
          name: 'AI提案の昼食店',
          placeId: 'ChIJ-lookup-reference',
          evidence: [
            placesEvidence,
            {
              ...placesEvidence,
              id: 'travel-example',
              subject: 'travel_time',
              source: { kind: 'routes', label: 'Routes' },
              explanation: 'Mapsの移動時間 37分',
            },
          ],
        },
        ...input.stops.slice(2),
      ],
    }
    const created = await createTrip(a.request('POST', payload))
    expect(created.status).toBe(201)
    const response = await getTrip(a.request(), context({ tripId }))
    expect(response.status).toBe(200)
    const { trip } = TripResponseSchema.parse(await response.json())
    expect(trip.stops[0]).toMatchObject({
      name: '本人入力の庭園',
      placeId: null,
      evidence: [],
    })
    expect(trip.stops[1]).toMatchObject({
      name: 'AI提案の昼食店',
      placeId: 'ChIJ-lookup-reference',
      evidence: [],
    })
    expect(trip.region).toBe('京都市')
    expect(
      ReviseTripRequestSchema.safeParse({
        trip,
        targetStopId: trip.stops[1].id,
        reason: '昼食だけ見直したい',
        context: { phase: 'planning' },
      }).success,
    ).toBe(true)

    const raw = await getAdminFirestore().doc(`users/${a.uid}/trips/${tripId}`).get()
    expect(raw.get('trip.stops')).toMatchObject([
      { planName: '本人入力の庭園', placeId: null },
      { planName: 'AI提案の昼食店', placeId: 'ChIJ-lookup-reference' },
      { planName: input.stops[2].name },
    ])
    expect(JSON.stringify(raw.data())).not.toMatch(/evidence|Places取得|07:29|37分|displayName/)
  })

  it('孤立サロゲートを含む書き込みを400で拒否し、日本語とサロゲートペアを保持する', async () => {
    const tripId = 'unicode-trip'
    const input = tripInput(tripId)
    const ref = getAdminFirestore().doc(`users/${a.uid}/trips/${tripId}`)
    const malformed = {
      ...input,
      stops: [{ ...input.stops[0], id: String.fromCharCode(0xd800) }, ...input.stops.slice(1)],
    }
    await expectCode(await createTrip(a.request('POST', malformed)), 400, 'invalid_request')
    expect((await ref.get()).exists).toBe(false)

    const stop = { ...input.stops[0], id: '庭園-𠮷', name: '𠮷野の庭園 🌸' }
    const preferences = ['ゆっくり散歩 🚶']
    const valid = { ...input, preferences, stops: [stop, ...input.stops.slice(1)] }
    expect((await createTrip(a.request('POST', valid))).status).toBe(201)
    const { trip } = TripResponseSchema.parse(
      await (await getTrip(a.request(), context({ tripId }))).json(),
    )
    expect(trip.stops[0]).toMatchObject({ id: stop.id, name: stop.name })
    expect(trip.preferences).toEqual(preferences)
  })

  it('同じTrip版の同時更新は一方だけを確定し、再送しても版を進めない', async () => {
    const trip = await saveTrip('concurrent-trip')
    const params = context({ tripId: trip.id })
    const update = (preferences: string[]) =>
      updateTrip(a.request('PATCH', { expectedVersion: 0, preferences }), params)
    const results = await Promise.all([update(['先に出発']), update(['ゆっくり出発'])])
    expect(results.map(({ status }) => status).toSorted()).toEqual([200, 409])
    await expectCode(await update(['先に出発']), 409, 'version_conflict')
    const result = TripResponseSchema.parse(await (await getTrip(a.request(), params)).json()).trip
    expect(result.version).toBe(1)
    expect(result.stops).toEqual(trip.stops)
    expect(result.preferences).toEqual(
      TripResponseSchema.parse(await results.find(({ ok }) => ok)?.json()).trip.preferences,
    )
  })

  it('Revisionを未承認で保存・取得し、クライアントの判定や承認でTripを書き換えない', async () => {
    const trip = await saveTrip('revision-trip')
    const params = context({ tripId: trip.id })
    const revision = {
      ...sampleRevision,
      tripId: trip.id,
      diff: { ...sampleRevision.diff, before: trip.stops[1] },
      impactSummary: 'Routes APIの移動時間13分',
      constraintCheck: { status: 'satisfied', explanation: 'Routes APIの移動時間13分' },
    }
    const itemParams = context({ tripId: trip.id, revisionId: revision.id })
    await expectCode(
      await saveRevision(
        a.request('POST', {
          ...revision,
          approval: { status: 'approved', decidedAt: '2026-11-07T00:00:00Z' },
        }),
        params,
      ),
      400,
      'invalid_request',
    )
    await expectCode(await saveRevision(b.request('POST', revision), params), 404, 'not_found')
    await expectCode(
      await saveRevision(
        a.request('POST', {
          ...revision,
          diff: { ...revision.diff, before: { ...revision.diff.before, name: '別の予定' } },
        }),
        params,
      ),
      409,
      'revision_mismatch',
    )
    const disguisedFixedStop = { ...trip.stops[0], isFixed: false }
    await expectCode(
      await saveRevision(
        a.request('POST', {
          ...revision,
          targetStopId: disguisedFixedStop.id,
          diff: {
            before: disguisedFixedStop,
            after: { ...disguisedFixedStop, name: '固定予定の差し替え' },
          },
        }),
        params,
      ),
      409,
      'revision_mismatch',
    )
    await expectCode(
      await saveRevision(a.request('POST', { ...revision, baseTripVersion: 1 }), params),
      409,
      'version_conflict',
    )
    const saved = await saveRevision(a.request('POST', revision), params)
    expect(saved.status).toBe(201)
    const stored = RevisionResponseSchema.parse(await saved.json()).revision
    expect(stored.approval.status).toBe('pending')
    expect(stored.constraintCheck.status).toBe('not_checked')
    expect(await (await getRevision(a.request(), itemParams)).json()).toEqual({ revision: stored })
    expect(await (await listRevisions(a.request(), params)).json()).toEqual({ revisions: [stored] })
    await expectCode(await getRevision(b.request(), itemParams), 404, 'not_found')
    await expectCode(await listRevisions(b.request(), params), 404, 'not_found')
    await expectCode(await saveRevision(a.request('POST', revision), params), 409, 'already_exists')
    expect(await (await getTrip(a.request(), params)).json()).toEqual({ trip })
    const raw = await getAdminFirestore()
      .doc(`users/${a.uid}/trips/${trip.id}/revisions/${revision.id}`)
      .get()
    expect(JSON.stringify(raw.data())).not.toMatch(/evidence|constraintCheck|Routes API|13分/)
  })

  it('Learningの明示承認・再承認・撤回を分け、他人の元Trip・Learningを変更できない', async () => {
    const trip = await saveTrip('learning-source-a')
    const otherTrip = await saveTrip('learning-source-b', b)
    const id = 'reviewed-learning'
    const params = context({ learningId: id })
    const store = new FirestoreLearningStore()
    const approve = (input: unknown, session = a) =>
      approveLearning(session.request('POST', input), params)
    const initial = learningInput(trip.id)
    await expectCode(await approve(initial, b), 404, 'not_found')
    await expectCode(
      await approve({ ...initial, approval: { status: 'pending' } }),
      400,
      'invalid_request',
    )
    // 実行時の入力防御も確認する。型の契約を迂回した直接呼び出しで候補を保存できない。
    await expect(
      Reflect.apply(store.saveApproved, store, [a.uid, sampleLearning, 0]),
    ).rejects.toMatchObject({ code: 'not_approved' })

    const first = VersionedLearningSchema.parse(await (await approve(initial)).json())
    expect(first).toMatchObject({ version: 1, learning: { id, approval: { status: 'approved' } } })
    expect(await (await getLearning(a.request(), params)).json()).toEqual(first)
    expect(await (await listLearnings(b.request())).json()).toEqual({ learnings: [] })
    expect(await getApplicableLearnings(store, a.uid, trip.region)).toEqual([first.learning])
    expect(await getApplicableLearnings(store, a.uid, '対象外の地域')).toEqual([])
    await expectCode(await getLearning(b.request(), params), 404, 'not_found')
    await expectCode(await approve(learningInput(otherTrip.id, 1), b), 404, 'not_found')
    await expectCode(
      await revokeLearning(b.request('DELETE', undefined, '?expectedVersion=1'), params),
      404,
      'not_found',
    )
    await expectCode(await approve(initial), 409, 'version_conflict')
    await expectCode(await approve(learningInput(trip.id, 1, '  ')), 400, 'invalid_request')
    const edited = editLearning(first.learning, { content: '再編集した下書き' })
    if (!edited.ok) throw new Error('テストの下書きが不正です')
    const rejected = rejectLearning(edited.learning, '2026-11-07T00:00:00Z')
    for (const draft of [edited.learning, rejected]) {
      await expect(
        Reflect.apply(store.saveApproved, store, [a.uid, draft, first.version]),
      ).rejects.toMatchObject({ code: 'not_approved' })
      expect(await (await listLearnings(a.request())).json()).toEqual({ learnings: [first] })
    }

    const next = learningInput(trip.id, 1, '訪問前に営業日を確認したい')
    const competing = await Promise.all([approve(next), approve(next)])
    expect(competing.map(({ status }) => status).toSorted()).toEqual([200, 409])
    const second = VersionedLearningSchema.parse(
      await (await getLearning(a.request(), params)).json(),
    )
    expect(second).toMatchObject({ version: 2, learning: { content: next.content } })
    await expectCode(
      await revokeLearning(a.request('DELETE', undefined, '?expectedVersion=1'), params),
      409,
      'version_conflict',
    )
    expect(
      (await revokeLearning(a.request('DELETE', undefined, '?expectedVersion=2'), params)).status,
    ).toBe(204)
    await expectCode(await getLearning(a.request(), params), 404, 'not_found')
    await expectCode(await approve(initial), 409, 'version_conflict')
    expect(await store.listApproved(a.uid)).toEqual([])
    const raw = await getAdminFirestore().doc(`users/${a.uid}/learnings/${id}`).get()
    expect(raw.data()).toMatchObject({ state: 'revoked', id })
    expect(raw.data()).not.toHaveProperty('learning')
  })

  it('書き込みをキューに追加した後で取引が失敗してもTrip・旧承認のLearningを維持する', async () => {
    const trip = await saveTrip('rollback-trip')
    const tripParams = context({ tripId: trip.id })
    const learningParams = context({ learningId: 'rollback-learning' })
    const first = await approveLearning(a.request('POST', learningInput(trip.id)), learningParams)
    expect(first.status).toBe(200)
    const original = await first.json()

    const db = getAdminFirestore()
    const runTransaction = db.runTransaction.bind(db)
    const failure = vi.spyOn(db, 'runTransaction').mockImplementation((operation) =>
      runTransaction(async (transaction) => {
        await operation(transaction)
        throw new Error('injected failure before commit')
      }),
    )
    try {
      const update = await updateTrip(
        a.request('PATCH', { expectedVersion: 0, preferences: ['反映されない希望'] }),
        tripParams,
      )
      await expectCode(update, 503, 'storage_unavailable')
      const approve = await approveLearning(
        a.request('POST', learningInput(trip.id, 1, '反映されない学び')),
        learningParams,
      )
      await expectCode(approve, 503, 'storage_unavailable')
      expect(failure).toHaveBeenCalledTimes(2)
    } finally {
      failure.mockRestore()
    }

    expect(await (await getTrip(a.request(), tripParams)).json()).toEqual({ trip })
    expect(await (await getLearning(a.request(), learningParams)).json()).toEqual(original)
  })

  it('DB内の所有者不一致を404にし、本人データの破損は安全な500にする', async () => {
    const db = getAdminFirestore()
    const tripId = 'broken-trip'
    const ref = db.doc(`users/${a.uid}/trips/${tripId}`)
    const params = context({ tripId })
    await ref.set({ ownerUid: b.uid, trip: { version: -1 } })
    await expectCode(await getTrip(a.request(), params), 404, 'not_found')
    await ref.set({ ownerUid: a.uid, trip: { version: -1 } })
    await expectCode(await getTrip(a.request(), params), 500, 'invalid_stored_data')
    await expectCode(
      await updateTrip(a.request('PATCH', { expectedVersion: 0, preferences: [] }), params),
      500,
      'invalid_stored_data',
    )
    expect((await ref.get()).get('trip.version')).toBe(-1)
    await ref.delete()
  })

  it('不正なトークンや無効化済みアカウントではデータAPIを利用できない', async () => {
    await expectCode(
      await listTrips(
        new Request('http://localhost/api', { headers: { Authorization: 'Bearer a.b.c' } }),
      ),
      401,
      'invalid_token',
    )
    const disabled = await createSession('persistence-disabled')
    await getAdminAuth().updateUser(disabled.uid, { disabled: true })
    await expectCode(await listTrips(disabled.request()), 401, 'session_revoked')
  })
})
