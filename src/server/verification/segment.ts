import type { Evidence, TravelSegment } from '../../domain'
import type { MapsClient } from '../maps'
import { evaluateTravel } from './travel'

// 前後の予定の間の移動を、Routesで測り、構造化された移動区間（TravelSegment）と、間に合うかの判定を返す。
// 説明文（Evidence.explanation）から数値を取り出さず、この構造化された結果を、比較・判定の根拠にする。
//
// 移動手段：利用者が使える手段だけを確認する。既定は徒歩だけ（車を使えるとは限らないため）。
// 車は、利用者が使えると明示したとき（modesに含めたとき）だけ、確認する。公共交通は、現段階では未対応。
// 呼び出しは、手段ごとに最大1回。徒歩で間に合えば、車は調べない（呼び出しを節約）。

export type TravelModeSetting = 'walk' | 'drive'
export const DEFAULT_TRAVEL_MODES: readonly TravelModeSetting[] = ['walk']

const ROUTES_MODE = { walk: 'WALK', drive: 'DRIVE' } as const
const MODE_LABEL = { walk: '徒歩', drive: '車' } as const
const SOURCE_LABEL_ROUTES = 'Google Maps Platform（Routes API）'

// 並びを正規化する（重複を除き、徒歩・車の順）。空なら既定（徒歩）。
export function normalizeModes(modes: readonly TravelModeSetting[] | undefined) {
  const set = new Set(modes ?? DEFAULT_TRAVEL_MODES)
  const ordered = (['walk', 'drive'] as const).filter((mode) => set.has(mode))
  return ordered.length > 0 ? ordered : [...DEFAULT_TRAVEL_MODES]
}

export type SegmentFit =
  // 利用者が使える手段のどれかで、間に合う
  | { status: 'fits'; slackMinutes: number }
  // 確認できた手段では、どれでも間に合わない
  | { status: 'too_long'; shortageMinutes: number }
  // 確認できていない（施設を特定できない・経路なし・API失敗・時刻の重なり）
  | { status: 'unknown' }

export interface SegmentMeasurement {
  segment: TravelSegment
  fit: SegmentFit
  // 確認の対象にした手段（説明文用）
  modes: readonly TravelModeSetting[]
}

export interface MeasureSegmentInput {
  fromStopId: string
  toStopId: string
  fromPlaceId: string | null
  toPlaceId: string | null
  // 前の予定の終了から、次の予定の開始までの時間（分）。負なら、時刻が重なっている。
  availableMinutes: number
  modes: readonly TravelModeSetting[]
  checkedAt: string
  // 呼び出し回数の集計（課金の確認用）
  counter?: { routes: number }
}

type Probe =
  | { mode: TravelModeSetting; status: 'found'; minutes: number; distanceMeters?: number }
  | { mode: TravelModeSetting; status: 'no_route' }
  | { mode: TravelModeSetting; status: 'error' }

export async function measureSegment(
  maps: Pick<MapsClient, 'computeRoute'>,
  input: MeasureSegmentInput,
): Promise<SegmentMeasurement> {
  const { fromStopId, toStopId, fromPlaceId, toPlaceId, availableMinutes, checkedAt } = input
  const modes = normalizeModes(input.modes)
  const ends = { fromStopId, toStopId }

  const unknown = (
    reason: 'not_queried' | 'no_route' | 'api_error',
    explanation: string,
  ): SegmentMeasurement => ({
    segment: {
      ...ends,
      status: 'unknown',
      mode: modes[0],
      reason,
      // 実際に照会を試みた場合だけ、照合時刻を持つ。
      ...(reason === 'not_queried' ? {} : { checkedAt }),
      explanation,
    },
    fit: { status: 'unknown' },
    modes,
  })

  if (availableMinutes < 0) {
    // 時刻がすでに重なっている。移動時間を調べるまでもなく成立しないため、Routesは呼ばない。
    return {
      ...unknown(
        'not_queried',
        '前の予定の終了時刻が、次の予定の開始時刻より後で、時刻が重なっています。',
      ),
      fit: { status: 'too_long', shortageMinutes: -availableMinutes },
    }
  }
  if (!fromPlaceId || !toPlaceId) {
    return unknown('not_queried', '前後の施設を特定できていないため、移動時間を確認できません。')
  }

  const probes: Probe[] = []
  for (const mode of modes) {
    try {
      if (input.counter) input.counter.routes += 1
      const route = await maps.computeRoute({
        originPlaceId: fromPlaceId,
        destinationPlaceId: toPlaceId,
        mode: ROUTES_MODE[mode],
      })
      probes.push(
        route.status === 'found'
          ? { mode, status: 'found', minutes: route.minutes, distanceMeters: route.distanceMeters }
          : { mode, status: 'no_route' },
      )
      // 間に合う手段が見つかったら、残りの手段は調べない。
      if (
        route.status === 'found' &&
        evaluateTravel(availableMinutes, route.minutes).status === 'fits'
      ) {
        break
      }
    } catch {
      probes.push({ mode, status: 'error' })
    }
  }

  const found = probes.filter(
    (probe): probe is Extract<Probe, { status: 'found' }> => probe.status === 'found',
  )
  if (found.length === 0) {
    return probes.some((probe) => probe.status === 'error')
      ? unknown('api_error', '移動時間の取得に失敗したため、確認できません。')
      : unknown(
          'no_route',
          `${modes.map((mode) => MODE_LABEL[mode]).join('・')}の経路を確認できないため、移動時間を確認できません（公共交通は未対応です）。`,
        )
  }

  // 間に合う手段があれば、その手段。なければ、確認できた中で最も速い手段を、比較の値として示す。
  const fitting = found.find(
    (probe) => evaluateTravel(availableMinutes, probe.minutes).status === 'fits',
  )
  const chosen =
    fitting ?? found.reduce((best, probe) => (probe.minutes < best.minutes ? probe : best))
  const fit = evaluateTravel(availableMinutes, chosen.minutes)
  const label = MODE_LABEL[chosen.mode]

  return {
    segment: {
      ...ends,
      status: 'known',
      mode: chosen.mode,
      durationMinutes: chosen.minutes,
      ...(chosen.distanceMeters === undefined ? {} : { distanceMeters: chosen.distanceMeters }),
      source: { kind: 'routes', label: SOURCE_LABEL_ROUTES },
      checkedAt,
      explanation: `${label}で約${chosen.minutes}分`,
    },
    fit:
      fit.status === 'fits'
        ? { status: 'fits', slackMinutes: fit.slackMinutes }
        : { status: 'too_long', shortageMinutes: -fit.slackMinutes },
    modes,
  }
}

const modesNote = (modes: readonly TravelModeSetting[]): string =>
  modes.includes('drive')
    ? '公共交通は確認できません。'
    : '車・公共交通は、利用できるか分からないため、確認していません。'

// 根拠（Evidence）の説明文。Routesの所要時間そのものではなく、計画上の余裕から導いた結果だけを載せる。
export function segmentEvidenceFields(
  measurement: SegmentMeasurement,
  base: { claim: string; applicability: string },
): Pick<Evidence, 'subject' | 'claim' | 'applicability' | 'source' | 'status' | 'explanation'> {
  const common = {
    subject: 'travel_time' as const,
    ...base,
    source: { kind: 'routes' as const, label: SOURCE_LABEL_ROUTES },
  }
  const { segment, fit, modes } = measurement
  if (fit.status === 'fits' && segment.status === 'known') {
    return {
      ...common,
      status: 'consistent',
      explanation: `${MODE_LABEL[segment.mode]}で間に合う見込みです（余裕${fit.slackMinutes}分）。渋滞・遅延は考慮していません。`,
    }
  }
  if (fit.status === 'too_long') {
    if (segment.status === 'known') {
      return {
        ...common,
        status: 'conflicting',
        explanation: `${MODE_LABEL[segment.mode]}では間に合いません（${fit.shortageMinutes}分不足）。${modesNote(modes)}`,
      }
    }
    return { ...common, status: 'conflicting', explanation: segment.explanation }
  }
  return { ...common, status: 'unverifiable', explanation: segment.explanation }
}
