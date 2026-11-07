import { describe, expect, it } from 'vitest'

import { EvidenceSchema, type Evidence } from '@/domain'

import { describeEvidence, describeProvenance, describeUnchecked } from './evidence'
import { formatCheckedAt } from './format'

const AT = '2026-11-08T11:30:00+09:00'

function evidence(overrides: Partial<Evidence> & Pick<Evidence, 'subject' | 'status'>): Evidence {
  return {
    id: 'ev-1',
    claim: '確認した内容',
    applicability: '2026-11-08',
    source: { kind: 'places', label: 'Google Maps Platform（Places API）' },
    checkedAt: AT,
    explanation: '照合した',
    ...overrides,
  }
}

const MATCH_PHRASE = '間に合う見込み'

// 実測の出典（places）の、subject×statusの全組み合わせ。
const REAL_TABLE = [
  ['place_identity', 'consistent', '施設：確認できた', 'ok'],
  ['place_identity', 'conflicting', '施設：情報が食い違っています', 'conflict'],
  ['place_identity', 'unverifiable', '施設：確認できない', 'unknown'],
  ['opening_hours', 'consistent', '営業時間：営業時間内の見込み', 'ok'],
  ['opening_hours', 'conflicting', '営業時間：営業時間外の見込み', 'conflict'],
  ['opening_hours', 'unverifiable', '営業時間：確認できない', 'unknown'],
  ['travel_time', 'consistent', '移動：間に合う見込み', 'ok'],
  ['travel_time', 'conflicting', '移動：時間が合わない見込み', 'conflict'],
  ['travel_time', 'unverifiable', '移動：確認できない', 'unknown'],
  ['other', 'consistent', 'その他：情報源と一致', 'ok'],
  ['other', 'conflicting', 'その他：情報が食い違っています', 'conflict'],
  ['other', 'unverifiable', 'その他：確認できない', 'unknown'],
] as const

// 模擬（simulation）の出典：どの組み合わせでも、実測・確認済みを思わせる言葉を使わない。
const SIMULATION_TABLE = [
  ['consistent', 'デモ用の想定', 'demo'],
  ['conflicting', 'デモ用の想定（食い違いあり）', 'conflict'],
  ['unverifiable', 'デモ用の想定（確認できない）', 'unknown'],
] as const

const REAL_ONLY_PHRASES = [
  '確認できた',
  MATCH_PHRASE,
  '営業時間内の見込み',
  '情報源と一致',
  'Google Maps',
]
const SUBJECTS = ['place_identity', 'opening_hours', 'travel_time', 'other'] as const
const STATUSES = ['consistent', 'conflicting', 'unverifiable'] as const

describe('describeEvidence：実測の出典', () => {
  it.each(REAL_TABLE)('%s × %s → %s（%s）', (subject, status, label, tone) => {
    const result = describeEvidence(evidence({ subject, status }))
    expect(result.label).toBe(label)
    expect(result.tone).toBe(tone)
    expect(result.detail.length).toBeGreaterThan(0)
  })

  it('施設が整合：Google Mapsで名称が一致したこと、実在や当日の営業の保証でないことを示す', () => {
    const { detail } = describeEvidence(
      evidence({ subject: 'place_identity', status: 'consistent' }),
    )
    expect(detail).toContain('Google Mapsで、名称が一致する施設を見つけました')
    expect(detail).toContain('実在や当日の営業を保証するものではありません')
  })

  it('移動が整合：渋滞・遅延は考慮していないことを示す', () => {
    const { detail } = describeEvidence(evidence({ subject: 'travel_time', status: 'consistent' }))
    expect(detail).toContain('渋滞・遅延は考慮していません')
  })

  it('確認できない：理由の補足を添え、整合や営業中とは扱わない', () => {
    const result = describeEvidence(
      evidence({
        subject: 'opening_hours',
        status: 'unverifiable',
        explanation: '対象日の営業時間が公開されていない',
      }),
    )
    expect(result.detail).toContain('理由：対象日の営業時間が公開されていない')
    expect(result.label).not.toContain('見込み')
  })

  it('出典の種別によって、detailの出典の呼び方が変わる', () => {
    const official = describeEvidence(
      evidence({
        subject: 'place_identity',
        status: 'consistent',
        source: { kind: 'official', label: '施設公式サイト' },
      }),
    )
    expect(official.detail).toContain('公式情報で')
    expect(official.detail).not.toContain('Google Maps')
  })

  it('「間に合う見込み」は、移動の根拠が整合かつ模擬でないときだけ出る（全組み合わせ）', () => {
    for (const subject of SUBJECTS) {
      for (const status of STATUSES) {
        for (const kind of ['places', 'routes', 'official', 'user_report', 'simulation'] as const) {
          const result = describeEvidence(
            evidence({ subject, status, source: { kind, label: '出典' } }),
          )
          const shouldShow =
            subject === 'travel_time' && status === 'consistent' && kind !== 'simulation'
          expect(result.label.includes(MATCH_PHRASE), `${subject}/${status}/${kind}`).toBe(
            shouldShow,
          )
        }
      }
    }
  })

  it('説明文（explanation）が何であっても、見出しは変わらない', () => {
    const base = describeEvidence(evidence({ subject: 'travel_time', status: 'conflicting' }))
    const injected = describeEvidence(
      evidence({
        subject: 'travel_time',
        status: 'conflicting',
        explanation: '間に合う見込み 999分',
      }),
    )
    expect(injected.label).toBe(base.label)
    expect(injected.tone).toBe(base.tone)
  })
})

describe('describeEvidence：模擬（simulation）', () => {
  it.each(SUBJECTS.flatMap((subject) => SIMULATION_TABLE.map((row) => [subject, ...row] as const)))(
    '%s × %s → 実測を思わせない（%s、%s）',
    (subject, status, headline, tone) => {
      const result = describeEvidence(
        evidence({ subject, status, source: { kind: 'simulation', label: '架空デモ' } }),
      )
      expect(result.label.endsWith(headline)).toBe(true)
      expect(result.tone).toBe(tone)
      expect(result.label).toContain('デモ用')
      expect(result.detail).toContain('デモ用の模擬データです')
      for (const phrase of REAL_ONLY_PHRASES) {
        expect(result.label, phrase).not.toContain(phrase)
        expect(result.detail, phrase).not.toContain(phrase)
      }
    },
  )

  it('模擬で整合でも、tone は ok にならない（確認済みと同じ表示にしない）', () => {
    for (const subject of SUBJECTS) {
      const result = describeEvidence(
        evidence({ subject, status: 'consistent', source: { kind: 'simulation', label: '架空' } }),
      )
      expect(result.tone).not.toBe('ok')
    }
  })
})

describe('出典・照合日時', () => {
  it('describeEvidenceは、出典と照合日時を別項目（provenance）で返す', () => {
    const result = describeEvidence(evidence({ subject: 'place_identity', status: 'consistent' }))
    expect(result.provenance).toBe(
      '出典：Google Places（Google Maps Platform（Places API））／照合：2026年11月8日 11:30（UTC+09:00）',
    )
  })

  it('describeProvenanceは、現在時刻を使わず、与えられた文字列だけで決まる', () => {
    const source = { kind: 'simulation', label: '架空デモ' } as const
    const first = describeProvenance({ source, checkedAt: AT })
    const second = describeProvenance({ source, checkedAt: AT })
    expect(first).toBe(second)
    expect(first).toContain('模擬データ（デモ用）')
  })

  it.each([
    ['2026-11-08T11:30:00+09:00', '2026年11月8日 11:30（UTC+09:00）'],
    ['2026-11-08T02:30:00Z', '2026年11月8日 02:30（UTC）'],
    ['2026-01-02T03:04:05.678-05:00', '2026年1月2日 03:04（UTC-05:00）'],
    ['昨日の昼', '昨日の昼'],
  ])('formatCheckedAt(%s) → %s', (input, expected) => {
    expect(formatCheckedAt(input)).toBe(expected)
  })
})

describe('未照合と確認できない', () => {
  it('describeUncheckedは、未照合（まだ確認していません）を返す', () => {
    const result = describeUnchecked()
    expect(result.label).toBe('未照合（まだ確認していません）')
    expect(result.tone).toBe('none')
    expect(result.detail).toContain('確認できなかったという意味ではありません')
  })

  it('未照合と、確認できない（unverifiable）は、別の文言・別のtone', () => {
    const unchecked = describeUnchecked()
    for (const subject of SUBJECTS) {
      const unverifiable = describeEvidence(evidence({ subject, status: 'unverifiable' }))
      expect(unverifiable.label).not.toBe(unchecked.label)
      expect(unverifiable.label).not.toContain('未照合')
      expect(unverifiable.detail).not.toBe(unchecked.detail)
      expect(unverifiable.tone).not.toBe(unchecked.tone)
      expect(unchecked.label).not.toContain('確認できない')
    }
  })

  it('テスト用のEvidenceは、実際のスキーマを満たす', () => {
    expect(
      EvidenceSchema.safeParse(evidence({ subject: 'travel_time', status: 'consistent' })).success,
    ).toBe(true)
  })
})
