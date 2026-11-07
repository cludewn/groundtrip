import { describe, expect, it } from 'vitest'

import type { OpeningPeriod, PlaceCandidate } from '../maps'
import {
  addressMatchesRegion,
  compareNames,
  parseName,
  regionTokens,
  selectPlace,
} from './name-match'
import { checkOpeningHours, weekdayIndex, weekdayName } from './opening-hours'
import { availableMinutes, evaluateTravel, hasTimeConflict } from './travel'

const REGION = '京都・東山'
const KYOTO_ADDRESS = '日本、〒605-0862 京都府京都市東山区清水1丁目294'
const OSAKA_ADDRESS = '日本、〒530-0001 大阪府大阪市北区梅田'
const place = (
  placeId: string,
  name: string,
  address: string | null = KYOTO_ADDRESS,
): PlaceCandidate => ({
  placeId,
  name,
  address: address ?? undefined,
  openingHours: { status: 'not_requested' },
})

describe('名称の解析と一致', () => {
  it('空白・記号・全角半角・大文字小文字の違いを吸収する', () => {
    expect(parseName('奥丹 清水').base).toBe(parseName('奥丹清水').base)
    expect(parseName('ＡＢＣ・カフェ').base).toBe(parseName('abcカフェ').base)
    expect(parseName('「茶寮 都路里」').base).toBe('茶寮都路里')
  })

  it('括弧書きは、比較用の名称から分け、識別情報として保持する', () => {
    expect(parseName('昼食店A（架空）')).toEqual({ base: '昼食店a', qualifier: '架空' })
    expect(parseName('カフェ(京都駅店)')).toEqual({ base: 'カフェ', qualifier: '京都駅店' })
  })

  it('正規化後に同じなら exact', () => {
    expect(compareNames('総本家 ゆどうふ 奥丹清水', '総本家ゆどうふ奥丹清水')).toBe('exact')
    expect(compareNames('清水寺', '清水寺')).toBe('exact')
  })

  it('支店名が異なる（括弧書きを保持して比べる）場合は、同じ施設としない', () => {
    expect(compareNames('麺処いちょう庵（四条店）', '麺処いちょう庵（河原町店）')).toBe('none')
    expect(compareNames('麺処いちょう庵（四条店）', '麺処いちょう庵（四条店）')).toBe('exact')
  })

  it('見つかった施設だけが支店を名乗る・生成した名称だけが支店を指定する場合は、確かめられない', () => {
    expect(compareNames('麺処いちょう庵', '麺処いちょう庵（河原町店）')).toBe('none')
    expect(compareNames('麺処いちょう庵（四条店）', '麺処いちょう庵')).toBe('none')
  })

  it('支店の指定ではない補足（架空・サンプルなど）は、無視する', () => {
    expect(compareNames('洛東食事処（サンプル）', '洛東食事処')).toBe('exact')
  })

  it('部分一致は認めない（別の施設を採用しない）', () => {
    expect(compareNames('祇園辻利', '祇園辻利 祇園本店')).toBe('none')
    expect(compareNames('清水寺', '清水寺 奥の院')).toBe('none')
    expect(compareNames('清水', '清水寺')).toBe('none')
    expect(compareNames('茶寮', '茶寮都路里祇園本店')).toBe('none')
    expect(compareNames('カフェ', 'カフェ京都駅前店')).toBe('none')
  })

  it('疎通確認で別の施設に紐付いた事例（飲食店→別の飲食店、飲食店→医院）を一致としない', () => {
    expect(compareNames('おきな家', 'ひさご')).toBe('none')
    expect(compareNames('柴崎', '柴崎医院')).toBe('none')
  })

  it('空の名称は、どれとも一致しない', () => {
    expect(compareNames('', '清水寺')).toBe('none')
    expect(compareNames('清水寺', '')).toBe('none')
    expect(compareNames('（架空）', '（架空）')).toBe('none')
  })
})

describe('所在地と地域', () => {
  it('地域を語に分け、「周辺」などの語尾は外す', () => {
    expect(regionTokens('京都・東山')).toEqual(['京都', '東山'])
    expect(regionTokens('京都駅周辺')).toEqual(['京都駅'])
    expect(regionTokens('  ・ ')).toEqual([])
  })

  it('住所に、地域の語のどれかが含まれていれば、矛盾しない', () => {
    expect(addressMatchesRegion(KYOTO_ADDRESS, REGION)).toBe(true)
    expect(addressMatchesRegion('日本、〒600-8216 京都府京都市下京区東塩小路町', REGION)).toBe(true)
  })

  it('住所が無い・地域の語が無い・地域が空なら、裏付けなし', () => {
    expect(addressMatchesRegion(undefined, REGION)).toBe(false)
    expect(addressMatchesRegion(OSAKA_ADDRESS, REGION)).toBe(false)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '')).toBe(false)
  })

  it('「京都」は、「東京都」の一部としては数えない', () => {
    expect(addressMatchesRegion('日本、〒100-0001 東京都千代田区千代田', '京都')).toBe(false)
  })
})

describe('施設の選択（名称・所在地のゲート）', () => {
  it('名称が一致し、所在地が地域と矛盾しない1件を選ぶ', () => {
    const result = selectPlace('清水寺', REGION, [place('a', '八坂神社'), place('b', '清水寺')])

    expect(result).toMatchObject({ status: 'matched', place: { placeId: 'b' } })
  })

  it('候補があっても、どれも一致しなければ mismatch（採用しない）', () => {
    const result = selectPlace('おきな家', REGION, [place('a', 'ひさご'), place('b', '柴崎医院')])

    expect(result).toEqual({ status: 'mismatch' })
  })

  it('候補が無ければ no_candidates', () => {
    expect(selectPlace('清水寺', REGION, [])).toEqual({ status: 'no_candidates' })
  })

  it('名称が一致しても、所在地が地域と一致しなければ region_mismatch（別の地域の同名施設を採用しない）', () => {
    const result = selectPlace('麺処いちょう庵', REGION, [
      place('a', '麺処いちょう庵', OSAKA_ADDRESS),
    ])

    expect(result).toEqual({ status: 'region_mismatch' })
  })

  it('住所が無い候補は、地域の裏付けがないため採用しない', () => {
    const result = selectPlace('清水寺', REGION, [place('a', '清水寺', null)])

    expect(result).toEqual({ status: 'region_mismatch' })
  })

  it('地域が合う同名の施設と、合わない同名の施設があれば、合うほうだけを選ぶ', () => {
    const result = selectPlace('麺処いちょう庵', REGION, [
      place('osaka', '麺処いちょう庵', OSAKA_ADDRESS),
      place('kyoto', '麺処いちょう庵'),
    ])

    expect(result).toMatchObject({ status: 'matched', place: { placeId: 'kyoto' } })
  })

  it('支店名が異なる候補しかなければ、採用しない（誤ったPlace IDを根拠に伝えない）', () => {
    const result = selectPlace('麺処いちょう庵（四条店）', REGION, [
      place('a', '麺処いちょう庵（河原町店）'),
    ])

    expect(result).toEqual({ status: 'mismatch' })
  })

  it('同名の施設が複数ある（異なるPlace ID）場合は ambiguous で、1つに絞らない', () => {
    const result = selectPlace('茶寮都路里', REGION, [
      place('a', '茶寮都路里'),
      place('b', '茶寮都路里'),
    ])

    expect(result).toEqual({ status: 'ambiguous', count: 2 })
  })

  it('同じPlace IDの重複は、1件として数える', () => {
    const result = selectPlace('茶寮都路里', REGION, [
      place('a', '茶寮都路里'),
      place('a', '茶寮都路里'),
    ])

    expect(result.status).toBe('matched')
  })

  it('名称が空の候補は、選ばれない', () => {
    expect(selectPlace('清水寺', REGION, [place('a', '')])).toEqual({ status: 'mismatch' })
  })
})

describe('曜日', () => {
  it('日付から曜日を求める（0=日曜）', () => {
    expect(weekdayIndex('2026-11-08')).toBe(0)
    expect(weekdayIndex('2026-11-14')).toBe(6)
    expect(weekdayName('2026-11-14')).toBe('土曜日')
    expect(weekdayName('2028-02-29')).toBe('火曜日')
  })

  it('西暦1〜99年も、そのままの年として扱う（1900年代に読み替えない）', () => {
    expect(weekdayIndex('0001-01-01')).toBe(1)
    expect(weekdayIndex('0099-12-31')).toBe(new Date('0099-12-31T00:00:00Z').getUTCDay())
  })
})

const open = (day: number, hour: number, minute = 0) => ({ day, hour, minute })
const period = (o: ReturnType<typeof open>, c?: ReturnType<typeof open>): OpeningPeriod => ({
  open: o,
  close: c,
})
// 2026-11-14（土曜）を対象にする。土曜=6。
const SAT = '2026-11-14'

describe('営業時間の照合（通常営業時間）', () => {
  const saturday = [period(open(6, 9), open(6, 17))]

  it('営業時間内なら consistent（ちょうど閉店時刻までも含む）', () => {
    expect(checkOpeningHours(saturday, SAT, '10:00', 60).status).toBe('consistent')
    expect(checkOpeningHours(saturday, SAT, '09:00', 480).status).toBe('consistent')
    expect(checkOpeningHours(saturday, SAT, '16:00', 60).status).toBe('consistent')
  })

  it('開店前・閉店後にかかるなら conflicting', () => {
    expect(checkOpeningHours(saturday, SAT, '08:30', 60).status).toBe('conflicting')
    expect(checkOpeningHours(saturday, SAT, '16:30', 60).status).toBe('conflicting')
    expect(checkOpeningHours(saturday, SAT, '17:00', 30).status).toBe('conflicting')
  })

  it('その曜日に営業の記載が無ければ conflicting（定休日の可能性）', () => {
    const result = checkOpeningHours([period(open(1, 9), open(1, 17))], SAT, '10:00', 60)

    expect(result.status).toBe('conflicting')
    expect(result.explanation).toContain('定休日の可能性')
  })

  it('昼休みなど、同じ日に複数の営業時間があるときは、どれか1つに収まればよい', () => {
    const split = [period(open(6, 9), open(6, 12)), period(open(6, 13), open(6, 17))]

    expect(checkOpeningHours(split, SAT, '13:30', 60).status).toBe('consistent')
    expect(checkOpeningHours(split, SAT, '11:30', 60).status).toBe('conflicting') // 昼休みにかかる
  })

  it('日付をまたぐ営業（土曜18:00〜日曜2:00）を扱える', () => {
    const late = [period(open(6, 18), open(0, 2))]

    expect(checkOpeningHours(late, SAT, '20:00', 120).status).toBe('consistent')
    expect(checkOpeningHours(late, '2026-11-08', '01:00', 60).status).toBe('consistent') // 日曜の早朝
    expect(checkOpeningHours(late, '2026-11-08', '01:30', 60).status).toBe('conflicting')
  })

  it('24時間営業（日曜0:00開店・閉店なし）は、どの時間帯も consistent', () => {
    expect(checkOpeningHours([period(open(0, 0))], SAT, '03:00', 60).status).toBe('consistent')
  })

  it('営業の区間を解釈できない（閉店が無く24時間でもない）場合は unverifiable', () => {
    expect(checkOpeningHours([period(open(6, 9))], SAT, '10:00', 60).status).toBe('unverifiable')
    expect(checkOpeningHours([], SAT, '10:00', 60).status).toBe('unverifiable')
  })

  it('24時間営業の正規の表現は、ちょうど1件だけ。他の区間と並ぶ「閉店なし」は24時間営業としない', () => {
    const mixed = [period(open(0, 0)), period(open(6, 9), open(6, 12))]

    expect(checkOpeningHours(mixed, SAT, '20:00', 60).status).toBe('unverifiable')
    // 日曜0:00以外の「閉店なし」も、24時間営業ではない。
    expect(checkOpeningHours([period(open(6, 0))], SAT, '03:00', 60).status).toBe('unverifiable')
  })

  it('解釈できない区間があるとき、確認できた区間の範囲外だけで「営業時間外」と断定しない', () => {
    const partial = [period(open(6, 9), open(6, 12)), period(open(6, 13))]

    expect(checkOpeningHours(partial, SAT, '15:00', 60).status).toBe('unverifiable')
    // 確認できた区間に収まるなら、その区間は信頼できるため consistent。
    expect(checkOpeningHours(partial, SAT, '10:00', 60).status).toBe('consistent')
  })

  it('説明に、臨時休業は確認できないことを明記する（consistentのとき）', () => {
    expect(checkOpeningHours(saturday, SAT, '10:00', 60).explanation).toContain('臨時休業')
  })

  it('説明に、営業時間そのもの（Places由来の値）を載せない', () => {
    const result = checkOpeningHours(saturday, SAT, '10:00', 60)

    expect(result.explanation).not.toContain('09:00')
    expect(result.explanation).not.toContain('17:00')
  })
})

describe('営業時間：空配列（欠落とは別）', () => {
  it('空配列は、営業とも休みとも決めつけず、空であることを理由に「確認できない」とする', () => {
    const result = checkOpeningHours([], SAT, '10:00', 60)

    expect(result.status).toBe('unverifiable')
    expect(result.explanation).toContain('空')
    expect(result.explanation).not.toContain('定休日')
  })
})

describe('移動の余裕', () => {
  it('前の予定の終了から次の予定の開始までの時間を求める', () => {
    expect(
      availableMinutes({
        previous: { plannedStartTime: '12:00', durationMinutes: 60 },
        next: { plannedStartTime: '14:00' },
      }),
    ).toBe(60)
    expect(
      availableMinutes({
        previous: { plannedStartTime: '12:00', durationMinutes: 150 },
        next: { plannedStartTime: '14:00' },
      }),
    ).toBe(-30)
  })

  it('予定の時刻が、順序どおりで重なっていないかを判定する', () => {
    const stop = (plannedStartTime: string, durationMinutes: number) => ({
      plannedStartTime,
      durationMinutes,
    })

    expect(hasTimeConflict([stop('10:00', 60), stop('11:00', 30), stop('14:00', 60)])).toBe(false)
    expect(hasTimeConflict([stop('10:00', 90), stop('11:00', 30)])).toBe(true)
    expect(hasTimeConflict([stop('12:00', 30), stop('10:00', 30)])).toBe(true)
  })

  it('余裕が0以上なら間に合う（ちょうども可）。負なら間に合わない', () => {
    expect(evaluateTravel(60, 45)).toEqual({ status: 'fits', slackMinutes: 15 })
    expect(evaluateTravel(60, 60)).toEqual({ status: 'fits', slackMinutes: 0 })
    expect(evaluateTravel(60, 61)).toEqual({ status: 'too_long', slackMinutes: -1 })
  })
})
