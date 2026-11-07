import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleGenerateTripRequest } from '@/domain/samples'

import { POST } from './route'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const post = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/trips/generate-selected', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      request: { ...sampleGenerateTripRequest, learnings: [] },
      selectedLearningIds: ['learning-rest'],
    }),
  })

describe('本人の保存済み学びを使う生成API', () => {
  it('生成・保存の両フラグが有効でなければ外部サービスを呼ばず503', async () => {
    vi.stubEnv('TRIP_GENERATION_ENABLED', 'false')
    vi.stubEnv('PERSISTENCE_ENABLED', 'true')
    const response = await POST(post())
    expect(response.status).toBe(503)
    expect((await response.json()).status).toBe('service_unavailable')

    vi.stubEnv('TRIP_GENERATION_ENABLED', 'true')
    vi.stubEnv('PERSISTENCE_ENABLED', 'false')
    const next = await POST(post())
    expect(next.status).toBe(503)
  })

  it('未認証で有効な機能フラグでもGemini呼び出し前に401を返す', async () => {
    vi.stubEnv('TRIP_GENERATION_ENABLED', 'true')
    vi.stubEnv('PERSISTENCE_ENABLED', 'true')
    const response = await POST(post())
    expect(response.status).toBe(401)
    expect((await response.json()).status).toBe('auth_required')
  })
})
