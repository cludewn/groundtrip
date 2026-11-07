import { describe, expect, it } from 'vitest'

import { sampleLearning } from '@/domain/samples'

import { approvedOf, initialReviewState, reviewReducer, type ReviewState } from './review-model'

const AT = '2026-11-08T10:00:00+09:00'
const loaded = (): ReviewState =>
  reviewReducer(initialReviewState, { type: 'load', learnings: [sampleLearning] })

describe('reviewReducer', () => {
  it('読み込んだ候補は、すべて未承認で、承認済みには含まれない', () => {
    const state = loaded()
    expect(state.learnings[0].approval).toEqual({ status: 'pending' })
    expect(approvedOf(state)).toEqual([])
  })

  it('承認すると承認済みになり、承認日時が付く', () => {
    const state = reviewReducer(loaded(), { type: 'approve', id: sampleLearning.id, decidedAt: AT })
    expect(approvedOf(state)).toHaveLength(1)
    expect(approvedOf(state)[0].approval).toEqual({ status: 'approved', decidedAt: AT })
  })

  it('却下した学びは、承認済みに含まれない。取り消すと未承認に戻る（承認にはならない）', () => {
    const rejected = reviewReducer(loaded(), {
      type: 'reject',
      id: sampleLearning.id,
      decidedAt: AT,
    })
    expect(rejected.learnings[0].approval.status).toBe('rejected')
    expect(approvedOf(rejected)).toEqual([])

    const reopened = reviewReducer(rejected, { type: 'reopen', id: sampleLearning.id })
    expect(reopened.learnings[0].approval).toEqual({ status: 'pending' })
    expect(approvedOf(reopened)).toEqual([])
  })

  it('承認後に内容を編集すると未承認に戻り、再承認を求める案内が出る', () => {
    const approved = reviewReducer(loaded(), {
      type: 'approve',
      id: sampleLearning.id,
      decidedAt: AT,
    })
    const edited = reviewReducer(approved, {
      type: 'edit',
      id: sampleLearning.id,
      edit: { content: '昼食の候補は2つ用意したい' },
    })

    expect(edited.learnings[0].content).toBe('昼食の候補は2つ用意したい')
    expect(edited.learnings[0].approval).toEqual({ status: 'pending' })
    expect(approvedOf(edited)).toEqual([])
    expect(edited.messages[sampleLearning.id]).toContain('もう一度')
  })

  it('適用範囲だけを変えた編集でも、未承認に戻る', () => {
    const approved = reviewReducer(loaded(), {
      type: 'approve',
      id: sampleLearning.id,
      decidedAt: AT,
    })
    const edited = reviewReducer(approved, {
      type: 'edit',
      id: sampleLearning.id,
      edit: { scope: { kind: 'all_trips' } },
    })
    expect(edited.learnings[0].scope).toEqual({ kind: 'all_trips' })
    expect(approvedOf(edited)).toEqual([])
  })

  it('空の内容への編集は拒否し、元の内容と承認状態を保つ（理由を案内する）', () => {
    const approved = reviewReducer(loaded(), {
      type: 'approve',
      id: sampleLearning.id,
      decidedAt: AT,
    })
    const edited = reviewReducer(approved, {
      type: 'edit',
      id: sampleLearning.id,
      edit: { content: '   ' },
    })
    expect(edited.learnings[0]).toEqual(approved.learnings[0])
    expect(approvedOf(edited)).toHaveLength(1)
    expect(edited.messages[sampleLearning.id]).toContain('入力')
  })

  it('存在しないIDへの操作は何も変えない', () => {
    const state = loaded()
    expect(reviewReducer(state, { type: 'approve', id: 'none', decidedAt: AT })).toBe(state)
  })

  it('不正な承認日時（タイムゾーンなし）では承認できない', () => {
    expect(() =>
      reviewReducer(loaded(), { type: 'approve', id: sampleLearning.id, decidedAt: '2026-11-08' }),
    ).toThrow()
  })
})
