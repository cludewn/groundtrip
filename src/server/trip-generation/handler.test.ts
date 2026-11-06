import { afterEach, describe, expect, it, vi } from 'vitest'

import { GenerateTripResponseSchema, type GenerateTripResponse } from '../../domain'
import { sampleGenerateTripRequest, sampleTrip } from '../../domain/samples'
import { handleGenerateTripRequest, MAX_REQUEST_BYTES } from './handler'

afterEach(() => {
  vi.restoreAllMocks()
})

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/trips/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })

const postJson = (value: unknown) => post(JSON.stringify(value))

const handlerReturning = (response: GenerateTripResponse) => {
  const generate = vi.fn().mockResolvedValue(response)
  return { generate, deps: { generate } }
}

describe('POST /api/trips/generate: 正常系', () => {
  it('入力を検証し、生成結果を200とキャッシュ禁止ヘッダーで返す', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const response = await handleGenerateTripRequest(postJson(sampleGenerateTripRequest), deps)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.json()
    expect(GenerateTripResponseSchema.safeParse(body).success).toBe(true)
    expect(body.status).toBe('proposed')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0]).toEqual(sampleGenerateTripRequest)
  })

  it.each([
    ['no_candidates', 422],
    ['insufficient_information', 422],
    ['external_service_error', 502],
  ] as const)('失敗 %s はHTTP %i で共通契約の失敗ペイロードを返す', async (status, httpStatus) => {
    const { deps } = handlerReturning({ status, message: '失敗の説明' })
    const response = await handleGenerateTripRequest(postJson(sampleGenerateTripRequest), deps)

    expect(response.status).toBe(httpStatus)
    expect(await response.json()).toEqual({ status, message: '失敗の説明' })
  })

  it('Content-Typeにcharsetが付いていても受け付ける', async () => {
    const { deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const request = post(JSON.stringify(sampleGenerateTripRequest), {
      'Content-Type': 'application/json; charset=utf-8',
    })
    expect((await handleGenerateTripRequest(request, deps)).status).toBe(200)
  })
})

describe('POST /api/trips/generate: 入力の拒否（外部呼び出しをしない）', () => {
  it('JSON以外のContent-Typeは415', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const request = post(JSON.stringify(sampleGenerateTripRequest), {
      'Content-Type': 'text/plain',
    })
    const response = await handleGenerateTripRequest(request, deps)

    expect(response.status).toBe(415)
    expect((await response.json()).status).toBe('unsupported_media_type')
    expect(generate).not.toHaveBeenCalled()
  })

  it('JSONとして解釈できない本文は400', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const response = await handleGenerateTripRequest(post('{壊れたJSON'), deps)

    expect(response.status).toBe(400)
    expect((await response.json()).status).toBe('invalid_request')
    expect(generate).not.toHaveBeenCalled()
  })

  it('契約に違反する入力は400で、どの項目が不正かを返す', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const invalid = { ...sampleGenerateTripRequest, date: '2026/11/08', unknownKey: true }
    const response = await handleGenerateTripRequest(postJson(invalid), deps)

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.status).toBe('invalid_request')
    expect(body.issues.length).toBeGreaterThan(0)
    expect(generate).not.toHaveBeenCalled()
  })

  it('未承認の学びを含む入力は400（クライアントの自己申告を信用しない）', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const unapproved = {
      ...sampleGenerateTripRequest,
      learnings: [{ ...sampleGenerateTripRequest.learnings[0], approval: { status: 'pending' } }],
    }
    const response = await handleGenerateTripRequest(postJson(unapproved), deps)

    expect(response.status).toBe(400)
    expect(generate).not.toHaveBeenCalled()
  })

  it('空の本文は400', async () => {
    const { deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    expect((await handleGenerateTripRequest(post(''), deps)).status).toBe(400)
  })

  it('本文が上限を超える場合は413（ヘッダー申告が無くても本文の大きさで拒否する）', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const huge = { ...sampleGenerateTripRequest, preferences: ['あ'.repeat(MAX_REQUEST_BYTES)] }
    const response = await handleGenerateTripRequest(postJson(huge), deps)

    expect(response.status).toBe(413)
    expect((await response.json()).status).toBe('payload_too_large')
    expect(generate).not.toHaveBeenCalled()
  })

  it('Content-Lengthが上限を超える申告は本文を読まずに413', async () => {
    const { generate, deps } = handlerReturning({ status: 'proposed', trip: sampleTrip })
    const request = post(JSON.stringify(sampleGenerateTripRequest), {
      'Content-Length': String(MAX_REQUEST_BYTES + 1),
    })
    const response = await handleGenerateTripRequest(request, deps)

    expect(response.status).toBe(413)
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('POST /api/trips/generate: 想定外の失敗', () => {
  it('生成処理が例外を投げたら500とし、例外の内容を応答に含めない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const generate = vi.fn().mockRejectedValue(new Error('Bearer dummy-secret-value'))
    const response = await handleGenerateTripRequest(postJson(sampleGenerateTripRequest), {
      generate,
    })

    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).toContain('internal_error')
    expect(text).not.toContain('dummy-secret-value')
  })

  it('生成処理の応答が共通契約に違反していたら500とし、クライアントへ流さない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // 型としては通るが、3〜4地点という契約に違反する応答。
    const broken: GenerateTripResponse = {
      status: 'proposed',
      trip: { ...sampleTrip, stops: sampleTrip.stops.slice(0, 2) },
    }
    const { deps } = handlerReturning(broken)
    const response = await handleGenerateTripRequest(postJson(sampleGenerateTripRequest), deps)

    expect(response.status).toBe(500)
    expect((await response.json()).status).toBe('internal_error')
  })
})
