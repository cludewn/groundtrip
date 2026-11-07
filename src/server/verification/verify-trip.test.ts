import { describe, expect, it, vi } from 'vitest'

import { TripSchema, type Evidence, type Trip } from '../../domain'
import { sampleTrip } from '../../domain/samples'
import {
  MapsCallError,
  type OpeningPeriod,
  type PlaceSearchResult,
  type RouteOptions,
  type RouteResult,
} from '../maps'
import { verifyTrip } from './verify-trip'

// sampleTrip（2026-11-08・日曜）：朝の庭園(固定 10:00-11:00)→昼食店A(12:00-13:15)→14時の予約展示(固定 14:00-15:00)
// 使える時間：庭園→昼食=60分、昼食→展示=45分。
const NOW = new Date('2026-11-06T03:00:00.000Z')

const sundayAllDay: OpeningPeriod[] = [
  { open: { day: 0, hour: 8, minute: 0 }, close: { day: 0, hour: 20, minute: 0 } },
]

// 所在地は、旅程の地域（京都）と矛盾しない、日本国内の住所。
const KYOTO_ADDRESS = '日本、〒605-0862 京都府京都市東山区清水1丁目294'

const found = (
  placeId: string,
  name: string,
  periods: OpeningPeriod[] | null = sundayAllDay,
): PlaceSearchResult => ({
  status: 'found',
  candidates: [
    {
      placeId,
      name,
      address: KYOTO_ADDRESS,
      openingHours: periods ? { status: 'available', periods } : { status: 'unavailable' },
    },
  ],
})

type Setup = {
  places?: Record<string, PlaceSearchResult | Error>
  routes?: (options: RouteOptions) => RouteResult | Error
}

// 検索語に含まれる地点名で、返す施設を決める偽のMapsクライアント。
const makeMaps = ({ places = {}, routes }: Setup = {}) => {
  const searchPlaces = vi.fn(async ({ query }: { query: string }): Promise<PlaceSearchResult> => {
    const key = Object.keys(places).find((name) => query.includes(name))
    const value = key ? places[key] : { status: 'no_candidates' as const }
    if (value instanceof Error) throw value
    return value
  })
  const computeRoute = vi.fn(async (options: RouteOptions): Promise<RouteResult> => {
    const value = routes ? routes(options) : { status: 'no_route' as const }
    if (value instanceof Error) throw value
    return value
  })
  return { searchPlaces, computeRoute }
}

const allFound: Setup['places'] = {
  朝の庭園: found('P1', '朝の庭園（架空）'),
  昼食店A: found('P2', '昼食店A（架空）'),
  '14時の予約展示': found('P3', '14時の予約展示（架空）'),
}

const walk = (minutes: number): RouteResult => ({
  status: 'found',
  durationSeconds: minutes * 60,
  minutes,
})
const route = (modes: { WALK?: RouteResult; DRIVE?: RouteResult }) => (options: RouteOptions) =>
  modes[options.mode] ?? { status: 'no_route' as const }

const run = (setup: Setup, trip: Trip = sampleTrip) =>
  verifyTrip(trip, { maps: makeMaps(setup), now: () => NOW })

const verifiedTrip = async (setup: Setup, trip: Trip = sampleTrip): Promise<Trip> => {
  const result = await run(setup, trip)
  if (result.status !== 'verified') throw new Error('照合済みの旅程を期待しました')
  return result.trip
}

const byId = (trip: Trip, stopIndex: number, suffix: string): Evidence => {
  const item = trip.stops[stopIndex].evidence.find((e) => e.id.endsWith(suffix))
  if (!item) throw new Error(`根拠 ${suffix} がありません`)
  return item
}

const hasEvidence = (trip: Trip, stopIndex: number, suffix: string): boolean =>
  trip.stops[stopIndex].evidence.some((item) => item.id.endsWith(suffix))

describe('verifyTrip: すべて照合できた場合', () => {
  const setup: Setup = { places: allFound, routes: route({ WALK: walk(10) }) }

  it('施設の存在・営業時間・移動の3つの根拠を、別々の状態として付ける', async () => {
    const trip = await verifiedTrip(setup)

    for (const index of [0, 1, 2]) {
      expect(byId(trip, index, '-place').subject).toBe('place_identity')
      expect(byId(trip, index, '-place').status).toBe('consistent')
      expect(byId(trip, index, '-hours').subject).toBe('opening_hours')
      expect(byId(trip, index, '-hours').status).toBe('consistent')
    }
    expect(trip.stops[0].evidence).toHaveLength(2) // 最初の予定には、移動の根拠が無い
    expect(byId(trip, 1, '-travel')).toMatchObject({ subject: 'travel_time', status: 'consistent' })
    expect(byId(trip, 2, '-travel')).toMatchObject({ subject: 'travel_time', status: 'consistent' })
  })

  it('名称が一致した施設のPlace IDだけを付ける', async () => {
    const trip = await verifiedTrip(setup)

    expect(trip.stops.map((stop) => stop.placeId)).toEqual(['P1', 'P2', 'P3'])
  })

  it('予定の内容（ID・名称・時刻・滞在・固定）と旅程の版は変えない', async () => {
    const trip = await verifiedTrip(setup)

    expect(trip.version).toBe(sampleTrip.version)
    expect(trip.id).toBe(sampleTrip.id)
    trip.stops.forEach((stop, index) => {
      const { id, name, plannedStartTime, durationMinutes, isFixed } = sampleTrip.stops[index]
      expect(stop).toMatchObject({ id, name, plannedStartTime, durationMinutes, isFixed })
    })
  })

  it('結果は共通契約に適合し、照合日時は注入した時刻', async () => {
    const trip = await verifiedTrip(setup)

    expect(TripSchema.safeParse(trip).success).toBe(true)
    for (const stop of trip.stops) {
      for (const item of stop.evidence) expect(item.checkedAt).toBe(NOW.toISOString())
    }
    const ids = trip.stops.flatMap((stop) => stop.evidence.map((item) => item.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('入力のPlace IDと根拠（クライアントの自己申告）は引き継がず、今回の照合結果に置き換える', async () => {
    const forged = TripSchema.parse({
      ...sampleTrip,
      stops: sampleTrip.stops.map((stop) => ({ ...stop, placeId: 'FORGED-PLACE-ID' })),
    })
    const trip = await verifiedTrip({ places: {}, routes: undefined }, forged)

    expect(trip.stops.every((stop) => stop.placeId === null)).toBe(true)
    expect(JSON.stringify(trip)).not.toContain('FORGED-PLACE-ID')
    // 入力にあった「情報源と整合」「矛盾あり」の根拠は、残らない。
    expect(
      trip.stops.flatMap((stop) => stop.evidence).some((item) => item.source.kind === 'simulation'),
    ).toBe(false)
  })

  it('検索語は「予定の名称 + 地域」で、営業時間を要求し、件数は3件まで', async () => {
    const maps = makeMaps(setup)
    await verifyTrip(sampleTrip, { maps, now: () => NOW })

    expect(maps.searchPlaces).toHaveBeenCalledTimes(3)
    expect(maps.searchPlaces).toHaveBeenCalledWith({
      query: `朝の庭園（架空） ${sampleTrip.region}`,
      maxResultCount: 3,
      includeOpeningHours: true,
    })
  })

  it('API呼び出しの回数を返す（施設検索は予定の数、経路は区間ごとに徒歩で足りれば1回）', async () => {
    const result = await run(setup)

    expect(result).toMatchObject({ status: 'verified', calls: { places: 3, routes: 2 } })
  })

  it('Places・Routes由来の値（施設名・営業時間の数値・所要時間）を、説明文に載せない', async () => {
    const found2 = {
      ...allFound,
      昼食店A: found('P2', '昼食店A（架空）', [
        { open: { day: 0, hour: 11, minute: 30 }, close: { day: 0, hour: 21, minute: 45 } },
      ]),
    }
    const trip = await verifiedTrip({ places: found2, routes: route({ WALK: walk(17) }) })
    const text = trip.stops
      .flatMap((stop) => stop.evidence.map((item) => item.explanation + item.claim))
      .join('\n')

    expect(text).not.toContain('11:30')
    expect(text).not.toContain('21:45')
    expect(text).not.toContain('17分')
  })
})

describe('verifyTrip: 移動の余裕', () => {
  it('徒歩で間に合えば、車は調べない（呼び出しを節約）', async () => {
    const maps = makeMaps({ places: allFound, routes: route({ WALK: walk(10) }) })
    await verifyTrip(sampleTrip, { maps, now: () => NOW })

    expect(maps.computeRoute.mock.calls.every(([options]) => options.mode === 'WALK')).toBe(true)
  })

  it('既定は徒歩だけ：徒歩で間に合わなければ、車で間に合っても consistent にしない（車を調べない）', async () => {
    const setup: Setup = { places: allFound, routes: route({ WALK: walk(50), DRIVE: walk(8) }) }
    const maps = makeMaps(setup)
    const result = await verifyTrip(sampleTrip, { maps, now: () => NOW })
    if (result.status !== 'verified') throw new Error('照合済みの旅程を期待しました')

    // 庭園→昼食：使える60分。徒歩50分で足りる。昼食→展示：使える45分。徒歩50分は不足（車は使えると分からない）。
    expect(byId(result.trip, 1, '-travel').explanation).toContain('徒歩で間に合う')
    expect(byId(result.trip, 2, '-travel')).toMatchObject({ status: 'conflicting' })
    expect(byId(result.trip, 2, '-travel').explanation).toContain('徒歩では間に合いません')
    expect(byId(result.trip, 2, '-travel').explanation).toContain(
      '車・公共交通は、利用できるか分からない',
    )
    expect(maps.computeRoute.mock.calls.every(([options]) => options.mode === 'WALK')).toBe(true)
  })

  it('車を使えると明示したときだけ、徒歩で間に合わない区間を車で確認する（consistent・車と明記）', async () => {
    const maps = makeMaps({ places: allFound, routes: route({ WALK: walk(50), DRIVE: walk(8) }) })
    const result = await verifyTrip(sampleTrip, {
      maps,
      now: () => NOW,
      travelModes: ['walk', 'drive'],
    })
    if (result.status !== 'verified') throw new Error('照合済みの旅程を期待しました')

    expect(byId(result.trip, 1, '-travel').explanation).toContain('徒歩で間に合う')
    expect(byId(result.trip, 2, '-travel')).toMatchObject({ status: 'consistent' })
    expect(byId(result.trip, 2, '-travel').explanation).toContain('車で間に合う')
  })

  it('車も使えるのに、徒歩でも車でも間に合わなければ conflicting（固定予定の展示に間に合わない）', async () => {
    const maps = makeMaps({ places: allFound, routes: route({ WALK: walk(90), DRIVE: walk(60) }) })
    const result = await verifyTrip(sampleTrip, {
      maps,
      now: () => NOW,
      travelModes: ['walk', 'drive'],
    })
    if (result.status !== 'verified') throw new Error('照合済みの旅程を期待しました')

    expect(byId(result.trip, 2, '-travel')).toMatchObject({
      subject: 'travel_time',
      status: 'conflicting',
    })
    expect(byId(result.trip, 2, '-travel').explanation).toContain('15分不足')
  })

  it('ちょうど間に合う（余裕0分）は consistent', async () => {
    const trip = await verifiedTrip({ places: allFound, routes: route({ WALK: walk(45) }) })

    expect(byId(trip, 2, '-travel')).toMatchObject({ status: 'consistent' })
    expect(byId(trip, 2, '-travel').explanation).toContain('余裕0分')
  })

  it('経路が無い（HTTP 200の空応答）場合は、間に合うとも言わず「確認できない」（公共交通は未対応と明記）', async () => {
    const trip = await verifiedTrip({ places: allFound, routes: () => ({ status: 'no_route' }) })

    expect(byId(trip, 1, '-travel')).toMatchObject({ status: 'unverifiable' })
    expect(byId(trip, 1, '-travel').explanation).toContain('公共交通は未対応')
  })

  it('Routesの呼び出しが失敗したら「確認できない」', async () => {
    const trip = await verifiedTrip({
      places: allFound,
      routes: () => new MapsCallError('timeout', 'x'),
    })

    expect(byId(trip, 1, '-travel')).toMatchObject({ status: 'unverifiable' })
    expect(byId(trip, 1, '-travel').explanation).toContain('失敗')
  })

  it('予定の時刻がすでに重なっている区間は、Routesを呼ばず、Routes由来の根拠を付けない', async () => {
    const overlapping = TripSchema.parse({
      ...sampleTrip,
      learningApplications: [],
      stops: sampleTrip.stops.map(
        (stop, index) => (index === 1 ? { ...stop, durationMinutes: 150 } : stop), // 12:00〜14:30 が 14:00 の展示と重なる
      ),
    })
    const maps = makeMaps({ places: allFound, routes: route({ WALK: walk(5) }) })
    const result = await verifyTrip(overlapping, { maps, now: () => NOW })

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(hasEvidence(result.trip, 2, '-travel')).toBe(false)
    expect(maps.computeRoute).toHaveBeenCalledTimes(1) // 庭園→昼食の1区間だけ
  })

  it('前後どちらかの施設を特定できていなければ、Routesを呼ばず、Routes由来の根拠を付けない', async () => {
    const maps = makeMaps({
      places: { 朝の庭園: found('P1', '朝の庭園（架空）') },
      routes: route({ WALK: walk(5) }),
    })
    const result = await verifyTrip(sampleTrip, { maps, now: () => NOW })

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    // 実際に照会していない情報を、Routes由来の確認結果（出典・照合日時つき）として扱わない。
    expect(hasEvidence(result.trip, 1, '-travel')).toBe(false)
    expect(hasEvidence(result.trip, 2, '-travel')).toBe(false)
    for (const stop of result.trip.stops) {
      expect(stop.evidence.some((item) => item.source.kind === 'routes')).toBe(false)
    }
    // 施設を特定できないことは、施設の存在の根拠で示す。
    expect(byId(result.trip, 1, '-place')).toMatchObject({ status: 'unverifiable' })
    expect(maps.computeRoute).not.toHaveBeenCalled()
  })
})

describe('verifyTrip: 名称の不一致・候補なし・営業時間（施設の存在と営業は別の状態）', () => {
  it('検索結果の名称が一致しなければ、その施設とは見なさず、Place IDも付けない（名称一致のゲート）', async () => {
    const trip = await verifiedTrip({
      places: { ...allFound, 昼食店A: found('PX', '柴崎医院') },
      routes: route({ WALK: walk(10) }),
    })

    expect(byId(trip, 1, '-place')).toMatchObject({ status: 'unverifiable' })
    expect(byId(trip, 1, '-place').explanation).toContain('一致しない')
    expect(trip.stops[1].placeId).toBeNull()
    expect(byId(trip, 1, '-hours')).toMatchObject({ status: 'unverifiable' })
    expect(byId(trip, 1, '-hours').explanation).toContain('施設を特定できていない')
  })

  it('候補が無ければ「確認できない」', async () => {
    const trip = await verifiedTrip({ places: { 朝の庭園: found('P1', '朝の庭園（架空）') } })

    expect(byId(trip, 1, '-place')).toMatchObject({ status: 'unverifiable' })
    expect(byId(trip, 1, '-place').explanation).toContain('見つけられなかった')
  })

  it('同名の施設が複数ある場合は、1つに絞らず「確認できない」', async () => {
    const twin: PlaceSearchResult = {
      status: 'found',
      candidates: [
        {
          placeId: 'A',
          name: '昼食店A（架空）',
          address: KYOTO_ADDRESS,
          openingHours: { status: 'unavailable' },
        },
        {
          placeId: 'B',
          name: '昼食店A（架空）',
          address: KYOTO_ADDRESS,
          openingHours: { status: 'unavailable' },
        },
      ],
    }
    const trip = await verifiedTrip({ places: { ...allFound, 昼食店A: twin } })

    expect(byId(trip, 1, '-place').explanation).toContain('2件')
    expect(trip.stops[1].placeId).toBeNull()
  })

  it('施設は特定できても、対象日が定休日なら、営業時間だけが conflicting（施設の存在は consistent のまま）', async () => {
    const closedSunday: OpeningPeriod[] = [
      { open: { day: 1, hour: 8 }, close: { day: 1, hour: 20 } } as OpeningPeriod,
    ]
    const trip = await verifiedTrip({
      places: { ...allFound, 昼食店A: found('P2', '昼食店A（架空）', closedSunday) },
      routes: route({ WALK: walk(10) }),
    })

    expect(byId(trip, 1, '-place').status).toBe('consistent')
    expect(byId(trip, 1, '-hours').status).toBe('conflicting')
    expect(byId(trip, 1, '-hours').explanation).toContain('定休日の可能性')
  })

  it('営業時間のデータが無い施設は、営業時間だけ「確認できない」', async () => {
    const trip = await verifiedTrip({
      places: { ...allFound, 昼食店A: found('P2', '昼食店A（架空）', null) },
      routes: route({ WALK: walk(10) }),
    })

    expect(byId(trip, 1, '-place').status).toBe('consistent')
    expect(byId(trip, 1, '-hours')).toMatchObject({ status: 'unverifiable' })
    expect(byId(trip, 1, '-hours').explanation).toContain('データが取得できない')
  })

  it('滞在が営業時間外にかかる場合は conflicting', async () => {
    const shortDay: OpeningPeriod[] = [
      { open: { day: 0, hour: 8 }, close: { day: 0, hour: 13 } } as OpeningPeriod,
    ]
    const trip = await verifiedTrip({
      places: { ...allFound, 昼食店A: found('P2', '昼食店A（架空）', shortDay) }, // 12:00〜13:15 が 13:00 閉店にかかる
      routes: route({ WALK: walk(10) }),
    })

    expect(byId(trip, 1, '-hours').status).toBe('conflicting')
  })
})

describe('verifyTrip: 呼び出しの失敗', () => {
  it('一部の施設検索が失敗しても、他の予定の照合は続ける。失敗した予定は「確認できない」', async () => {
    const trip = await verifiedTrip({
      places: { ...allFound, 昼食店A: new MapsCallError('api_error', 'x', { status: 503 }) },
      routes: route({ WALK: walk(10) }),
    })

    expect(byId(trip, 0, '-place').status).toBe('consistent')
    expect(byId(trip, 1, '-place')).toMatchObject({ status: 'unverifiable' })
    expect(byId(trip, 1, '-place').explanation).toContain('失敗')
    expect(byId(trip, 2, '-place').status).toBe('consistent')
    expect(trip.stops[1].placeId).toBeNull()
  })

  it('すべての施設検索が失敗したら、根拠は付けず、外部サービス失敗として返し、Routesも呼ばない', async () => {
    const down = new MapsCallError('auth_failed', 'x')
    const maps = makeMaps({ places: { 朝の庭園: down, 昼食店A: down, '14時の予約展示': down } })
    const result = await verifyTrip(sampleTrip, { maps, now: () => NOW })

    expect(result.status).toBe('external_service_error')
    expect(maps.computeRoute).not.toHaveBeenCalled()
  })

  it('MapsCallError以外の例外でも、失敗として扱う（例外の内容は根拠に載せない）', async () => {
    const trip = await verifiedTrip({
      places: { ...allFound, 昼食店A: new TypeError('Bearer dummy-secret') as unknown as Error },
      routes: route({ WALK: walk(10) }),
    })

    expect(JSON.stringify(trip)).not.toContain('dummy-secret')
    expect(byId(trip, 1, '-place').status).toBe('unverifiable')
  })
})

const renamed = (index: number, name: string, change: Partial<Trip> = {}): Trip =>
  TripSchema.parse({
    ...sampleTrip,
    ...change,
    learningApplications: [],
    stops: sampleTrip.stops.map((stop, i) => (i === index ? { ...stop, name } : stop)),
  })

describe('verifyTrip: 施設同定の誤判定を防ぐ（名称・所在地）', () => {
  it('支店名が異なる施設は、同じ施設とせず、Place IDも営業時間・移動の根拠にも伝えない', async () => {
    const trip = renamed(1, '昼食店A（四条店）')
    const maps = makeMaps({
      places: { ...allFound, 昼食店A: found('PX', '昼食店A（河原町店）') },
      routes: route({ WALK: walk(10) }),
    })
    const result = await verifyTrip(trip, { maps, now: () => NOW })

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(result.trip.stops[1].placeId).toBeNull()
    expect(byId(result.trip, 1, '-place')).toMatchObject({ status: 'unverifiable' })
    expect(byId(result.trip, 1, '-hours')).toMatchObject({ status: 'unverifiable' })
    // 前後の移動は、誤ったPlace IDで測らない。
    expect(hasEvidence(result.trip, 1, '-travel')).toBe(false)
    expect(hasEvidence(result.trip, 2, '-travel')).toBe(false)
    expect(maps.computeRoute).not.toHaveBeenCalled()
  })

  it('部分一致の別の施設（名称が長い・別の名称）は、採用しない', async () => {
    const maps = makeMaps({
      places: { ...allFound, 昼食店A: found('PX', '昼食店A 本店別館') },
      routes: route({ WALK: walk(10) }),
    })
    const result = await verifyTrip(sampleTrip, { maps, now: () => NOW })

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(result.trip.stops[1].placeId).toBeNull()
    expect(byId(result.trip, 1, '-place')).toMatchObject({ status: 'unverifiable' })
  })

  it('名称が一致しても、所在地が旅程の地域と一致しなければ、採用しない（別の地域の同名施設）', async () => {
    const osaka: PlaceSearchResult = {
      status: 'found',
      candidates: [
        {
          placeId: 'PX',
          name: '昼食店A（架空）',
          address: '日本、〒530-0001 大阪府大阪市北区梅田',
          openingHours: { status: 'available', periods: sundayAllDay },
        },
      ],
    }
    const maps = makeMaps({
      places: { ...allFound, 昼食店A: osaka },
      routes: route({ WALK: walk(10) }),
    })
    const result = await verifyTrip(sampleTrip, { maps, now: () => NOW })

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(result.trip.stops[1].placeId).toBeNull()
    expect(byId(result.trip, 1, '-place').explanation).toContain('所在地')
    expect(byId(result.trip, 1, '-hours')).toMatchObject({ status: 'unverifiable' })
  })

  it('住所が無い候補は、地域の裏付けがないため採用しない', async () => {
    const noAddress: PlaceSearchResult = {
      status: 'found',
      candidates: [
        {
          placeId: 'PX',
          name: '昼食店A（架空）',
          openingHours: { status: 'available', periods: sundayAllDay },
        },
      ],
    }
    const trip = await verifiedTrip({
      places: { ...allFound, 昼食店A: noAddress },
      routes: route({ WALK: walk(10) }),
    })

    expect(trip.stops[1].placeId).toBeNull()
    expect(byId(trip, 1, '-place').explanation).toContain('所在地')
  })
})

describe('verifyTrip: 営業時間のタイムゾーン', () => {
  it('旅程が日本（Asia/Tokyo）でないときは、現地時刻との対応を確認できず、営業時間を確認できない', async () => {
    const london = renamed(0, sampleTrip.stops[0].name, { timeZone: 'Europe/London' })
    const trip = await verifiedTrip({ places: allFound, routes: route({ WALK: walk(10) }) }, london)

    for (const index of [0, 1, 2]) {
      expect(byId(trip, index, '-hours')).toMatchObject({ status: 'unverifiable' })
      expect(byId(trip, index, '-hours').explanation).toContain('タイムゾーン')
    }
  })

  it('住所を日本の行政区画として読み取れない施設は、採用せず、営業時間も確認できない（現地時刻がずれる可能性）', async () => {
    const abroad: PlaceSearchResult = {
      status: 'found',
      candidates: [
        {
          placeId: 'PX',
          name: '昼食店A（架空）',
          address: 'Japan Street, Kentucky, United States 京都市',
          openingHours: { status: 'available', periods: sundayAllDay },
        },
      ],
    }
    const trip = await verifiedTrip({
      places: { ...allFound, 昼食店A: abroad },
      routes: route({ WALK: walk(10) }),
    })

    // 「Japan」や地域の語が含まれていても、日本の住所と読み取れなければ採用しない。
    expect(trip.stops[1].placeId).toBeNull()
    expect(byId(trip, 1, '-place')).toMatchObject({ status: 'unverifiable' })
    expect(byId(trip, 1, '-hours')).toMatchObject({ status: 'unverifiable' })
  })
})

describe('verifyTrip: 別の都道府県の同名の地名・記号の違いによる誤採用を防ぐ', () => {
  const candidate = (name: string, address: string): PlaceSearchResult => ({
    status: 'found',
    candidates: [
      {
        placeId: 'PX',
        name,
        address,
        openingHours: { status: 'available', periods: sundayAllDay },
      },
    ],
  })

  it('東京都目黒区東山の同名施設は、「京都・東山」の旅程では採用しない（行政区画で照合する）', async () => {
    const trip = renamed(1, '資料館', { region: '京都・東山' })
    const maps = makeMaps({
      places: {
        ...allFound,
        資料館: candidate('資料館', '日本、〒153-0043 東京都目黒区東山1丁目'),
      },
      routes: route({ WALK: walk(10) }),
    })
    const result = await verifyTrip(trip, { maps, now: () => NOW })

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(result.trip.stops[1].placeId).toBeNull()
    expect(byId(result.trip, 1, '-place')).toMatchObject({ status: 'unverifiable' })
    expect(byId(result.trip, 1, '-hours')).toMatchObject({ status: 'unverifiable' })
    expect(hasEvidence(result.trip, 1, '-travel')).toBe(false)
    expect(maps.computeRoute).not.toHaveBeenCalled()
  })

  it('「資料館（別館）」と「資料館」は、同じ施設としない', async () => {
    const maps = makeMaps({
      places: { ...allFound, 資料館: candidate('資料館', KYOTO_ADDRESS) },
      routes: route({ WALK: walk(10) }),
    })
    const trip = renamed(1, '資料館（別館）')
    const result = await verifyTrip(trip, { maps, now: () => NOW })

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(result.trip.stops[1].placeId).toBeNull()
  })

  it('「A/B」と「AB」は、同じ施設としない', async () => {
    const maps = makeMaps({
      places: { ...allFound, AB: candidate('AB', KYOTO_ADDRESS) },
      routes: route({ WALK: walk(10) }),
    })
    const trip = renamed(1, 'A/B')
    const result = await verifyTrip(trip, { maps, now: () => NOW })

    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(result.trip.stops[1].placeId).toBeNull()
  })
})
