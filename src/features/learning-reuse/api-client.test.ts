import { describe, expect, it, vi } from 'vitest'

import { sampleApprovedLearning } from '@/domain/samples'

import { loadApprovedLearningOptions } from './api-client'

const headers = async () => new Headers({ Authorization: 'Bearer test-token' })
const payload = (learnings: unknown[] = [{ learning: sampleApprovedLearning, version: 1 }]) => ({
  learnings,
  listInfo: { returned: learnings.length, skippedInvalid: 0, truncated: false },
})
const load = (fetchFn: typeof fetch) =>
  loadApprovedLearningOptions({ fetchFn, getHeaders: headers })

describe('承認済みLearningの取得', () => {
  it('本人トークンを付け、完全な一覧だけを受け付ける', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const result = await load(fetchFn)
    expect(result).toMatchObject({
      ok: true,
      items: [{ learning: sampleApprovedLearning, version: 1 }],
    })
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/learnings',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    )
    // Authorizationの値そのもの（Headersの型だけでなく、本人のトークン）を送っていること。
    const init = fetchFn.mock.calls[0][1]
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token')
  })

  it('保存済みの学びが0件でも、完全な空の一覧として受け付ける', async () => {
    const result = await load(async () => Response.json(payload([])))
    expect(result).toEqual({ ok: true, items: [] })
  })

  it('未認証ならAPIを呼ばない。匿名UIDを自動作成しない', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
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
      const result = await load(async () => Response.json(item))
      expect(result).toMatchObject({ ok: false, kind: 'incomplete' })
    }
  })

  it('返却件数が実際の件数と一致しない一覧を拒否する', async () => {
    const mismatched = [
      { ...payload(), listInfo: { returned: 2, skippedInvalid: 0, truncated: false } },
      { ...payload(), listInfo: { returned: 0, skippedInvalid: 0, truncated: false } },
    ]
    for (const body of mismatched) {
      expect(await load(async () => Response.json(body))).toMatchObject({
        ok: false,
        kind: 'incomplete',
      })
    }
  })

  it('余分なキーや版のない項目を含む応答を、そのまま使わず拒否する', async () => {
    const extras = [
      { ...payload(), unexpected: true },
      { ...payload(), listInfo: { ...payload().listInfo, extra: 1 } },
      payload([{ learning: sampleApprovedLearning, version: 1, extra: 'x' }]),
      payload([{ learning: sampleApprovedLearning }]),
      payload([{ learning: sampleApprovedLearning, version: 0 }]),
    ]
    for (const body of extras) {
      expect(await load(async () => Response.json(body))).toMatchObject({
        ok: false,
        kind: 'incomplete',
      })
    }
  })

  it('JSONではない応答は、読み取れなかった失敗として返す', async () => {
    const result = await load(async () => new Response('<html>error</html>', { status: 200 }))
    expect(result).toMatchObject({ ok: false, kind: 'unexpected' })
  })

  it('500や想定外の状態は、空の一覧にせず失敗として返す', async () => {
    for (const status of [204, 404, 500]) {
      const result = await load(async () => new Response(null, { status }))
      expect(result).toMatchObject({ ok: false, kind: 'unexpected' })
    }
  })

  it('503と401と403は安全に表示できる失敗として返す', async () => {
    const unavailable = await load(async () => new Response(null, { status: 503 }))
    const session = await load(async () => new Response(null, { status: 401 }))
    const forbidden = await load(async () => new Response(null, { status: 403 }))
    expect(unavailable).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(session).toMatchObject({ ok: false, kind: 'session' })
    expect(forbidden).toMatchObject({ ok: false, kind: 'session' })
  })

  it('通信の失敗と、取得前の中断は、再試行できる失敗として返す', async () => {
    const offline = await load(async () => {
      throw new TypeError('network')
    })
    expect(offline).toMatchObject({ ok: false, kind: 'interrupted' })

    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(payload()))
    const aborted = await loadApprovedLearningOptions({
      fetchFn,
      getHeaders: headers,
      signal: AbortSignal.abort(),
    })
    expect(aborted).toMatchObject({ ok: false, kind: 'interrupted' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
