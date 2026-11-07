import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleApprovedLearning, sampleRevision, sampleTrip } from '@/domain/samples'
import { getAuthHeaders } from '@/lib/auth/client'

import { createFirestoreLearningStore, loadReflectionHistory, loadSavedTrips } from './api-client'

vi.mock('@/lib/auth/client', () => ({
  getAuthHeaders: vi.fn(),
}))

const listInfo = { returned: 0, skippedInvalid: 0, truncated: false }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

beforeEach(() => {
  vi.mocked(getAuthHeaders).mockResolvedValue(new Headers({ Authorization: '***' }))
})

describe('振り返りの保存済みデータ取得', () => {
  it('認証済みの旅程だけを取得し、認証トークンは送るが再利用できるキャッシュには載せない', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ trips: [sampleTrip], listInfo: { ...listInfo, returned: 1 } }))
    const result = await loadSavedTrips({ fetchFn })
    expect(result.trips).toEqual([sampleTrip])
    const [, init] = fetchFn.mock.calls[0]
    expect(init.headers.get('Authorization')).toBe('***')
    expect(init.cache).toBe('no-store')
  })

  it('旅程と変更履歴の両方が揃って初めて振り返りに渡す', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path.endsWith('/revisions')
          ? json({ revisions: [sampleRevision], listInfo: { ...listInfo, returned: 1 } })
          : json({ trip: sampleTrip }),
      )
    const history = await loadReflectionHistory(sampleTrip.id, { fetchFn })
    expect(history.trip).toEqual(sampleTrip)
    expect(history.revisions).toEqual([sampleRevision])
  })

  it('履歴が欠けている場合は学び作成に使わない', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path.endsWith('/revisions')
          ? json({ revisions: [], listInfo: { ...listInfo, truncated: true } })
          : json({ trip: sampleTrip }),
      )
    await expect(loadReflectionHistory(sampleTrip.id, { fetchFn })).rejects.toThrow(
      'すべて確認できませんでした',
    )
  })

  it('認証に失敗したらリクエストせず、新しい匿名UIDを自動作成しない', async () => {
    vi.mocked(getAuthHeaders).mockRejectedValue(new Error('認証が切れました'))
    const fetchFn = vi.fn()
    await expect(loadSavedTrips({ fetchFn })).rejects.toThrow('認証が切れました')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('承認済み学びのFirestore保存', () => {
  it('本人が承認した学びをexpectedVersion=0で新規保存する', async () => {
    const fetchFn = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/api/learnings') return json({ learnings: [], listInfo })
      return json({ version: 1, learning: sampleApprovedLearning })
    })
    const onSaved = vi.fn()
    const store = createFirestoreLearningStore(onSaved, fetchFn)
    expect(await store.save([sampleApprovedLearning])).toEqual({ ok: true })
    expect(onSaved).toHaveBeenCalledTimes(1)

    const [url, init] = fetchFn.mock.calls[1]
    expect(url).toBe('/api/learnings/learning-rest/approve')
    expect(init.method).toBe('POST')
    expect(init.headers.get('Authorization')).toBe('***')
    expect(JSON.parse(init.body)).toEqual({
      expectedVersion: 0,
      sourceTripId: sampleApprovedLearning.sourceTripId,
      category: sampleApprovedLearning.category,
      content: sampleApprovedLearning.content,
      scope: sampleApprovedLearning.scope,
    })
    expect(JSON.parse(init.body)).not.toHaveProperty('approval')
  })

  it('保存済みなら同じ内容を再送信せず、内容を変えたときだけ版を更新する', async () => {
    const updated = { ...sampleApprovedLearning, content: '次回は歩く距離を短くする' }
    const fetchFn = vi.fn().mockImplementation(async (path: string) =>
      path === '/api/learnings'
        ? json({
            learnings: [{ version: 4, learning: sampleApprovedLearning }],
            listInfo: { ...listInfo, returned: 1 },
          })
        : json({ version: 5, learning: updated }),
    )
    const store = createFirestoreLearningStore(undefined, fetchFn)
    expect(await store.save([sampleApprovedLearning])).toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(await store.save([updated])).toEqual({ ok: true })
    expect(JSON.parse(fetchFn.mock.calls[2][1].body).expectedVersion).toBe(4)
  })

  it('一部だけ成功した場合は全件成功としない。次回は成功済みの学びを再取得して残りを保存する', async () => {
    const second = { ...sampleApprovedLearning, id: 'learning-second', content: '次は休憩を多めに' }
    let firstSaved = false
    let failed = false
    const fetchFn = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/api/learnings') {
        const learnings = firstSaved ? [{ version: 1, learning: sampleApprovedLearning }] : []
        return json({ learnings, listInfo: { ...listInfo, returned: learnings.length } })
      }
      if (path.endsWith('/learning-rest/approve')) {
        firstSaved = true
        return json({ version: 1, learning: sampleApprovedLearning })
      }
      if (!failed) {
        failed = true
        return json({ error: { code: 'storage_unavailable', message: '保存できません' } }, 503)
      }
      return json({ version: 1, learning: second })
    })
    const onSaved = vi.fn()
    const store = createFirestoreLearningStore(onSaved, fetchFn)
    const first = await store.save([sampleApprovedLearning, second])
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.message).toContain('1件は保存されました')
    expect(onSaved).not.toHaveBeenCalled()
    expect(await store.save([sampleApprovedLearning, second])).toEqual({ ok: true })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(
      fetchFn.mock.calls.filter(([url]) => url.endsWith('/learning-rest/approve')),
    ).toHaveLength(1)
  })

  it('保存済みの一覧が不完全なら、新しい書き込みを行わない', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ learnings: [], listInfo: { ...listInfo, skippedInvalid: 1 } }))
    const result = await createFirestoreLearningStore(undefined, fetchFn).save([
      sampleApprovedLearning,
    ])
    expect(result.ok).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('409の競合や503の保存不可を成功と扱わない', async () => {
    for (const status of [409, 503]) {
      const fetchFn = vi
        .fn()
        .mockImplementation(async (path: string) =>
          path === '/api/learnings'
            ? json({ learnings: [], listInfo })
            : json({ error: { code: 'version_conflict', message: '版が一致しません' } }, status),
        )
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([
        sampleApprovedLearning,
      ])
      expect(result.ok).toBe(false)
    }
  })
})
