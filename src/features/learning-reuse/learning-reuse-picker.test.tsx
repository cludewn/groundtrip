// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sampleApprovedLearning, sampleLearning } from '@/domain/samples'
import { approveLearning } from '@/lib/learnings/lifecycle'
import type { LearningSelection } from '@/server/persistence/contracts'

import type { LearningLoadResult } from './api-client'
import { LearningReusePicker, type LoadLearningOptions } from './learning-reuse-picker'

afterEach(cleanup)

const approvedRegional = approveLearning(
  { ...sampleLearning, scope: { kind: 'region', region: '京都市' } },
  '2026-11-08T20:00:00+09:00',
)
// 版は学びごとに違う値にして、画面で見た版がそのまま返ることを確かめる。
const records = [
  { version: 2, learning: sampleApprovedLearning },
  { version: 3, learning: approvedRegional },
]
const ok: LearningLoadResult = { ok: true, items: records }
const loaded: LoadLearningOptions = async () => ok

describe('学びの選択UI', () => {
  it('すべての地域と同じ地域の学びだけを、画面に表示した版つきで選択できる', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    render(
      <LearningReusePicker region="京都市" load={loaded} onSelectionChange={onSelectionChange} />,
    )

    expect(await screen.findByText(approvedRegional.content)).toBeTruthy()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    await user.click(boxes[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith([{ id: approvedRegional.id, version: 3 }])
    await user.click(boxes[0])
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      { id: approvedRegional.id, version: 3 },
      { id: sampleApprovedLearning.id, version: 2 },
    ])
    await user.click(boxes[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      { id: sampleApprovedLearning.id, version: 2 },
    ])
  })

  it('地域が変わると古い選択を破棄し、地域外の学びを表示しない', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const view = render(
      <LearningReusePicker region="京都市" load={loaded} onSelectionChange={onSelectionChange} />,
    )
    await screen.findByText(approvedRegional.content)
    await user.click(screen.getAllByRole('checkbox')[1])
    view.rerender(
      <LearningReusePicker region="奈良市" load={loaded} onSelectionChange={onSelectionChange} />,
    )
    await waitFor(() => expect(screen.queryByText(approvedRegional.content)).toBeNull())
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(onSelectionChange).toHaveBeenLastCalledWith([])
  })

  it('APIが失敗したら、事前に選んでいた学びを持ち越さず、再試行後も未選択から始める', async () => {
    const onSelectionChange = vi.fn()
    const user = userEvent.setup()
    const load = vi
      .fn<LoadLearningOptions>()
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: '停止中です。' })
      .mockResolvedValueOnce(ok)
    const view = render(
      <LearningReusePicker region="京都市" load={load} onSelectionChange={onSelectionChange} />,
    )

    // 先に京都市で学びを選んでおく。
    await screen.findByText(approvedRegional.content)
    await user.click(screen.getAllByRole('checkbox')[0])
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      { id: sampleApprovedLearning.id, version: 2 },
    ])
    const callsBeforeFailure = onSelectionChange.mock.calls.length

    // 地域を変えた読み込みが失敗する。選択は空に戻り、学びは表示されない。
    view.rerender(
      <LearningReusePicker region="奈良市" load={load} onSelectionChange={onSelectionChange} />,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('停止中です。')
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    const afterFailure = onSelectionChange.mock.calls.slice(callsBeforeFailure)
    expect(afterFailure.length).toBeGreaterThan(0)
    expect(afterFailure.every(([selection]) => selection.length === 0)).toBe(true)

    // 再試行で取得できても、前の選択は戻らない。
    await user.click(screen.getByRole('button', { name: '再読み込み' }))
    await screen.findByText(sampleApprovedLearning.content)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(onSelectionChange).toHaveBeenLastCalledWith([])
  })

  it('地域外だけなら学びなしと明示する', async () => {
    const load: LoadLearningOptions = async () => ({
      ok: true,
      items: [{ version: 1, learning: approvedRegional }],
    })
    render(<LearningReusePicker region="奈良市" load={load} />)
    expect(await screen.findByText(/今回の地域に使える、承認済みの学びはありません/)).toBeTruthy()
  })

  it('地域の表記は完全一致だけを対象にすることを画面に示す', () => {
    render(<LearningReusePicker region="京都市" load={loaded} />)
    expect(screen.getByText(/旅行先の地域と同じ表記のものだけが表示されます/)).toBeTruthy()
  })
})

describe('地域の正規化', () => {
  it('前後に空白がある地域入力でも、同じ表記の地域限定の学びを選べる', async () => {
    const load = vi.fn<LoadLearningOptions>(loaded)
    const user = userEvent.setup()
    const onSelectionChange = vi.fn()
    render(
      <LearningReusePicker
        region={'  京都市　'}
        load={load}
        onSelectionChange={onSelectionChange}
      />,
    )
    expect(await screen.findByText(approvedRegional.content)).toBeTruthy()
    await user.click(screen.getAllByRole('checkbox')[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith([{ id: approvedRegional.id, version: 3 }])
  })

  it('空白だけが変わった入力では、読み込みも選択の破棄もやり直さない', async () => {
    const load = vi.fn<LoadLearningOptions>(loaded)
    const user = userEvent.setup()
    const view = render(<LearningReusePicker region="京都市" load={load} />)
    await screen.findByText(approvedRegional.content)
    await user.click(screen.getAllByRole('checkbox')[1])

    view.rerender(<LearningReusePicker region=" 京都市 " load={load} />)
    expect(load).toHaveBeenCalledTimes(1)
    expect((screen.getAllByRole('checkbox')[1] as HTMLInputElement).checked).toBe(true)
  })

  it('空白だけの地域は読み込まず、地域の入力を求める', async () => {
    const load = vi.fn<LoadLearningOptions>(loaded)
    render(<LearningReusePicker region={'  　'} load={load} />)
    expect((await screen.findByRole('alert')).textContent).toContain('地域を入力')
    expect(load).not.toHaveBeenCalled()
  })

  it('表記が違う地域（京都と京都市）の学びは、同じ地域として表示しない', async () => {
    render(<LearningReusePicker region="京都" load={loaded} />)
    await screen.findByText(sampleApprovedLearning.content)
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(screen.queryByText(approvedRegional.content)).toBeNull()
  })
})

describe('親コンポーネントとの連携', () => {
  // 読み込み関数をrenderごとに新しく作り、選択の通知でstateを更新する、典型的な親。
  // 通知のたびに再描画が連鎖すると読み込みを繰り返し続けるため、描画回数に上限を設けて、
  // ワーカーを固めずにテストを失敗させる。
  let renders = 0
  function InlineParent({ onLoad }: { onLoad: () => void }) {
    renders += 1
    if (renders > 50) throw new Error('再描画が繰り返されています')
    const [selection, setSelection] = useState<LearningSelection[]>([])
    return (
      <>
        <LearningReusePicker
          region="京都市"
          onSelectionChange={setSelection}
          load={async () => {
            onLoad()
            return ok
          }}
        />
        <output aria-label="親が受け取った件数">{selection.length}</output>
      </>
    )
  }

  it('読み込み関数が毎回新しくても、選択通知でstateを更新しても、読み込みを繰り返さない', async () => {
    renders = 0
    const user = userEvent.setup()
    const onLoad = vi.fn()
    render(<InlineParent onLoad={onLoad} />)

    expect(await screen.findByText(approvedRegional.content)).toBeTruthy()
    await user.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByLabelText('親が受け取った件数').textContent).toBe('1')
    expect(onLoad).toHaveBeenCalledTimes(1)
  })
})

describe('支援技術への通知とフォーカス', () => {
  it('状況表示の領域は最初から常設され、同じ要素の中身だけが入れ替わる', async () => {
    const user = userEvent.setup()
    render(<LearningReusePicker region="京都市" load={loaded} />)

    // 内容と同時に挿入される領域は読み上げられないことがあるため、読み込み前から存在する。
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('確認しています')

    await screen.findByText(approvedRegional.content)
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toContain('2件の学びから選べます')
    expect(status.textContent).toContain('現在0件を選択中')

    await user.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toContain('現在1件を選択中')
  })

  it('学びが無いときの案内も、同じ常設の領域に出す', async () => {
    render(<LearningReusePicker region="奈良市" load={async () => ({ ok: true, items: [] })} />)
    const status = screen.getByRole('status')
    await waitFor(() => expect(status.textContent).toContain('承認済みの学びはありません'))
    expect(screen.getByRole('status')).toBe(status)
  })

  it('再読み込みを押してボタンが消えても、フォーカスが文書の先頭へ落ちない', async () => {
    const user = userEvent.setup()
    let release: (result: LearningLoadResult) => void = () => undefined
    const load = vi
      .fn<LoadLearningOptions>()
      .mockResolvedValueOnce({ ok: false, kind: 'unavailable', message: '停止中です。' })
      .mockImplementationOnce(
        () =>
          new Promise<LearningLoadResult>((resolve) => {
            release = resolve
          }),
      )
    render(<LearningReusePicker region="京都市" load={load} />)

    const retry = await screen.findByRole('button', { name: '再読み込み' })
    await user.click(retry)

    // ボタンは読み込み中に消えるが、フォーカスは常設の状況表示へ移る。
    await waitFor(() => expect(screen.queryByRole('button', { name: '再読み込み' })).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('status'))
    expect(document.activeElement).not.toBe(document.body)

    release(ok)
    await screen.findByText(approvedRegional.content)
    expect(document.activeElement).not.toBe(document.body)
  })
})
