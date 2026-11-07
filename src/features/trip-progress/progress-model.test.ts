import { describe, expect, it } from 'vitest'

import { sampleTrip } from '@/domain/samples'
import type { Evidence, Stop } from '@/domain'

import {
  clampIndex,
  evidenceLines,
  gapMinutes,
  progressOf,
  stepBack,
  stepForward,
  stopEndTime,
  stopProgressLabels,
  travelBasisOf,
} from './progress-model'

const evidence = (
  id: string,
  subject: Evidence['subject'],
  status: Evidence['status'],
  sourceKind: Evidence['source']['kind'] = 'routes',
): Evidence => ({
  id,
  subject,
  claim: '確認した内容',
  applicability: '対象日時',
  source: { kind: sourceKind, label: '出典' },
  checkedAt: '2026-11-08T09:00:00+09:00',
  status,
  explanation: '説明',
})

const stopWith = (items: Evidence[]): Pick<Stop, 'evidence'> => ({ evidence: items })

describe('進行位置の計算', () => {
  it('範囲外・小数・NaNを、安全な範囲に収める', () => {
    expect(clampIndex(-3, 4)).toBe(0)
    expect(clampIndex(99, 4)).toBe(3)
    expect(clampIndex(1.9, 4)).toBe(1)
    expect(clampIndex(Number.NaN, 4)).toBe(0)
    expect(clampIndex(2, 0)).toBe(0)
  })

  it('進めると1つ先へ。最後の予定では進めず、位置も変えない', () => {
    expect(stepForward(0, 4)).toEqual({ moved: true, index: 1 })
    expect(stepForward(2, 4)).toEqual({ moved: true, index: 3 })
    expect(stepForward(3, 4)).toEqual({ moved: false, index: 3 })
  })

  it('戻すと1つ前へ。最初の予定では戻せず、位置も変えない', () => {
    expect(stepBack(3, 4)).toEqual({ moved: true, index: 2 })
    expect(stepBack(1, 4)).toEqual({ moved: true, index: 0 })
    expect(stepBack(0, 4)).toEqual({ moved: false, index: 0 })
  })

  it('範囲外の位置から始まっても、範囲を越えない', () => {
    expect(stepForward(10, 4)).toEqual({ moved: false, index: 3 })
    expect(stepBack(-2, 4)).toEqual({ moved: false, index: 0 })
  })

  it('進行状態は、訪問済み・いま・これからの3つで、文字がそれぞれ違う', () => {
    expect([0, 1, 2, 3].map((index) => progressOf(index, 2))).toEqual([
      'visited',
      'visited',
      'current',
      'upcoming',
    ])
    expect(new Set(Object.values(stopProgressLabels)).size).toBe(3)
  })
})

describe('予定上の時刻', () => {
  it('終了時刻と、前の予定の終了から次の開始までの間隔（分）を出す', () => {
    expect(stopEndTime({ plannedStartTime: '10:00', durationMinutes: 60 })).toBe('11:00')
    expect(stopEndTime({ plannedStartTime: '12:00', durationMinutes: 75 })).toBe('13:15')
    const [morning, lunch, exhibition] = sampleTrip.stops
    expect(gapMinutes(morning, lunch)).toBe(60)
    expect(gapMinutes(lunch, exhibition)).toBe(45)
    // 重なる場合は負になる（前の予定が終わる前に、次が始まる）。
    expect(gapMinutes({ plannedStartTime: '10:00', durationMinutes: 90 }, lunch)).toBe(30)
    expect(gapMinutes({ plannedStartTime: '11:30', durationMinutes: 60 }, lunch)).toBe(-30)
  })
})

describe('移動の根拠の文言', () => {
  it('根拠が無ければ「移動時間は未確認」。間に合うと断定しない', () => {
    expect(travelBasisOf(stopWith([]))).toEqual({
      kind: 'unchecked',
      text: '移動時間は未確認',
      simulated: false,
    })
  })

  it('移動時間以外の根拠だけでは、移動の根拠にしない', () => {
    expect(travelBasisOf(stopWith([evidence('e1', 'opening_hours', 'consistent')])).kind).toBe(
      'unchecked',
    )
  })

  it.each([
    ['consistent', '間に合う見込み（情報源と整合）'],
    ['conflicting', '間に合わない見込み（矛盾あり）'],
    ['unverifiable', '移動時間を確認できない'],
  ] as const)('%s は「%s」', (status, text) => {
    const basis = travelBasisOf(stopWith([evidence('e1', 'travel_time', status)]))
    expect(basis.kind).toBe(status)
    expect(basis.text).toBe(text)
  })

  it('複数の根拠があれば、最も重い状態を示す（矛盾を整合の陰に隠さない）', () => {
    const basis = travelBasisOf(
      stopWith([
        evidence('e1', 'travel_time', 'consistent'),
        evidence('e2', 'travel_time', 'conflicting'),
        evidence('e3', 'travel_time', 'unverifiable'),
      ]),
    )
    expect(basis.kind).toBe('conflicting')
  })

  it('模擬データ由来であることを区別できる', () => {
    expect(
      travelBasisOf(stopWith([evidence('e1', 'travel_time', 'consistent', 'simulation')]))
        .simulated,
    ).toBe(true)
    expect(
      travelBasisOf(stopWith([evidence('e1', 'travel_time', 'consistent', 'routes')])).simulated,
    ).toBe(false)
  })
})

describe('予定の根拠の状態', () => {
  it('根拠が無ければ空（未照合として扱う）', () => {
    expect(evidenceLines(stopWith([]))).toEqual([])
  })

  it('確認項目ごとに、最も重い状態を1行にまとめ、項目の順に並べる', () => {
    const lines = evidenceLines(
      stopWith([
        evidence('e1', 'travel_time', 'consistent'),
        evidence('e2', 'place_identity', 'consistent'),
        evidence('e3', 'place_identity', 'unverifiable'),
        evidence('e4', 'opening_hours', 'conflicting'),
      ]),
    )
    expect(lines.map((line) => `${line.subjectLabel}：${line.statusLabel}`)).toEqual([
      '施設の存在：確認できない',
      '営業時間：矛盾あり',
      '移動時間：情報源と整合',
    ])
  })
})
