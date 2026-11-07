import { describe, expect, it, vi } from 'vitest'

import { sampleApprovedLearning } from '@/domain/samples'

import { loadApprovedLearningOptions } from './api-client'

const headers = async () => new Headers({ Authorization: 'Bearer test-token' })
const payload = (learnings: unknown[] = [{ learning: sampleApprovedLearning, version: 1 }]) => ({
  learnings,
  listInfo: { returned: learnings.length, skippedInvalid: 0, truncated: false },
})

describe('承認済みLearningの取得', () => {
  it('本人トークンを付け、完全な一覧だけを受け付ける', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(payload()),
    )
    const result = await loadApprovedLearningOptions({ fetchFn, getHeaders: headers })
    expect(result).toMatchObject({
      ok: true,
      items: [{ learning: sampleApprovedLearning, version: 1 }],
    })
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/learnings',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    )
    expect(fetchFn.mock.calls[0][1]?.headers).toBeInstanceOf(Headers)
  })

  it('未認証ならAPIを呼ばない。匿名UIDを自動作成しない', async () => {
    const fetchFn = vi.fn(async () => Response.json(payload()))
    const result = await loadApprovedLearningOptions({
      fetchFn,
      getHeaders: async () => {
        throw new Error('session_ended')
      },
    })
    expect(result).toMatchObject({ ok: false, kind: 'session' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('不完全な一覧、重複ID、不正な承認状態を拒否する', async () => {
    const cases = [
      { ...payload(), listInfo: { returned: 1, skippedInvalid: 1, truncated: false } },
      { ...payload(), listInfo: { returned: 1, skippedInvalid: 0, truncated: true } },
      payload([
        { learning: sampleApprovedLearning, version: 1 },
        { learning: sampleApprovedLearning, version: 2 },
      ]),
      payload([
        { learning: { ...sampleApprovedLearning, approval: { status: 'pending' } }, version: 1 },
      ]),
    ]
    for (const item of cases) {
      const result = await loadApprovedLearningOptions({
        fetchFn: async () => Response.json(item),
        getHeaders: headers,
      })
      expect(result).toMatchObject({ ok: false, kind: 'incomplete' })
    }
  })

  it('503と401は安全に表示できる失敗として返す', async () => {
    const unavailable = await loadApprovedLearningOptions({
      fetchFn: async () => new Response(null, { status: 503 }),
      getHeaders: headers,
    })
    const session = await loadApprovedLearningOptions({
      fetchFn: async () => new Response(null, { status: 401 }),
      getHeaders: headers,
    })
    expect(unavailable).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(session).toMatchObject({ ok: false, kind: 'session' })
  })
})
