import { beforeEach, describe, expect, it, vi } from 'vitest'

import { POST as approve } from '@/app/api/learnings/[learningId]/approve/route'
import { POST as saveRevision } from '@/app/api/trips/[tripId]/revisions/route'
import { PATCH as updateTrip } from '@/app/api/trips/[tripId]/route'
import { GET as listTrips, POST as createTrip } from '@/app/api/trips/route'
import { sampleLearning, sampleRevision, sampleTrip } from '@/domain/samples'
import { getAdminFirestore } from '@/lib/firebase/admin'

const verifyIdToken = vi.hoisted(() => vi.fn())
vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken }),
  getAdminFirestore: vi.fn(),
}))

const trip = { ...sampleTrip, learningApplications: [] }

function request(body?: unknown, authorization = 'Bearer a.b.c') {
  return new Request('http://localhost/api/trips', {
    headers: { authorization, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  verifyIdToken.mockResolvedValue({ uid: 'actor' })
  vi.mocked(getAdminFirestore).mockImplementation(() => {
    throw new Error('private credential and UID')
  })
})

describe('Firestore APIのHTTP境界', () => {
  it.each([
    ['auth/argument-error', 'invalid_token'],
    ['auth/id-token-revoked', 'session_revoked'],
    ['auth/id-token-expired', 'token_expired'],
  ])('認証失敗 %s は保存先への接続前に拒否する', async (code, expected) => {
    verifyIdToken.mockRejectedValue({ code })
    const response = await createTrip(request(trip))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: expected } })
    expect(verifyIdToken).toHaveBeenCalledWith('a.b.c', true)
    expect(getAdminFirestore).not.toHaveBeenCalled()
  })

  it('不正な入力・所有者・新しい版・承認の自己申告は入力エラーにする', async () => {
    const tripContext = { params: Promise.resolve({ tripId: trip.id }) }
    const learningContext = { params: Promise.resolve({ learningId: 'learning' }) }
    const responses = await Promise.all([
      createTrip(request({ ...trip, ownerUid: 'other' })),
      createTrip(request({ ...trip, version: 5 })),
      createTrip(
        request({
          ...trip,
          stops: [{ ...trip.stops[0], displayName: 'Places取得名' }, ...trip.stops.slice(1)],
        }),
      ),
      updateTrip(request({ expectedVersion: 0, version: 1, preferences: [] }), tripContext),
      updateTrip(request({ expectedVersion: 0, preferences: [], stops: trip.stops }), tripContext),
      approve(
        request({
          expectedVersion: 0,
          sourceTripId: trip.id,
          category: 'preference',
          content: '本人が確認する内容',
          scope: { kind: 'all_trips' },
          approval: { status: 'approved', decidedAt: '2026-11-07T00:00:00Z' },
        }),
        learningContext,
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400])
    expect(getAdminFirestore).not.toHaveBeenCalled()
  })

  it('ネストしたID・予定名・希望・現地報告・学びの不正UnicodeをDBに接続する前に拒否する', async () => {
    const high = String.fromCharCode(0xd800)
    const low = String.fromCharCode(0xdc00)
    const tripContext = { params: Promise.resolve({ tripId: trip.id }) }
    const learningContext = { params: Promise.resolve({ learningId: sampleLearning.id }) }
    const learning = {
      expectedVersion: 0,
      sourceTripId: trip.id,
      category: sampleLearning.category,
      content: sampleLearning.content,
      scope: sampleLearning.scope,
    }
    const responses = await Promise.all([
      createTrip(
        request({ ...trip, stops: [{ ...trip.stops[0], id: high }, ...trip.stops.slice(1)] }),
      ),
      createTrip(
        request({ ...trip, stops: [{ ...trip.stops[0], name: low }, ...trip.stops.slice(1)] }),
      ),
      updateTrip(request({ expectedVersion: 0, preferences: ['希望' + high] }), tripContext),
      saveRevision(
        request({
          ...sampleRevision,
          context: { phase: 'on_site', report: { kind: 'actual', description: low } },
        }),
        tripContext,
      ),
      approve(request({ ...learning, scope: { kind: 'region', region: high } }), learningContext),
      approve(request({ ...learning, content: low }), learningContext),
    ])
    for (const response of responses) {
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
    }
    expect(getAdminFirestore).not.toHaveBeenCalled()
  })

  it('DB障害を503とし、内部情報を含めず共有キャッシュを禁止する', async () => {
    const response = await listTrips(request())
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const result = await response.text()
    expect(result).toContain('storage_unavailable')
    expect(result).not.toContain('private credential')
  })
})
