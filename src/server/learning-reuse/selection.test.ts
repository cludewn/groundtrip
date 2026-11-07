import { describe, expect, it } from 'vitest'

import type { ApprovedLearning } from '@/domain'
import { sampleApprovedLearning, sampleLearning } from '@/domain/samples'
import { approveLearning } from '@/lib/learnings/lifecycle'
import { InMemoryLearningStore } from '@/server/learnings/store'

import { LearningSelectionError, resolveSelectedLearnings } from './selection'

const date = '2026-11-08T20:00:00+09:00'
const region = '京都市・東山'
const scoped = approveLearning({ ...sampleLearning, scope: { kind: 'region', region } }, date)
const anotherRegion = approveLearning(
  { ...sampleLearning, id: 'learning-nara', scope: { kind: 'region', region: '奈良市' } },
  date,
)

async function setup() {
  const store = new InMemoryLearningStore()
  await store.saveApproved('user-a', sampleApprovedLearning)
  await store.saveApproved('user-a', scoped)
  await store.saveApproved('user-a', anotherRegion)
  await store.saveApproved('user-b', {
    ...sampleApprovedLearning,
    id: 'other-user-only',
  })
  return store
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  return error instanceof LearningSelectionError ? error.code : undefined
}

describe('次回旅程に使う学びのサーバー側解決', () => {
  it('UIDと地域に一致する承認済み学びを、利用者の選択順で返す', async () => {
    const store = await setup()
    const actual = await resolveSelectedLearnings(store, 'user-a', region, [
      scoped.id,
      sampleApprovedLearning.id,
    ])
    expect(actual.map((item) => item.id)).toEqual([scoped.id, sampleApprovedLearning.id])
  })

  it('他人の学び・別地域・撤回・存在しない選択IDを拒否する', async () => {
    const store = await setup()
    expect(
      await codeOf(resolveSelectedLearnings(store, 'user-a', region, ['other-user-only'])),
    ).toBe('selection_changed')
    expect(
      await codeOf(resolveSelectedLearnings(store, 'user-a', region, [anotherRegion.id])),
    ).toBe('selection_changed')
    await store.remove('user-a', scoped.id)
    expect(await codeOf(resolveSelectedLearnings(store, 'user-a', region, [scoped.id]))).toBe(
      'selection_changed',
    )
    expect(await codeOf(resolveSelectedLearnings(store, 'user-a', region, ['missing']))).toBe(
      'selection_changed',
    )
  })

  it('重複ID・不正な所有者・空の地域を拒否する', async () => {
    const store = await setup()
    expect(await codeOf(resolveSelectedLearnings(store, 'user-a', region, ['x', 'x']))).toBe(
      'invalid_selection',
    )
    expect(await codeOf(resolveSelectedLearnings(store, '', region, []))).toBe('invalid_selection')
    expect(await codeOf(resolveSelectedLearnings(store, 'user-a', '  ', []))).toBe(
      'invalid_selection',
    )
  })

  it('空選択は何も適用しない', async () => {
    const store = await setup()
    expect(await resolveSelectedLearnings(store, 'user-a', region, [])).toEqual([])
  })

  it('ストアが未承認を混入させても選択できない', async () => {
    const unapproved = { ...sampleApprovedLearning, approval: { status: 'pending' } }
    const store = {
      listApproved: async (): Promise<ApprovedLearning[]> => [unapproved as ApprovedLearning],
    }
    expect(
      await codeOf(resolveSelectedLearnings(store, 'user-a', region, [sampleApprovedLearning.id])),
    ).toBe('selection_changed')
  })
})
