import { TripSchema, type Evidence, type Stop, type Trip } from '../../domain'
import { MapsCallError, type MapsClient, type PlaceCandidate } from '../maps'
import { selectPlace, type PlaceSelection } from './name-match'
import { checkOpeningHours } from './opening-hours'
import { availableMinutes, evaluateTravel, formatMinutes } from './travel'

// 旅程の各予定を、Google Maps Platform（Places・Routes）の情報と照合し、根拠（Evidence）を付ける。
// - AIの提案（生成）と、照合は別の責務。ここでは、提案された予定を変更せず、根拠だけを付ける。
// - 結果は「情報源と整合」「矛盾あり」「確認できない」の3状態。整合は、現実の正しさの保証ではない。
// - 施設の存在（place_identity）、対象日の営業時間（opening_hours）、前の予定からの移動（travel_time）は別の根拠。
// - 呼び出しの失敗・候補なし・名称の不一致は、いずれも「確認できない」とし、推測で埋めない。
// - 保存してよいのはPlace IDだけ。Placesの名称・営業時間・Routesの所要時間は、ここで使うだけで保存しない。
//   また、Places・Routes由来の事実（名称・営業時間・所要時間の値）は、根拠の説明文に載せない
//   （Googleマップ以外の画面に出すときの帰属表示の条件を、満たす前に値を表示しないため）。

const SOURCE_LABEL_PLACES = 'Google Maps Platform（Places API）'
const SOURCE_LABEL_ROUTES = 'Google Maps Platform（Routes API）'
const TIME_ZONE_LABEL = 'Asia/Tokyo'

export interface VerifyDeps {
  maps: Pick<MapsClient, 'searchPlaces' | 'computeRoute'>
  now?: () => Date
}

export type VerifyTripResult =
  | { status: 'verified'; trip: Trip; calls: { places: number; routes: number } }
  // 全ての予定で、Mapsの呼び出し自体が失敗した（設定・認証・接続の失敗）。根拠は付けない。
  | { status: 'external_service_error'; message: string }

type PlaceLookup =
  | { kind: 'selected'; selection: PlaceSelection }
  | { kind: 'failed'; reason: MapsCallError['reason'] }

const stopApplicability = (trip: Trip, stop: Stop) =>
  `${trip.date} ${stop.plannedStartTime}（${trip.timeZone === 'Asia/Tokyo' ? TIME_ZONE_LABEL : trip.timeZone}）`

function evidence(
  stop: Stop,
  suffix: string,
  fields: Omit<Evidence, 'id' | 'checkedAt'>,
  checkedAt: string,
): Evidence {
  return { id: `evidence-${stop.id}-${suffix}`, checkedAt, ...fields }
}

function identityEvidence(
  trip: Trip,
  stop: Stop,
  lookup: PlaceLookup,
  checkedAt: string,
): Evidence {
  const base = {
    subject: 'place_identity' as const,
    claim: `「${stop.name}」が、Google Maps上の施設として特定できる`,
    applicability: '施設の存在のみ（対象日の営業は、別の項目）',
    source: { kind: 'places' as const, label: SOURCE_LABEL_PLACES },
  }
  if (lookup.kind === 'failed') {
    return evidence(
      stop,
      'place',
      {
        ...base,
        status: 'unverifiable',
        explanation:
          '施設の検索に失敗したため、確認できません。時間をおいて、もう一度お試しください。',
      },
      checkedAt,
    )
  }
  const { selection } = lookup
  switch (selection.status) {
    case 'matched':
      return evidence(
        stop,
        'place',
        {
          ...base,
          status: 'consistent',
          explanation:
            '名称が一致する施設を、Google Mapsで見つけました。実在や、当日の営業を保証するものではありません。',
        },
        checkedAt,
      )
    case 'ambiguous':
      return evidence(
        stop,
        'place',
        {
          ...base,
          status: 'unverifiable',
          explanation: `名称が一致する候補が${selection.count}件あり、1つに絞れないため、確認できません。`,
        },
        checkedAt,
      )
    case 'mismatch':
      return evidence(
        stop,
        'place',
        {
          ...base,
          status: 'unverifiable',
          explanation:
            '検索で見つかった施設の名称が、予定の名称と一致しないため、同じ施設と判断できず、確認できません。',
        },
        checkedAt,
      )
    case 'no_candidates':
      return evidence(
        stop,
        'place',
        {
          ...base,
          status: 'unverifiable',
          explanation: 'Google Mapsで、該当する施設を見つけられなかったため、確認できません。',
        },
        checkedAt,
      )
  }
}

function hoursEvidence(
  trip: Trip,
  stop: Stop,
  place: PlaceCandidate | null,
  checkedAt: string,
): Evidence {
  const base = {
    subject: 'opening_hours' as const,
    claim: `${trip.date}の${stop.plannedStartTime}から${stop.durationMinutes}分、営業している`,
    applicability: `${stopApplicability(trip, stop)}の通常営業時間`,
    source: { kind: 'places' as const, label: SOURCE_LABEL_PLACES },
  }
  if (!place) {
    return evidence(
      stop,
      'hours',
      {
        ...base,
        status: 'unverifiable',
        explanation: '施設を特定できていないため、営業時間を確認できません。',
      },
      checkedAt,
    )
  }
  if (place.openingHours.status !== 'available') {
    return evidence(
      stop,
      'hours',
      {
        ...base,
        status: 'unverifiable',
        explanation: '営業時間のデータが取得できないため、確認できません。',
      },
      checkedAt,
    )
  }
  const result = checkOpeningHours(
    place.openingHours.periods,
    trip.date,
    stop.plannedStartTime,
    stop.durationMinutes,
  )
  return evidence(
    stop,
    'hours',
    { ...base, status: result.status, explanation: result.explanation },
    checkedAt,
  )
}

async function lookupPlace(
  maps: VerifyDeps['maps'],
  trip: Trip,
  stop: Stop,
): Promise<{ lookup: PlaceLookup; place: PlaceCandidate | null }> {
  try {
    const result = await maps.searchPlaces({
      query: `${stop.name} ${trip.region}`,
      maxResultCount: 3,
      includeOpeningHours: true,
    })
    const selection = selectPlace(stop.name, result.status === 'found' ? result.candidates : [])
    return {
      lookup: { kind: 'selected', selection },
      place: selection.status === 'matched' ? selection.place : null,
    }
  } catch (error) {
    return {
      lookup: { kind: 'failed', reason: error instanceof MapsCallError ? error.reason : 'network' },
      place: null,
    }
  }
}

// 前の予定から、この予定へ間に合うかの根拠。徒歩で間に合えば徒歩、間に合わなければ車でも確認する。
async function travelEvidence(
  maps: VerifyDeps['maps'],
  trip: Trip,
  previous: Stop,
  stop: Stop,
  previousPlaceId: string | null,
  placeId: string | null,
  checkedAt: string,
  counter: { routes: number },
): Promise<Evidence> {
  const available = availableMinutes({ previous, next: stop })
  const prevEnd = formatMinutes(
    Number(previous.plannedStartTime.slice(0, 2)) * 60 +
      Number(previous.plannedStartTime.slice(3)) +
      previous.durationMinutes,
  )
  const base = {
    subject: 'travel_time' as const,
    claim: '前の予定の終了後、この予定の開始時刻までに移動できる',
    applicability: `${trip.date} ${prevEnd}〜${stop.plannedStartTime}（使える時間${available}分）`,
    source: { kind: 'routes' as const, label: SOURCE_LABEL_ROUTES },
  }
  const unverifiable = (explanation: string) =>
    evidence(stop, 'travel', { ...base, status: 'unverifiable', explanation }, checkedAt)

  if (available < 0) {
    // 時刻がすでに重なっている。移動時間を調べるまでもなく、成立しない。
    return evidence(
      stop,
      'travel',
      {
        ...base,
        status: 'conflicting',
        explanation: '前の予定の終了時刻が、この予定の開始時刻より後で、時刻が重なっています。',
      },
      checkedAt,
    )
  }
  if (!previousPlaceId || !placeId) {
    return unverifiable('前後の施設を特定できていないため、移動時間を確認できません。')
  }

  try {
    counter.routes += 1
    const walk = await maps.computeRoute({
      originPlaceId: previousPlaceId,
      destinationPlaceId: placeId,
      mode: 'WALK',
    })
    if (walk.status === 'found' && evaluateTravel(available, walk.minutes).status === 'fits') {
      const { slackMinutes } = evaluateTravel(available, walk.minutes)
      return evidence(
        stop,
        'travel',
        {
          ...base,
          status: 'consistent',
          explanation: `徒歩で間に合う見込みです（余裕${slackMinutes}分）。渋滞・遅延は考慮していません。`,
        },
        checkedAt,
      )
    }
    counter.routes += 1
    const drive = await maps.computeRoute({
      originPlaceId: previousPlaceId,
      destinationPlaceId: placeId,
      mode: 'DRIVE',
    })
    if (drive.status === 'found') {
      const fit = evaluateTravel(available, drive.minutes)
      const walkNote =
        walk.status === 'found' ? '徒歩では間に合いません。' : '徒歩の経路を確認できません。'
      return evidence(
        stop,
        'travel',
        {
          ...base,
          status: fit.status === 'fits' ? 'consistent' : 'conflicting',
          explanation:
            fit.status === 'fits'
              ? `${walkNote}車なら間に合う見込みです（余裕${fit.slackMinutes}分）。渋滞・遅延は考慮していません。`
              : `${walkNote}車でも間に合いません（${-fit.slackMinutes}分不足）。`,
        },
        checkedAt,
      )
    }
    return unverifiable(
      '徒歩・車の経路を確認できないため、移動時間を確認できません（公共交通は未対応です）。',
    )
  } catch {
    return unverifiable('移動時間の取得に失敗したため、確認できません。')
  }
}

export async function verifyTrip(input: Trip, deps: VerifyDeps): Promise<VerifyTripResult> {
  const { maps, now = () => new Date() } = deps
  const checkedAt = now().toISOString()
  const counter = { places: 0, routes: 0 }

  // 予定ごとの施設検索（最大4件）。並行して呼ぶ。
  const lookups = await Promise.all(
    input.stops.map(async (stop) => {
      counter.places += 1
      return lookupPlace(maps, input, stop)
    }),
  )

  if (lookups.every((item) => item.lookup.kind === 'failed')) {
    return {
      status: 'external_service_error',
      message:
        'Google Mapsとの通信に失敗したため、根拠を照合できませんでした。時間をおいて、もう一度お試しください。',
    }
  }

  const travel = await Promise.all(
    input.stops.map((stop, index) =>
      index === 0
        ? Promise.resolve(null)
        : travelEvidence(
            maps,
            input,
            input.stops[index - 1],
            stop,
            lookups[index - 1].place?.placeId ?? null,
            lookups[index].place?.placeId ?? null,
            checkedAt,
            counter,
          ),
    ),
  )

  const stops = input.stops.map((stop, index): Stop => {
    const { lookup, place } = lookups[index]
    const items = [
      identityEvidence(input, stop, lookup, checkedAt),
      hoursEvidence(input, stop, place, checkedAt),
      ...(travel[index] ? [travel[index]] : []),
    ]
    // 入力のPlace IDと根拠は、クライアントの自己申告として破棄し、今回の照合結果だけにする。
    // Place IDは、名称が一致した施設だけに付ける（保存してよい唯一のMaps由来の値）。
    return { ...stop, placeId: place?.placeId ?? null, evidence: items }
  })

  // 予定の内容（名称・時刻・滞在・固定）は変えず、根拠とPlace IDだけを付けた旅程を、契約で検証して返す。
  const verified = TripSchema.parse({ ...input, stops })
  return { status: 'verified', trip: verified, calls: counter }
}
