import { describe, expect, it, vi } from 'vitest'

import { createMapsAuth } from './auth'
import { createMapsClient, MapsCallError } from './index'

// PR #21 のレビュー対応の回帰テスト（営業時間の空配列・例外の機密・認証の期限・数値の検証）。

const SECRET = 'SECRET-RESPONSE-FRAGMENT'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const setup = (respond: () => Promise<Response> | Response = () => jsonResponse({})) => {
  const fetchFn = vi.fn<typeof fetch>(async () => respond())
  const client = createMapsClient({
    auth: createMapsAuth('test-project', async () => 'test-token'),
    fetchFn,
  })
  return { client, fetchFn }
}

const failureOf = async (promise: Promise<unknown>): Promise<MapsCallError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (!(error instanceof MapsCallError)) {
    throw new Error('MapsCallErrorで拒否されることを期待しました')
  }
  return error
}

describe('営業時間：空配列と欠落の区別', () => {
  const place = {
    id: 'ChIJ-sample-1',
    displayName: { text: '清水寺' },
    location: { latitude: 34.9949, longitude: 135.785 },
  }
  const hoursOf = async (regularOpeningHours?: unknown, include = true) => {
    const { client } = setup(() =>
      jsonResponse({
        places: [
          { ...place, ...(regularOpeningHours === undefined ? {} : { regularOpeningHours }) },
        ],
      }),
    )
    const result = await client.searchPlaces({ query: '清水寺', includeOpeningHours: include })
    return result.status === 'found' ? result.candidates[0].openingHours : undefined
  }

  it('periodsが空配列なら、欠落にせず、空の配列として保持する', async () => {
    expect(await hoursOf({ periods: [] })).toEqual({ status: 'available', periods: [] })
  })

  it('periodsが無い（regularOpeningHoursだけ・何も無い）なら、欠落（unavailable）', async () => {
    expect(await hoursOf({})).toEqual({ status: 'unavailable' })
    expect(await hoursOf(undefined)).toEqual({ status: 'unavailable' })
  })

  it('要求していなければ、空配列でも not_requested', async () => {
    expect(await hoursOf({ periods: [] }, false)).toEqual({ status: 'not_requested' })
  })
})

// 例外全体（メッセージ・stack・原因・追加の項目）を対象に、機密が残らないことを確かめる。
describe('例外に機密情報を保持しない', () => {
  const everythingOf = async (error: MapsCallError): Promise<string> => {
    const { inspect } = await import('node:util')
    return [
      error.message,
      error.stack ?? '',
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      inspect(error, { depth: 10, showHidden: true }),
    ].join('\n')
  }

  it('認証の例外：メッセージにトークンを含む例外でも、causeに保持しない', async () => {
    const client = createMapsClient({
      auth: createMapsAuth('p', async () => {
        throw new Error(`credential detail ${SECRET}`)
      }),
      fetchFn: vi.fn<typeof fetch>(),
    })
    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.cause).toBeUndefined()
    expect(await everythingOf(error)).not.toContain(SECRET)
  })

  it('応答がJSONでない：解析エラーの断片（応答の内容）を、causeに保持しない', async () => {
    const { client } = setup(() => new Response(`{"token": "${SECRET}", broken`, { status: 200 }))
    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.reason).toBe('invalid_response')
    expect(error.cause).toBeUndefined()
    expect(await everythingOf(error)).not.toContain(SECRET)
  })

  it('接続失敗・時間切れ：外部の例外を、causeに保持しない', async () => {
    for (const thrown of [
      new TypeError(`fetch failed ${SECRET}`),
      Object.assign(new Error(`aborted ${SECRET}`), { name: 'TimeoutError' }),
    ]) {
      const client = createMapsClient({
        auth: createMapsAuth('p', async () => 'tok'),
        fetchFn: vi.fn<typeof fetch>().mockRejectedValue(thrown),
      })
      const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

      expect(error.cause).toBeUndefined()
      expect(await everythingOf(error)).not.toContain(SECRET)
    }
  })

  it('HTTPエラー：エラー本文のメッセージを、どこにも保持しない（状態名だけ）', async () => {
    const { client } = setup(() =>
      jsonResponse({ error: { status: 'PERMISSION_DENIED', message: SECRET } }, 403),
    )
    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))

    expect(error.apiStatus).toBe('PERMISSION_DENIED')
    expect(await everythingOf(error)).not.toContain(SECRET)
  })
})

describe('認証の期限', () => {
  it('認証が期限内に終わらなければ timeout とし、Mapsを呼ばない', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const client = createMapsClient({
      auth: createMapsAuth('p', () => new Promise<string>(() => undefined)),
      fetchFn,
      timeoutMs: 30,
    })

    expect((await failureOf(client.searchPlaces({ query: '清水寺' }))).reason).toBe('timeout')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('期限のあとで、遅れて認証が完了しても、Mapsを呼ばない', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}))
    let finish: (token: string) => void = () => undefined
    const client = createMapsClient({
      auth: createMapsAuth('p', () => new Promise<string>((resolve) => (finish = resolve))),
      fetchFn,
      timeoutMs: 20,
    })

    const error = await failureOf(client.searchPlaces({ query: '清水寺' }))
    finish('late-token')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(error.reason).toBe('timeout')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('期限のあとで、認証が失敗しても、未処理の拒否を起こさない', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let fail: (error: Error) => void = () => undefined
      const client = createMapsClient({
        auth: createMapsAuth('p', () => new Promise<string>((_, reject) => (fail = reject))),
        fetchFn: vi.fn<typeof fetch>(),
        timeoutMs: 20,
      })
      await failureOf(
        client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' }),
      )
      fail(new Error('late failure'))
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('期限内に認証が終われば、通常どおり呼び出す', async () => {
    const { client, fetchFn } = setup()
    await client.searchPlaces({ query: '清水寺' })

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('外部APIの数値の検証', () => {
  const basePlace = { id: 'ChIJ-x', displayName: { text: '清水寺' } }

  it.each([
    [-90, -180, true],
    [90, 180, true],
    [90.0001, 0, false],
    [-90.0001, 0, false],
    [0, 180.0001, false],
    [0, -180.0001, false],
  ])('座標（緯度%d・経度%d）の範囲：受け入れ=%s', async (latitude, longitude, ok) => {
    const { client } = setup(() =>
      jsonResponse({ places: [{ ...basePlace, location: { latitude, longitude } }] }),
    )
    const run = client.searchPlaces({ query: '清水寺' })

    if (ok) expect((await run).status).toBe('found')
    else expect((await failureOf(run)).reason).toBe('invalid_response')
  })

  const routeWith = (route: unknown) => {
    const { client } = setup(() => jsonResponse({ routes: [route] }))
    return client.computeRoute({ originPlaceId: 'A', destinationPlaceId: 'B', mode: 'WALK' })
  }

  it('Infinityになる所要時間は、正常な結果にせず invalid_response', async () => {
    const huge = `${'9'.repeat(400)}s`
    expect((await failureOf(routeWith({ duration: huge }))).reason).toBe('invalid_response')
  })

  it('現実的な上限（7日）を超える所要時間は invalid_response。上限ちょうどは受け入れる', async () => {
    const limit = 7 * 24 * 60 * 60
    expect(await routeWith({ duration: `${limit}s` })).toMatchObject({
      status: 'found',
      durationSeconds: limit,
    })
    expect((await failureOf(routeWith({ duration: `${limit + 1}s` }))).reason).toBe(
      'invalid_response',
    )
  })

  it('範囲外の距離（負・小数・上限超過）は invalid_response。上限ちょうどは受け入れる', async () => {
    for (const distanceMeters of [-1, 1.5, 20_000_001]) {
      expect((await failureOf(routeWith({ duration: '60s', distanceMeters }))).reason).toBe(
        'invalid_response',
      )
    }
    expect(await routeWith({ duration: '60s', distanceMeters: 20_000_000 })).toMatchObject({
      status: 'found',
    })
  })
})
