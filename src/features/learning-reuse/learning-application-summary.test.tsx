// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { sampleApprovedLearning, sampleTrip } from '@/domain/samples'

import { LearningApplicationSummary } from './learning-application-summary'

afterEach(cleanup)

describe('次回旅程への学びの適用記録', () => {
  it('生成結果の適用先と説明だけを表示し、因果効果を断定しない', () => {
    render(<LearningApplicationSummary trip={sampleTrip} learnings={[sampleApprovedLearning]} />)

    expect(screen.getByText(sampleApprovedLearning.content)).toBeTruthy()
    expect(screen.getByText('対象：昼食店A（架空）')).toBeTruthy()
    expect(
      screen.getByText('昼食と休憩のため滞在時間を60分から75分にした（架空の適用例）'),
    ).toBeTruthy()
    expect(screen.getByText(/学びだけによるものだとは断定できません/)).toBeTruthy()
  })

  it('対応する承認済み学びがなければ、適用したとは表示しない', () => {
    render(<LearningApplicationSummary trip={sampleTrip} learnings={[]} />)

    expect(screen.getByText(/この旅程には、選んだ学びの適用記録がありません/)).toBeTruthy()
    expect(screen.queryByText(sampleApprovedLearning.content)).toBeNull()
  })
})
