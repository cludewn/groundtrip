import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleRevision, sampleReviseTripRequest } from '@/domain/samples'

import { readRevisionProposal, requestRevisions, type RevisionProposal } from './api-client'

afterEach(() => vi.unstubAllGlobals())

const request = { ...sampleReviseTripRequest, travelModes: ['walk'] as const }
const input = { ...request, travelModes: [...request.travelModes] }
const signal = new AbortController().signal

describe('候補生成 API の表示境界', () => {
  it('PR #28 の構造化比較を受け取り、対応する区間を検証する', async () => {
    const [first, target, next] = input.trip.stops
    const fromPrevious = {
      presence: 'segment',
      segment: {
        fromStopId: first.id,
        toStopId: target.id,
        status: 'unknown',
        mode: 'walk',
        reason: 'not_queried',
        explanation: '出発地点が未同定',
      },
    } as const
    const toNext = {
      presence: 'segment',
      segment: {
        fromStopId: target.id,
        toStopId: next.id,
        status: 'known',
        mode: 'walk',
        durationMinutes: 0,
        source: { kind: 'routes', label: 'Google Routes' },
        checkedAt: '2026-11-08T11:46:00+09:00',
        explanation: '構造化数値を使用',
      },
    } as const
    const proposal: RevisionProposal = {
      status: 'proposed',
      revisions: [sampleRevision],
      comparisons: [
        {
          revisionId: sampleRevision.id,
          before: { fromPrevious, toNext },
          after: { fromPrevious, toNext },
        },
      ],
    }
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(proposal))
    vi.stubGlobal('fetch', fetchFn)

    const result = await requestRevisions(input, signal)
    expect(fetchFn).toHaveBeenCalledWith('/api/trips/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    })
    expect(result).toEqual(proposal)
    expect(readRevisionProposal(proposal, input)).toEqual(proposal)
    expect(
      readRevisionProposal(
        { ...proposal, revisions: [{ ...sampleRevision, baseTripVersion: 1 }] },
        input,
      ),
    ).toBeNull()
    expect(
      readRevisionProposal(
        {
          ...proposal,
          comparisons: [
            {
              revisionId: sampleRevision.id,
              before: { fromPrevious, toNext },
              after: {
                fromPrevious,
                toNext: { ...toNext, segment: { ...toNext.segment, toStopId: first.id } },
              },
            },
          ],
        },
        input,
      ),
    ).toBeNull()
  })

  it.each([
    ['not_queried', '2026-11-08T11:46:00+09:00'],
    ['transit_unsupported', '2026-11-08T11:46:00+09:00'],
    ['api_error', undefined],
    ['no_route', undefined],
  ] as const)('経路未確認の理由 %s と照合時刻が矛盾すれば拒否する', (reason, checkedAt) => {
    const [first, target] = input.trip.stops
    const slots = {
      fromPrevious: {
        presence: 'segment',
        segment: {
          status: 'unknown',
          reason,
          checkedAt,
          fromStopId: first.id,
          toStopId: target.id,
          mode: reason === 'transit_unsupported' ? 'transit' : 'walk',
          explanation: '未確認の区間',
        },
      },
      toNext: {
        presence: 'segment',
        segment: {
          status: 'unknown',
          reason: 'not_queried',
          fromStopId: target.id,
          toStopId: input.trip.stops[2].id,
          mode: 'walk',
          explanation: '未照会',
        },
      },
    } as const
    expect(
      readRevisionProposal(
        {
          status: 'proposed',
          revisions: [sampleRevision],
          comparisons: [{ revisionId: sampleRevision.id, before: slots, after: slots }],
        },
        input,
      ),
    ).toBeNull()
  })

  it.each([
    [404, null, 'unavailable'],
    [503, null, 'unavailable'],
    [409, null, 'conflict'],
    [422, { status: 'no_candidates', message: '候補なし' }, 'no_candidates'],
    [422, { status: 'insufficient_information', message: '情報不足' }, 'insufficient_information'],
    [
      502,
      { status: 'external_service_error', message: '外部サービス失敗' },
      'external_service_error',
    ],
    [
      200,
      { status: 'proposed', revisions: [sampleRevision], comparisons: [{ revisionId: 123 }] },
      'unexpected',
    ],
    [502, { status: 'no_candidates', message: 'HTTPと本文の不一致' }, 'unexpected'],
  ] as const)('HTTP %s と本文 %j を %s として扱う', async (http, body, status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: http })),
    )
    expect((await requestRevisions(input, signal)).status).toBe(status)
  })

  it('本文受信中の切断は通信中断として扱う', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error('network'))
      },
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)))
    expect(await requestRevisions(input, signal)).toEqual({ status: 'interrupted' })
  })
})
