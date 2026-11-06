import { ApiError, BlockedReason, FinishReason, GenerateContentResponse } from '@google/genai'
import { describe, expect, it, vi } from 'vitest'

import {
  createGeminiJsonClient,
  createLazyVertexGeminiClient,
  DEFAULT_GEMINI_LOCATION,
  DEFAULT_GEMINI_MODEL,
  GeminiCallError,
  loadGeminiConfig,
  type GenerateContentFn,
} from './client'

const responseOf = (init: Partial<GenerateContentResponse>) =>
  Object.assign(new GenerateContentResponse(), init)

const completed = (text: string, finishReason: FinishReason = FinishReason.STOP) =>
  responseOf({
    candidates: [{ finishReason, content: { role: 'model', parts: [{ text }] } }],
  })

const request = {
  systemInstruction: 'システム指示',
  prompt: 'プロンプト',
  responseJsonSchema: { type: 'object' },
}

const clientWith = (generateContent: GenerateContentFn) =>
  createGeminiJsonClient({ model: 'test-model' }, generateContent)

const failureOf = async (client: ReturnType<typeof clientWith>): Promise<GeminiCallError> => {
  const error = await client.generateJson(request).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (!(error instanceof GeminiCallError)) {
    throw new Error('GeminiCallErrorで拒否されることを期待しました')
  }
  return error
}

describe('createGeminiJsonClient', () => {
  it('JSON出力・スキーマ・システム指示を指定して1回だけ呼び、生成されたJSON文字列を返す', async () => {
    const generateContent = vi.fn<GenerateContentFn>().mockResolvedValue(completed(' {"a":1} '))
    const text = await clientWith(generateContent).generateJson(request)

    expect(text).toBe('{"a":1}')
    expect(generateContent).toHaveBeenCalledTimes(1)
    expect(generateContent.mock.calls[0][0]).toMatchObject({
      model: 'test-model',
      contents: 'プロンプト',
      config: {
        systemInstruction: 'システム指示',
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        candidateCount: 1,
      },
    })
  })

  it('API呼び出しの失敗は api_error とし、HTTPステータスだけを保持する', async () => {
    const apiError = new ApiError({ message: '秘密を含みうる本文', status: 503 })
    const error = await failureOf(clientWith(vi.fn().mockRejectedValue(apiError)))

    expect(error.reason).toBe('api_error')
    expect(error.status).toBe(503)
    expect(error.message).not.toContain('秘密')
    expect(error.cause).toBe(apiError)
  })

  it('ネットワーク断などの一般的な例外も api_error として扱う', async () => {
    const error = await failureOf(clientWith(vi.fn().mockRejectedValue(new Error('ECONNRESET'))))

    expect(error.reason).toBe('api_error')
    expect(error.status).toBeUndefined()
  })

  it('入力が安全性判定で拒否された場合は blocked', async () => {
    const response = responseOf({ promptFeedback: { blockReason: BlockedReason.SAFETY } })
    const error = await failureOf(clientWith(vi.fn().mockResolvedValue(response)))

    expect(error.reason).toBe('blocked')
  })

  it('候補が無い応答は empty_response', async () => {
    const error = await failureOf(clientWith(vi.fn().mockResolvedValue(responseOf({}))))

    expect(error.reason).toBe('empty_response')
  })

  it.each([FinishReason.MAX_TOKENS, FinishReason.SAFETY])(
    '生成が %s で終了した応答は、壊れたJSONの可能性があるため使わない（incomplete）',
    async (finishReason) => {
      const error = await failureOf(
        clientWith(vi.fn().mockResolvedValue(completed('{"a":', finishReason))),
      )

      expect(error.reason).toBe('incomplete')
    },
  )

  it('本文が空または空白だけの応答は empty_response', async () => {
    const error = await failureOf(clientWith(vi.fn().mockResolvedValue(completed('   '))))

    expect(error.reason).toBe('empty_response')
  })
})

describe('loadGeminiConfig', () => {
  it('プロジェクトIDだけ設定すれば、既定のロケーション・モデルを使う', () => {
    expect(loadGeminiConfig({ GOOGLE_CLOUD_PROJECT: 'my-project' })).toEqual({
      project: 'my-project',
      location: DEFAULT_GEMINI_LOCATION,
      model: DEFAULT_GEMINI_MODEL,
    })
  })

  it('ロケーションとモデルを環境変数で切り替えられる（前後の空白は無視する）', () => {
    expect(
      loadGeminiConfig({
        GOOGLE_CLOUD_PROJECT: ' my-project ',
        GOOGLE_CLOUD_LOCATION: ' us-central1 ',
        GEMINI_MODEL: ' gemini-x ',
      }),
    ).toEqual({ project: 'my-project', location: 'us-central1', model: 'gemini-x' })
  })

  it.each([{}, { GOOGLE_CLOUD_PROJECT: '' }, { GOOGLE_CLOUD_PROJECT: '   ' }])(
    'プロジェクトIDが未設定なら not_configured（%j）',
    (env) => {
      let thrown: unknown
      try {
        loadGeminiConfig(env)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(GeminiCallError)
      expect(thrown).toMatchObject({ reason: 'not_configured' })
    },
  )
})

describe('createLazyVertexGeminiClient', () => {
  it('設定が無くても作成でき、呼び出し時に not_configured として拒否する', async () => {
    const client = createLazyVertexGeminiClient({})

    const error = await failureOf(client)
    expect(error.reason).toBe('not_configured')
  })
})
