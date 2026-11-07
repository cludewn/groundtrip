import { describe, expect, it } from 'vitest'

import { describeApproval } from './approval'
import { describeConstraint, describeTravelModes } from './constraint'

const MATCH_PHRASE = '間に合う見込み'
const AT = '2026-11-08T12:00:00+09:00'

const CONSTRAINT_TABLE = [
  ['satisfied', '次の固定予定に間に合う見込み', 'ok', true],
  ['violated', '条件に合いません', 'conflict', false],
  ['unknown', '間に合うか確認できません', 'unknown', false],
  ['not_checked', 'まだ検証していません', 'none', false],
] as const

describe('describeConstraint', () => {
  it.each(CONSTRAINT_TABLE)('%s → %s（%s、canApprove=%s）', (status, label, tone, canApprove) => {
    const result = describeConstraint({ status, explanation: '理由の文' })
    expect(result.label).toBe(label)
    expect(result.tone).toBe(tone)
    expect(result.canApprove).toBe(canApprove)
  })

  it('canApproveは、satisfiedのときだけtrue', () => {
    const results = CONSTRAINT_TABLE.map(
      ([status]) => describeConstraint({ status, explanation: '説明' }).canApprove,
    )
    expect(results).toEqual([true, false, false, false])
  })

  it('「間に合う見込み」は、satisfiedのときだけ出る（見出し・補足とも）', () => {
    for (const [status] of CONSTRAINT_TABLE) {
      const result = describeConstraint({ status, explanation: '説明' }, { travelModes: ['walk'] })
      const shown = result.label.includes(MATCH_PHRASE) || result.detail.includes(MATCH_PHRASE)
      expect(shown, status).toBe(status === 'satisfied')
    }
  })

  it('satisfied：何を検証した結果か（営業時間と前後の移動、手段）と、考慮していないことを示す', () => {
    const { detail } = describeConstraint(
      { status: 'satisfied', explanation: '検証済み' },
      { travelModes: ['walk'] },
    )
    expect(detail).toContain('営業時間')
    expect(detail).toContain('前後の移動（徒歩のみ）')
    expect(detail).toContain('臨時休業・渋滞・遅延は考慮していません')
  })

  it('satisfied：手段が未指定なら、徒歩などと断定せず「手段は未指定」と書く', () => {
    const { detail } = describeConstraint({ status: 'satisfied', explanation: '検証済み' })
    expect(detail).toContain('手段は未指定')
    expect(detail).not.toContain('徒歩')
  })

  it('violated：理由と次の操作を示す', () => {
    const { detail } = describeConstraint({ status: 'violated', explanation: '閉店時刻を過ぎる' })
    expect(detail).toContain('理由：閉店時刻を過ぎる')
    expect(detail).toContain('別の案を選ぶか')
  })

  it('unknown：判断できない理由を示し、承認できる案として扱わない', () => {
    const result = describeConstraint({ status: 'unknown', explanation: '営業時間を取得できない' })
    expect(result.detail).toContain('理由：営業時間を取得できない')
    expect(result.detail).toContain('承認できる案としては扱いません')
  })

  it('satisfied以外の見出しは、説明文（explanation）に左右されない', () => {
    for (const [status, label] of CONSTRAINT_TABLE) {
      const result = describeConstraint({ status, explanation: '間に合う見込み 999分' })
      expect(result.label).toBe(label)
    }
  })
})

describe('describeTravelModes', () => {
  it.each([
    [undefined, '手段は未指定'],
    [[], '手段は未指定'],
    [['walk'], '徒歩のみ'],
    [['drive'], '車のみ'],
    [['walk', 'walk'], '徒歩のみ'],
    [['walk', 'drive'], '徒歩・車'],
  ] as const)('%j → %s', (modes, expected) => {
    expect(describeTravelModes(modes)).toBe(expected)
  })
})

describe('describeApproval', () => {
  it('pending：まだ旅程には反映されていない', () => {
    const result = describeApproval({ status: 'pending' })
    expect(result.label).toBe('まだ旅程には反映されていません')
    expect(result.tone).toBe('pending')
  })

  it('approved：承認済み（判断日時つき）', () => {
    const result = describeApproval({ status: 'approved', decidedAt: AT })
    expect(result.label).toBe('承認済み')
    expect(result.tone).toBe('approved')
    expect(result.detail).toContain('2026年11月8日 12:00（UTC+09:00）')
  })

  it('rejected：見送りました（旅程に反映されていない）', () => {
    const result = describeApproval({ status: 'rejected', decidedAt: AT })
    expect(result.label).toBe('見送りました')
    expect(result.tone).toBe('rejected')
    expect(result.detail).toContain('旅程には反映されていません')
  })

  it('承認の言葉は、根拠・制約の見込みの言葉と混ざらない', () => {
    for (const approval of [
      { status: 'pending' },
      { status: 'approved', decidedAt: AT },
      { status: 'rejected', decidedAt: AT },
    ] as const) {
      const result = describeApproval(approval)
      expect(result.label).not.toContain('見込み')
      expect(result.label).not.toContain('確認')
    }
  })
})
