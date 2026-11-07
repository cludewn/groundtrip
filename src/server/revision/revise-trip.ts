import {
  ReviseTripResponseSchema,
  TripSchema,
  type ConstraintCheck,
  type Evidence,
  type ProposalFailure,
  type ReviseTripRequest,
  type ReviseTripResponse,
  type Revision,
  type Stop,
  type Trip,
} from '../../domain'
import {
  GeminiCallError,
  type GeminiCallFailureReason,
  type GeminiJsonClient,
} from '../gemini/client'
import type { MapsClient } from '../maps'
import { normalizeName } from '../verification/name-match'
import { verifyTrip } from '../verification/verify-trip'
import { collectChecks, judgeCandidate, type CandidateJudgement } from './constraints'
import { buildRevisionResponseJsonSchema, RevisionDraftSchema } from './draft'
import { buildRevisionPrompt } from './prompt'

// 利用者の入力やAIの出力本文は含めない。原因の区分だけを記録する。
export type RevisionFailureEvent =
  | { kind: 'gemini_call'; reason: GeminiCallFailureReason; status?: number }
  | { kind: 'unexpected_client_error'; errorName: string }
  | { kind: 'invalid_output'; detail: string }

export interface ReviseDeps {
  client: GeminiJsonClient
  maps: Pick<MapsClient, 'searchPlaces' | 'computeRoute'>
  createId?: () => string
  now?: () => Date
  report?: (event: RevisionFailureEvent) => void
}

const GEMINI_FAILURE_MESSAGES: Record<GeminiCallFailureReason, string> = {
  not_configured: 'サーバーの設定が完了していないため、代替候補を作れません。',
  api_error:
    'AIによる代替候補の作成に接続できませんでした。時間をおいて、もう一度お試しください。元の旅程は、そのままです。',
  blocked: 'AIが入力内容を処理できませんでした。理由を見直して、もう一度お試しください。',
  incomplete: 'AIの処理が途中で終了しました。時間をおいて、もう一度お試しください。',
  empty_response: 'AIから候補が返されませんでした。時間をおいて、もう一度お試しください。',
}

const MAPS_FAILURE_MESSAGE =
  'Google Mapsとの通信に失敗したため、候補を確認できませんでした。時間をおいて、もう一度お試しください。元の旅程は、そのままです。'

const externalFailure = (message: string): ProposalFailure => ({
  status: 'external_service_error',
  message,
})

type Evaluation =
  | { kind: 'maps_failed' }
  | { kind: 'judged'; after: Stop; judgement: CandidateJudgement; travelAfter: Evidence | null }

// 候補（名称だけ差し替えた予定）を旅程へ入れた状態で、Places・Routesを使って照合し、制約を判定する。
// 開始時刻・滞在時間・種別・固定は、元の予定のまま。他の予定の時刻も動かさない。
// 承認・適用の直前の再検証にも使う（クライアントが返したconstraintCheckやevidenceは信用しない）。
export async function evaluateCandidate(
  trip: Trip,
  targetStopId: string,
  candidateName: string,
  deps: Pick<ReviseDeps, 'maps' | 'now'>,
): Promise<Evaluation> {
  const candidateTrip = TripSchema.parse({
    ...trip,
    stops: trip.stops.map((stop) =>
      stop.id === targetStopId
        ? { ...stop, name: candidateName, placeId: null, evidence: [] }
        : stop,
    ),
  })
  const result = await verifyTrip(candidateTrip, { maps: deps.maps, now: deps.now })
  if (result.status === 'external_service_error') return { kind: 'maps_failed' }

  const checks = collectChecks(result.trip, targetStopId)
  const after = result.trip.stops.find((stop) => stop.id === targetStopId)
  if (!after) return { kind: 'maps_failed' }
  return {
    kind: 'judged',
    after,
    judgement: judgeCandidate(checks),
    travelAfter: checks.travelAfter,
  }
}

// 適用の直前に、サーバー側で制約を再検証するための関数。`satisfied`と判定されたときだけ、適用できる。
export type RevisionRecheck =
  | { status: 'checked'; constraintCheck: ConstraintCheck; after: Stop }
  | { status: 'not_possible'; explanation: string }
  | { status: 'external_service_error'; message: string }

export async function checkRevisionConstraints(
  trip: Trip,
  revision: Pick<Revision, 'targetStopId' | 'diff'>,
  deps: Pick<ReviseDeps, 'maps' | 'now'>,
): Promise<RevisionRecheck> {
  const evaluation = await evaluateCandidate(
    trip,
    revision.targetStopId,
    revision.diff.after.name,
    deps,
  )
  if (evaluation.kind === 'maps_failed') {
    return { status: 'external_service_error', message: MAPS_FAILURE_MESSAGE }
  }
  if (evaluation.judgement.status === 'excluded') {
    return { status: 'not_possible', explanation: evaluation.judgement.explanation }
  }
  return {
    status: 'checked',
    constraintCheck: evaluation.judgement.constraintCheck,
    after: evaluation.after,
  }
}

function impactSummary(
  before: Stop,
  after: Stop,
  evaluation: { travelBefore: Evidence | null; travelAfter: Evidence | null },
  constraint: ConstraintCheck,
): string {
  const parts = [
    `「${before.name}」を「${after.name}」に差し替える候補です。開始時刻（${after.plannedStartTime}）と滞在時間（${after.durationMinutes}分）は変えません。`,
  ]
  if (evaluation.travelBefore)
    parts.push(`前の予定からの移動：${evaluation.travelBefore.explanation}`)
  if (evaluation.travelAfter) parts.push(`次の予定への移動：${evaluation.travelAfter.explanation}`)
  parts.push(constraint.explanation)
  return parts.join('')
}

const NO_CANDIDATES_AFTER_CHECK =
  '代替候補を作りましたが、施設を特定できない、または、営業時間・前後の移動の条件を満たさなかったため、提案できる候補がありません。理由や条件を変えて、もう一度お試しください。元の旅程は、そのままです。'

// 1地点の部分修正の候補（未承認のRevision）を作る。元のTripは更新しない。承認・保存・適用はしない。
// 旅行前（planning）と現地報告（on_site）で、同じ処理を使う。
export async function reviseTrip(
  request: ReviseTripRequest,
  deps: ReviseDeps,
): Promise<ReviseTripResponse> {
  const { client, maps, createId = () => crypto.randomUUID(), now, report } = deps
  const { trip, targetStopId } = request
  const target = trip.stops.find((stop) => stop.id === targetStopId)
  if (!target || target.isFixed) {
    // 契約の検証で弾かれるはずの入力。呼び出し側が検証を省いた場合の、最後の防波堤。
    return { status: 'no_candidates', message: '固定されていない予定を指定してください。' }
  }

  const { systemInstruction, prompt } = buildRevisionPrompt(request)
  let text: string
  try {
    // 課金対象のGemini呼び出しは1回だけ。失敗時の自動再試行はしない。
    text = await client.generateJson({
      systemInstruction,
      prompt,
      responseJsonSchema: buildRevisionResponseJsonSchema(),
    })
  } catch (error) {
    if (error instanceof GeminiCallError) {
      report?.({ kind: 'gemini_call', reason: error.reason, status: error.status })
      return externalFailure(GEMINI_FAILURE_MESSAGES[error.reason])
    }
    report?.({
      kind: 'unexpected_client_error',
      errorName: error instanceof Error ? error.name : typeof error,
    })
    return externalFailure(GEMINI_FAILURE_MESSAGES.api_error)
  }

  const invalidOutput = (detail: string): ProposalFailure => {
    report?.({ kind: 'invalid_output', detail })
    return {
      status: 'no_candidates',
      message:
        'AIの結果が条件を満たさなかったため、候補を作れませんでした。もう一度お試しください。',
    }
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return invalidOutput('JSONとして解釈できない')
  }
  const parsed = RevisionDraftSchema.safeParse(json)
  if (!parsed.success) return invalidOutput('下書きの形式が不正')
  const draft = parsed.data
  if (draft.failure) {
    return { status: draft.failure.status, message: `AIの回答: ${draft.failure.reason}` }
  }

  // 元の予定・他の予定・候補どうしと同じ名称は、差し替えの候補にならない。
  const taken = new Set(trip.stops.map((stop) => normalizeName(stop.name)))
  const candidates = draft.candidates.filter((candidate) => {
    const key = normalizeName(candidate.name)
    if (key.length === 0 || taken.has(key)) return false
    taken.add(key)
    return true
  })
  if (candidates.length === 0) return invalidOutput('有効な候補が無い')

  const evaluations = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      evaluation: await evaluateCandidate(trip, targetStopId, candidate.name, { maps, now }),
    })),
  )
  if (evaluations.every((item) => item.evaluation.kind === 'maps_failed')) {
    return externalFailure(MAPS_FAILURE_MESSAGE)
  }

  const revisions: Revision[] = []
  for (const { evaluation } of evaluations) {
    if (evaluation.kind !== 'judged' || evaluation.judgement.status !== 'candidate') continue
    const { after, judgement, travelAfter } = evaluation
    const travelBefore =
      after.evidence.find((item) => item.id === `evidence-${after.id}-travel`) ?? null
    // 次の予定への移動は、次の予定側の根拠として得られる。この候補の根拠として、別のIDで付ける。
    const nextEvidence: Evidence[] = travelAfter
      ? [
          {
            ...travelAfter,
            id: `evidence-${after.id}-travel-next`,
            claim: 'この予定の終了後、次の予定の開始時刻までに移動できる',
          },
        ]
      : []
    const afterWithEvidence: Stop = { ...after, evidence: [...after.evidence, ...nextEvidence] }
    revisions.push({
      id: `revision-${createId()}`,
      tripId: trip.id,
      baseTripVersion: trip.version,
      targetStopId,
      reason: request.reason,
      context: request.context,
      diff: { before: target, after: afterWithEvidence },
      impactSummary: impactSummary(
        target,
        afterWithEvidence,
        { travelBefore, travelAfter },
        judgement.constraintCheck,
      ),
      constraintCheck: judgement.constraintCheck,
      approval: { status: 'pending' },
    })
  }

  if (revisions.length === 0) return { status: 'no_candidates', message: NO_CANDIDATES_AFTER_CHECK }

  // 返却前に、共通契約で検証する。契約に反する結果を、呼び出し側へ流さない。
  const checked = ReviseTripResponseSchema.safeParse({ status: 'proposed', revisions })
  if (!checked.success) return invalidOutput('応答が共通契約に違反')
  return checked.data
}
