import { describe, expect, it } from 'vitest'

import type { OpeningPeriod, PlaceCandidate } from '../maps'
import { compareNames, normalizeName, selectPlace } from './name-match'
import { checkOpeningHours, weekdayIndex, weekdayName } from './opening-hours'
import { availableMinutes, evaluateTravel } from './travel'

const place = (placeId: string, name: string): PlaceCandidate => ({
  placeId,
  name,
  openingHours: { status: 'not_requested' },
})

describe('名称の正規化と一致', () => {
  it('空白・記号・全角半角・大文字小文字の違いを吸収する', () => {
    expect(normalizeName('奥丹 清水')).toBe(normalizeName('奥丹清水'))
    expect(normalizeName('ＡＢＣ・カフェ')).toBe(normalizeName('abcカフェ'))
    expect(normalizeName('「茶寮 都路里」')).toBe('茶寮都路里')
  })

  it('括弧書きの補足は、比較から外す', () => {
    expect(normalizeName('昼食店A（架空）')).toBe('昼食店a')
    expect(normalizeName('カフェ(京都駅店)')).toBe('カフェ')
  })

  it('正規化後に同じなら exact', () => {
    expect(compareNames('総本家 ゆどうふ 奥丹清水', '総本家ゆどうふ奥丹清水')).toBe('exact')
  })

  it('一方が他方を含み、短いほうが3文字以上で半分以上を占めるなら partial', () => {
    expect(compareNames('祇園辻利', '祇園辻利 祇園本店')).toBe('partial')
    expect(compareNames('清水寺', '清水寺 (音羽山)')).toBe('exact')
  })

  it('短すぎる・割合が小さい部分一致は認めない（別の施設への誤紐付けを避ける）', () => {
    expect(compareNames('清水', '清水寺')).toBe('none') // 短い側が2文字
    expect(compareNames('茶寮', '茶寮都路里祇園本店')).toBe('none')
    expect(compareNames('カフェ', 'カフェ京都駅前店')).toBe('none') // 3文字だが、割合が半分未満
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

describe('施設の選択（名称一致のゲート）', () => {
  it('名称が一致する1件を選ぶ', () => {
    const result = selectPlace('清水寺', [place('a', '八坂神社'), place('b', '清水寺')])

    expect(result).toMatchObject({ status: 'matched', match: 'exact', place: { placeId: 'b' } })
  })

  it('候補があっても、どれも一致しなければ mismatch（採用しない）', () => {
    expect(selectPlace('おきな家', [place('a', 'ひさご'), place('b', '柴崎医院')])).toEqual({
      status: 'mismatch',
    })
  })

  it('候補が無ければ no_candidates', () => {
    expect(selectPlace('清水寺', [])).toEqual({ status: 'no_candidates' })
  })

  it('exactがあれば、partialより優先する', () => {
    const result = selectPlace('祇園辻利', [
      place('partial', '祇園辻利 祇園本店'),
      place('exact', '祇園辻利'),
    ])

    expect(result).toMatchObject({ status: 'matched', match: 'exact', place: { placeId: 'exact' } })
  })

  it('同名の施設が複数ある（異なるPlace ID）場合は ambiguous で、1つに絞らない', () => {
    const result = selectPlace('茶寮都路里', [place('a', '茶寮都路里'), place('b', '茶寮都路里')])

    expect(result).toEqual({ status: 'ambiguous', count: 2 })
  })

  it('同じPlace IDの重複は、1件として数える', () => {
    const result = selectPlace('茶寮都路里', [place('a', '茶寮都路里'), place('a', '茶寮都路里')])

    expect(result.status).toBe('matched')
  })

  it('名称が空の候補は、選ばれない', () => {
    expect(selectPlace('清水寺', [place('a', '')])).toEqual({ status: 'mismatch' })
  })
})

describe('曜日', () => {
  it('日付から曜日を求める（0=日曜）', () => {
    expect(weekdayIndex('2026-11-08')).toBe(0)
    expect(weekdayIndex('2026-11-14')).toBe(6)
    expect(weekdayName('2026-11-14')).toBe('土曜日')
    expect(weekdayName('2028-02-29')).toBe('火曜日')
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

  it('余裕が0以上なら間に合う（ちょうども可）。負なら間に合わない', () => {
    expect(evaluateTravel(60, 45)).toEqual({ status: 'fits', slackMinutes: 15 })
    expect(evaluateTravel(60, 60)).toEqual({ status: 'fits', slackMinutes: 0 })
    expect(evaluateTravel(60, 61)).toEqual({ status: 'too_long', slackMinutes: -1 })
  })
})
