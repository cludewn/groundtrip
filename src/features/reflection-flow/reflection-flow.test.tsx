// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LearningSchema, type Learning, type Revision, type Trip } from '@/domain'
import { sampleRevision, sampleTrip } from '@/domain/samples'
import {
  ClientAuthError,
  getAuthHeaders,
  initializeAnonymousSession,
  startNewAnonymousSession,
} from '@/lib/auth/client'
import { ApproveLearningBodySchema, type VersionedLearning } from '@/server/persistence/contracts'

import { ReflectionFlow } from './reflection-flow'

// 認証（Firebase）だけを差し替える。LearningReview・api-client・保存ポートは、本物をつないで確かめる。
vi.mock('@/lib/auth/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/client')>()),
  getAuthHeaders: vi.fn(),
  initializeAnonymousSession: vi.fn(),
  startNewAnonymousSession: vi.fn(),
}))

// ---- 疑似バックエンド（fetchの差し替え）。サーバーの契約どおりに、旅程・履歴・学びを返す。 ----

interface Failure {
  status: number
  code: string
  message: string
}

interface BackendOptions {
  trips?: Trip[]
  revisions?: Revision[]
  learnings?: VersionedLearning[]
  candidates?: Learning[]
  // 学びIDごとに、承認APIを失敗させる。
  failApprove?: Record<string, Failure>
  // 指定すると、最初の「学びの一覧」の応答を、releaseFirstList()が呼ばれるまで保留し、この内容（古い内容）を返す。
  staleFirstList?: VersionedLearning[]
}

const emptyInfo = { skippedInvalid: 0, truncated: false }

function createBackend(options: BackendOptions = {}) {
  const trips = options.trips ?? [sampleTrip]
  const revisions = options.revisions ?? [sampleRevision]
  const stored = new Map((options.learnings ?? []).map((entry) => [entry.learning.id, entry]))
  const requests: string[] = []
  let releaseFirst: (() => void) | undefined
  let firstListHeld = false

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  const listOf = (entries: VersionedLearning[]) =>
    respond({ learnings: entries, listInfo: { returned: entries.length, ...emptyInfo } })

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    requests.push(method + ' ' + path)

    if (method === 'GET' && path === '/api/trips') {
      return respond({ trips, listInfo: { returned: trips.length, ...emptyInfo } })
    }
    const tripMatch = /^\/api\/trips\/([^/]+)(\/revisions)?$/.exec(path)
    if (method === 'GET' && tripMatch) {
      const tripId = decodeURIComponent(tripMatch[1])
      if (tripMatch[2]) {
        const list = revisions.filter((revision) => revision.tripId === tripId)
        return respond({ revisions: list, listInfo: { returned: list.length, ...emptyInfo } })
      }
      const trip = trips.find((candidate) => candidate.id === tripId)
      return trip
        ? respond({ trip })
        : respond({ error: { code: 'not_found', message: '旅程が見つかりません。' } }, 404)
    }
    if (method === 'GET' && path === '/api/learnings') {
      if (options.staleFirstList && !firstListHeld) {
        firstListHeld = true
        const stale = options.staleFirstList
        return new Promise<Response>((resolve) => {
          releaseFirst = () => resolve(listOf(stale))
        })
      }
      return listOf([...stored.values()])
    }
    if (method === 'POST' && path === '/api/learnings/candidates') {
      return respond({ status: 'proposed', learnings: options.candidates ?? [] })
    }
    const approveMatch = /^\/api\/learnings\/([^/]+)\/approve$/.exec(path)
    if (method === 'POST' && approveMatch) {
      const id = decodeURIComponent(approveMatch[1])
      const failure = options.failApprove?.[id]
      if (failure) {
        return respond({ error: { code: failure.code, message: failure.message } }, failure.status)
      }
      const body = ApproveLearningBodySchema.parse(JSON.parse(String(init?.body)))
      const current = stored.get(id)
      if ((current?.version ?? 0) !== body.expectedVersion) {
        return respond({ error: { code: 'version_conflict', message: '版が変わりました。' } }, 409)
      }
      const entry: VersionedLearning = {
        version: body.expectedVersion + 1,
        learning: {
          id,
          sourceTripId: body.sourceTripId,
          category: body.category,
          content: body.content,
          scope: body.scope,
          approval: { status: 'approved', decidedAt: '2026-11-08T10:00:00+09:00' },
        },
      }
      stored.set(id, entry)
      return respond(entry)
    }
    return respond({ error: { code: 'not_found', message: '見つかりません。' } }, 404)
  })

  return {
    fetchFn,
    requests,
    stored,
    releaseFirstList: () => releaseFirst?.(),
  }
}

// ---- 共通の準備 ----

const candidate = (id: string, content: string, scope: Learning['scope']): Learning =>
  LearningSchema.parse({
    id,
    sourceTripId: sampleTrip.id,
    category: 'preference',
    content,
    scope,
    approval: { status: 'pending' },
  })

const first = candidate('learning-first', '昼食後は休憩を長めに取る', { kind: 'all_trips' })
const second = candidate('learning-second', '朝の移動は短くする', {
  kind: 'region',
  region: sampleTrip.region,
})
const otherTrip: Trip = { ...sampleTrip, id: 'trip-other', region: '奈良市（別の旅行）' }

function useBackend(options: BackendOptions = {}) {
  const backend = createBackend(options)
  vi.stubGlobal('fetch', backend.fetchFn)
  return backend
}

type User = ReturnType<typeof userEvent.setup>

async function openTrip(user: User, label: string | RegExp = /振り返る/) {
  await user.click(await screen.findByRole('button', { name: label }))
  await screen.findByRole('button', { name: '学びの候補を作る' })
}

async function makeCandidates(user: User) {
  await user.type(screen.getByLabelText(/感想・変更した理由/), '昼食後は休みたかった')
  await user.click(screen.getByRole('button', { name: '学びの候補を作る' }))
  await screen.findByRole('heading', { name: /学びの候補（/ })
}

async function approveAll(user: User) {
  for (;;) {
    const buttons = screen.queryAllByRole('button', { name: '承認する' })
    if (buttons.length === 0) return
    await user.click(buttons[0])
  }
}

const saveButton = () => screen.getByRole('button', { name: /保存する|保存しています/ })
const saveStatus = () => screen.getByText(/^保存の状態/).parentElement?.textContent ?? ''
const savedSection = () =>
  screen.getByRole('heading', { name: '保存済みの学び' }).closest('section') as HTMLElement

beforeEach(() => {
  vi.mocked(getAuthHeaders).mockImplementation(async () => new Headers({ Authorization: '***' }))
  vi.mocked(initializeAnonymousSession).mockResolvedValue({ uid: 'user-1', isAnonymous: true })
  vi.mocked(startNewAnonymousSession).mockResolvedValue({ uid: 'new-user', isAnonymous: true })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ReflectionFlow：実際の画面・保存ポート・APIクライアントをつないだ動作', () => {
  it('承認→保存→保存済みの一覧に出る。保存後は、一覧を取り直した内容を表示する', async () => {
    const backend = useBackend({ candidates: [first, second] })
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user)
    await waitFor(() => {
      expect(within(savedSection()).getByText('保存済みの学びはありません。')).toBeTruthy()
    })
    // 保存済みの変更履歴を、学びの確認画面へ渡している。
    const history = screen.getByRole('heading', { name: '変更の履歴' }).parentElement as HTMLElement
    expect(within(history).getByText(sampleRevision.diff.after.name)).toBeTruthy()
    expect(within(history).queryByText('この旅程の変更履歴はありません。')).toBeNull()
    await makeCandidates(user)
    await approveAll(user)
    await user.click(saveButton())

    await waitFor(() => {
      expect(saveStatus()).toContain('保存済み（承認済みの学び2件）')
    })
    // 保存先へ、2件の承認が1件ずつ送られている。
    expect(backend.requests.filter((request) => request.includes('/approve'))).toEqual([
      'POST /api/learnings/learning-first/approve',
      'POST /api/learnings/learning-second/approve',
    ])
    // 保存後に一覧を取り直し、保存済みの学びとして表示する（内部IDではなく、旅行の地域と日付で示す）。
    const section = savedSection()
    await waitFor(() => {
      expect(within(section).getByText(first.content)).toBeTruthy()
    })
    expect(within(section).getByText(second.content)).toBeTruthy()
    expect(within(section).queryByText('保存済みの学びはありません。')).toBeNull()
    expect(within(section).getAllByText(/^元の旅行：/)[0].textContent).toBe(
      '元の旅行：' + sampleTrip.region + '（' + sampleTrip.date + '）',
    )
    expect(document.body.textContent).not.toContain('Firestore')
    expect(document.body.textContent).not.toContain(sampleTrip.id)
  })

  it('一部だけ保存できて失敗したとき、警告・状態行・保存済みの一覧が同じ事実を示す', async () => {
    useBackend({
      candidates: [first, second],
      failApprove: {
        [second.id]: { status: 409, code: 'storage_limit_reached', message: 'サーバーの文言' },
      },
    })
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user)
    await makeCandidates(user)
    await approveAll(user)
    await user.click(saveButton())

    const alert = await screen.findByText(/^保存できませんでした。/)
    // (a) 警告：1件は保存済み。上限のため残りは保存できず、再読み込みを案内しない。
    expect(alert.textContent).toContain('1件は保存済みです')
    expect(alert.textContent).toContain('上限に達しているため')
    expect(alert.textContent).toContain('結果は変わりません')
    expect(alert.textContent).not.toContain('再読み込み')
    expect(alert.textContent).not.toContain('もう一度、保存できます')
    // (b) 状態行：保存済みと未保存を分けて示す。
    expect(saveStatus()).toContain('2件のうち、1件は保存済み、1件は未保存です')
    // 承認済みの項目ごとの結果。
    const approvedList = screen.getByRole('heading', { name: /承認済みの学び（2件）/ })
      .parentElement as HTMLElement
    const items = within(approvedList).getAllByRole('listitem')
    expect(items.find((item) => item.textContent?.includes(first.content))?.textContent).toContain(
      '保存済み',
    )
    expect(items.find((item) => item.textContent?.includes(second.content))?.textContent).toContain(
      '未保存',
    )
    // (c) 保存済みの一覧：実際に保存できた1件が出る（「ありません」と矛盾しない）。
    const section = savedSection()
    await waitFor(() => {
      expect(within(section).getByText(first.content)).toBeTruthy()
    })
    expect(within(section).queryByText(second.content)).toBeNull()
    expect(within(section).queryByText('保存済みの学びはありません。')).toBeNull()
  })

  it('版の食い違いのときだけ「再読み込み」を案内し、消えるものも正直に伝える', async () => {
    useBackend({
      candidates: [first],
      failApprove: {
        [first.id]: { status: 409, code: 'version_conflict', message: 'サーバーの文言' },
      },
    })
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user)
    await makeCandidates(user)
    await approveAll(user)
    await user.click(saveButton())

    const alert = await screen.findByText(/^保存できませんでした。/)
    expect(alert.textContent).toContain('再読み込み')
    expect(alert.textContent).toContain('承認と入力した内容は消えます')
    expect(alert.textContent).not.toContain('もう一度、保存できます')
  })

  it('通信の失敗は、再試行すれば直る可能性があるものとして案内する', async () => {
    const backend = useBackend({ candidates: [first] })
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user)
    await makeCandidates(user)
    await approveAll(user)
    const original = backend.fetchFn.getMockImplementation()
    backend.fetchFn.mockImplementation(async (input, init) => {
      if (String(input).includes('/approve')) throw new TypeError('offline')
      return original!(input, init)
    })
    await user.click(saveButton())

    const alert = await screen.findByText(/^保存できませんでした。/)
    expect(alert.textContent).toContain('通信に失敗しました')
    expect(alert.textContent).toContain('もう一度、保存できます')
    expect(alert.textContent).not.toContain('再読み込み')
  })

  it('保存済みの学びの一覧は、遅れて届いた古い応答で新しい一覧を上書きしない', async () => {
    const savedEntry: VersionedLearning = {
      version: 1,
      learning: {
        id: 'learning-saved',
        sourceTripId: sampleTrip.id,
        category: 'preference',
        content: '保存済みの学び（最新）',
        scope: { kind: 'all_trips' },
        approval: { status: 'approved', decidedAt: '2026-11-01T18:00:00+09:00' },
      },
    }
    const backend = useBackend({ learnings: [savedEntry], staleFirstList: [] })
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user)
    // 最初の取得は保留中。ここで読み込み直すと、新しい一覧が先に届く。
    await user.click(screen.getByRole('button', { name: '保存済みの学びを読み込み直す' }))
    await waitFor(() => {
      expect(within(savedSection()).getByText(savedEntry.learning.content)).toBeTruthy()
    })
    // そのあとで、古い（空の）応答が届いても、表示は変わらない。
    await act(async () => {
      backend.releaseFirstList()
    })
    expect(within(savedSection()).getByText(savedEntry.learning.content)).toBeTruthy()
    expect(within(savedSection()).queryByText('保存済みの学びはありません。')).toBeNull()
  })
})

describe('ReflectionFlow：別の旅行へ切り替えるときの確認', () => {
  const twoTrips = { trips: [sampleTrip, otherTrip], candidates: [first] }

  it('未保存の承認済みがあるときは、確認するまで切り替えず、残る選択で元に戻れる', async () => {
    const backend = useBackend(twoTrips)
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user, /京都市/)
    await makeCandidates(user)
    await approveAll(user)
    const otherButton = screen.getByRole('button', { name: /奈良市/ })
    await user.click(otherButton)

    const group = screen.getByRole('group', { name: /まだ保存していない承認済みの学び/ })
    expect(group.textContent).toContain('奈良市（別の旅行）')
    expect(document.activeElement).toBe(group)
    // まだ切り替わっていない：履歴の読み込みもなく、確認中の候補と承認も残っている。
    expect(backend.requests).not.toContain('GET /api/trips/trip-other')
    expect(screen.getByText(/承認済みの学び（1件）/)).toBeTruthy()

    await user.click(within(group).getByRole('button', { name: 'この旅行に残る' }))
    expect(screen.queryByRole('group', { name: /まだ保存していない/ })).toBeNull()
    expect(document.activeElement).toBe(otherButton)
    expect(screen.getByText(/承認済みの学び（1件）/)).toBeTruthy()
    expect(backend.requests).not.toContain('GET /api/trips/trip-other')
  })

  it('保存せずに切り替えると選んだ旅行へ移る。Escで確認だけを閉じられる', async () => {
    const backend = useBackend(twoTrips)
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await openTrip(user, /京都市/)
    await makeCandidates(user)
    await approveAll(user)
    await user.click(screen.getByRole('button', { name: /奈良市/ }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: /まだ保存していない/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: /奈良市/ }))
    await user.click(screen.getByRole('button', { name: '保存せずに切り替える' }))
    await screen.findByRole('button', { name: '学びの候補を作る' })
    expect(backend.requests).toContain('GET /api/trips/trip-other')
    expect(screen.getByRole('button', { name: /奈良市/ }).getAttribute('aria-pressed')).toBe('true')
    // 前の旅行の候補・承認は混ざらない。
    expect(screen.queryByRole('heading', { name: /学びの候補（/ })).toBeNull()
    expect(screen.getByText('承認した学びはまだありません。')).toBeTruthy()
  })

  it('承認が無いとき、または全件を保存済みのときは、確認なしで切り替える', async () => {
    const backend = useBackend(twoTrips)
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    // 承認が無い。
    await openTrip(user, /京都市/)
    await user.click(screen.getByRole('button', { name: /奈良市/ }))
    expect(screen.queryByRole('group', { name: /まだ保存していない/ })).toBeNull()
    await waitFor(() => {
      expect(backend.requests).toContain('GET /api/trips/trip-other')
    })
    await screen.findByRole('button', { name: '学びの候補を作る' })

    // 承認して、保存まで終えた。
    await user.click(screen.getByRole('button', { name: /京都市/ }))
    await screen.findByRole('button', { name: '学びの候補を作る' })
    await makeCandidates(user)
    await approveAll(user)
    await user.click(saveButton())
    await waitFor(() => {
      expect(saveStatus()).toContain('保存済み（承認済みの学び1件）')
    })
    await waitFor(() => {
      expect(within(savedSection()).getByText(first.content)).toBeTruthy()
    })
    await user.click(screen.getByRole('button', { name: /奈良市/ }))
    expect(screen.queryByRole('group', { name: /まだ保存していない/ })).toBeNull()
  })
})

describe('ReflectionFlow：認証・読み込みの失敗', () => {
  it('利用できる認証状態が無いときだけ、説明のあとに「新しい利用を始める」を出す', async () => {
    useBackend()
    vi.mocked(initializeAnonymousSession).mockRejectedValue(new ClientAuthError('session_ended'))
    const user = userEvent.setup()
    render(<ReflectionFlow />)

    await screen.findByRole('alert')
    expect(startNewAnonymousSession).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: '新しい利用を始める' })
    // 影響の説明は、ボタンより前にあり、ボタンと結び付いている。
    const describedBy = button.getAttribute('aria-describedby')
    const warning = describedBy ? document.getElementById(describedBy) : null
    expect(warning?.textContent).toContain('戻れないことがあります')
    expect(warning!.closest('[hidden]')).toBeNull()
    expect(warning!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(button)
    await screen.findByRole('button', { name: /振り返る/ })
    expect(startNewAnonymousSession).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['認証サービスに接続できない', () => new ClientAuthError('unavailable')],
    ['認証の設定が不正', () => new ClientAuthError('configuration_error')],
  ])('%s場合は、新しい利用を始める操作を出さない', async (_name, makeError) => {
    useBackend()
    vi.mocked(initializeAnonymousSession).mockRejectedValue(makeError())
    render(<ReflectionFlow />)

    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: '新しい利用を始める' })).toBeNull()
    expect(screen.getByRole('button', { name: '再試行' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('自動作成しません')
  })

  it('保存機能の停止（503）・通信断・不正な応答でも、新しい利用を始める操作を出さない', async () => {
    const cases: Array<[string, () => Promise<Response>, string]> = [
      [
        '保存機能の停止',
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'persistence_disabled', message: '保存機能は現在利用できません。' },
            }),
            { status: 503 },
          ),
        '保存機能は現在利用できません。',
      ],
      [
        '通信断',
        async () => {
          throw new TypeError('offline')
        },
        '通信に失敗しました',
      ],
      ['不正な応答', async () => new Response(JSON.stringify({ trips: 'x' })), '想定外の応答'],
    ]
    for (const [, respond, expected] of cases) {
      vi.stubGlobal('fetch', vi.fn(respond))
      const view = render(<ReflectionFlow />)
      expect((await screen.findByRole('alert')).textContent).toContain(expected)
      expect(screen.queryByRole('button', { name: '新しい利用を始める' })).toBeNull()
      expect(startNewAnonymousSession).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it('保存した旅行がない場合は、架空サンプルを実データとして表示しない', async () => {
    useBackend({ trips: [] })
    render(<ReflectionFlow />)
    expect(await screen.findByText('保存された旅行がありません。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /振り返る/ })).toBeNull()
    expect(document.body.textContent).not.toContain('Firestore')
  })

  it('変更履歴が不完全なら、学びの候補の画面を開始しない', async () => {
    const backend = useBackend()
    const original = backend.fetchFn.getMockImplementation()
    backend.fetchFn.mockImplementation(async (input, init) =>
      String(input).endsWith('/revisions')
        ? new Response(
            JSON.stringify({
              revisions: [],
              listInfo: { returned: 0, skippedInvalid: 1, truncated: false },
            }),
          )
        : original!(input, init),
    )
    render(<ReflectionFlow initialTripId={sampleTrip.id} />)

    expect((await screen.findByText(/すべて確認できませんでした/)).textContent).toBeTruthy()
    expect(screen.queryByRole('button', { name: '学びの候補を作る' })).toBeNull()
    expect(screen.getByRole('button', { name: '読み込み直す' })).toBeTruthy()
  })

  it('保存済みの学びの取得が失敗したら、その理由を示し、保存できたようには見せない', async () => {
    const backend = useBackend()
    const original = backend.fetchFn.getMockImplementation()
    backend.fetchFn.mockImplementation(async (input, init) =>
      String(input) === '/api/learnings'
        ? new Response('<html>bad gateway</html>', { status: 502 })
        : original!(input, init),
    )
    const user = userEvent.setup()
    render(<ReflectionFlow />)
    await openTrip(user)

    await waitFor(() => {
      expect(within(savedSection()).getByRole('alert').textContent).toContain(
        '保存サービスに接続できませんでした',
      )
    })
    expect(within(savedSection()).queryByText('保存済みの学びはありません。')).toBeNull()
  })

  it('見出し構造：<main>を入れ子にせず、h1と振り返りのh2は別の言葉にする', async () => {
    useBackend()
    const user = userEvent.setup()
    const { container } = render(<ReflectionFlow />)
    await openTrip(user)

    expect(container.querySelector('main')).toBeNull()
    const h1 = screen.getByRole('heading', { level: 1 })
    const h2s = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(h2s).toContain('旅の振り返り')
    expect(h2s).not.toContain(h1.textContent)
    // 内部の言葉や版番号を、利用者向けの文言に出さない。
    expect(screen.getByRole('button', { name: /振り返る/ }).textContent).not.toMatch(/\d+版/)
    expect(container.textContent).toContain('保存された修正案は、すべて未承認です')
  })
})
