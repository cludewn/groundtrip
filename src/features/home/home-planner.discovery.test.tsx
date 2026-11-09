// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import type { GenerateTrip } from '@/features/trip-planner/use-trip-generation'

import { noSavedLearnings } from '../../../tests/helpers/home-session'

import { HomePlanner } from './home-planner'

vi.mock(
  '@/lib/auth/use-session-scope',
  async () => (await import('../../../tests/helpers/home-session')).sessionScopeModule,
)

afterEach(cleanup)

it('写真テーマを既存フォームへ渡すが、選択や遷移だけでは生成を呼ばない', async () => {
  const generate = vi.fn<GenerateTrip>()
  const user = userEvent.setup()
  render(<HomePlanner showDiscoveryHome generate={generate} loadLearnings={noSavedLearnings} />)

  await user.click(screen.getByRole('button', { name: /城と歴史/ }))
  expect(generate).not.toHaveBeenCalled()
  await user.type(screen.getByLabelText('旅の希望（任意）'), '座って休める場所も入れたい')
  await user.click(screen.getByRole('button', { name: '旅の条件へ進む' }))

  expect(((await screen.findByLabelText('旅行先（必須）')) as HTMLInputElement).value).toBe(
    '名古屋市',
  )
  expect((screen.getByLabelText('希望条件（任意）') as HTMLTextAreaElement).value).toBe(
    '名古屋の歴史や街並みを楽しみたい\n座って休める場所も入れたい',
  )
  expect((screen.getByLabelText('日付（必須）') as HTMLInputElement).value).toBe('')
  expect(generate).not.toHaveBeenCalled()
})
