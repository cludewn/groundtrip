import {
  GenerateTripRequestSchema,
  GenerateTripResponseSchema,
  type GenerateTripRequest,
  type GenerateTripResponse,
} from '../../domain'

// POST /api/trips/generate のHTTP処理。Route Handlerは薄く保ち、検証とステータスの対応は
// ここでテストできるようにする。認証・レート制限は未実装（認証は#10の範囲）。
// 課金を伴う外部呼び出しの入口なので、公開前にアクセス制限の方針を決める必要がある。

// 旅行条件として十分大きい上限。巨大な入力でプロンプトの費用が膨らむのを防ぐ。
export const MAX_REQUEST_BYTES = 32 * 1024

export interface GenerateTripHandlerDeps {
  generate: (request: GenerateTripRequest) => Promise<GenerateTripResponse>
}

// 共通契約（GenerateTripResponse）に含まれない、API層だけのエラー。
export type ApiErrorStatus =
  'invalid_request' | 'unsupported_media_type' | 'payload_too_large' | 'internal_error'

export interface ApiErrorBody {
  status: ApiErrorStatus
  message: string
  issues?: { path: string; message: string }[]
}

const HEADERS = { 'Cache-Control': 'no-store' }

const errorResponse = (httpStatus: number, body: ApiErrorBody): Response =>
  Response.json(body, { status: httpStatus, headers: HEADERS })

const HTTP_STATUS_BY_FAILURE = {
  no_candidates: 422,
  insufficient_information: 422,
  external_service_error: 502,
} as const

export async function handleGenerateTripRequest(
  request: Request,
  deps: GenerateTripHandlerDeps,
): Promise<Response> {
  // 単純なフォーム送信など、JSON以外の形式で外部呼び出しを起こされないようにする。
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, {
      status: 'unsupported_media_type',
      message: 'Content-Typeにapplication/jsonを指定してください。',
    })
  }

  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return errorResponse(413, {
      status: 'payload_too_large',
      message: '旅行条件のデータが大きすぎます。',
    })
  }

  const rawBody = await request.text()
  if (new TextEncoder().encode(rawBody).length > MAX_REQUEST_BYTES) {
    return errorResponse(413, {
      status: 'payload_too_large',
      message: '旅行条件のデータが大きすぎます。',
    })
  }

  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return errorResponse(400, {
      status: 'invalid_request',
      message: 'リクエストをJSONとして解釈できません。',
    })
  }

  const parsedRequest = GenerateTripRequestSchema.safeParse(json)
  if (!parsedRequest.success) {
    return errorResponse(400, {
      status: 'invalid_request',
      message: '旅行条件の形式が正しくありません。',
      issues: parsedRequest.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
  }

  let result: GenerateTripResponse
  try {
    result = await deps.generate(parsedRequest.data)
  } catch (error) {
    console.error('[trip-generation] 想定外のエラー', error instanceof Error ? error.name : error)
    return errorResponse(500, {
      status: 'internal_error',
      message: '旅程の生成中に予期しないエラーが発生しました。',
    })
  }

  // 返却前にも共通契約で検証し、契約に反する応答をクライアントへ流さない。
  const parsedResponse = GenerateTripResponseSchema.safeParse(result)
  if (!parsedResponse.success) {
    console.error('[trip-generation] 応答が共通契約に違反')
    return errorResponse(500, {
      status: 'internal_error',
      message: '旅程の生成中に予期しないエラーが発生しました。',
    })
  }

  const body = parsedResponse.data
  const httpStatus = body.status === 'proposed' ? 200 : HTTP_STATUS_BY_FAILURE[body.status]
  return Response.json(body, { status: httpStatus, headers: HEADERS })
}
