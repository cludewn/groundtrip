import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sampleApprovedLearning, sampleRevision, sampleTrip } from '@/domain/samples'
import { ClientAuthError, getAuthHeaders } from '@/lib/auth/client'

import {
  createFirestoreLearningStore,
  loadReflectionHistory,
  loadSavedLearnings,
  loadSavedTrips,
  ReflectionApiError,
} from './api-client'

vi.mock('@/lib/auth/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/client')>()),
  getAuthHeaders: vi.fn(),
}))

const listInfo = { returned: 0, skippedInvalid: 0, truncated: false }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
// プロキシなどが返す、JSONではないエラー応答。
const html = (status: number) =>
  new Response('<html><body>error</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  })
const failure = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status)
const learningList = (...entries: Array<{ version: number; learning: unknown }>) =>
  json({ learnings: entries, listInfo: { ...listInfo, returned: entries.length } })

const second = { ...sampleApprovedLearning, id: 'learning-second', content: '次は休憩を多めに' }
const approveCalls = (fetchFn: ReturnType<typeof vi.fn>) =>
  fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/approve'))

beforeEach(() => {
  vi.mocked(getAuthHeaders).mockReset()
  vi.mocked(getAuthHeaders).mockImplementation(
    async () => new Headers({ Authorization: 'Bearer test-token' }),
  )
})

describe('振り返りの保存済みデータ取得', () => {
  it('認証済みの旅程だけを取得し、認証トークンは送るが再利用できるキャッシュには載せない', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(json({ trips: [sampleTrip], listInfo: { ...listInfo, returned: 1 } }))
    const result = await loadSavedTrips({ fetchFn })
    expect(result.trips).toEqual([sampleTrip])
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/trips')
    expect(init.headers.get('Authorization')).toBe('Bearer test-token')
    expect(init.cache).toBe('no-store')
  })

  describe('旅程と変更履歴の整合', () => {
    const serve = (overrides: { trip?: unknown; revisions?: unknown; info?: object } = {}) =>
      vi.fn().mockImplementation(async (path: string) =>
        path.endsWith('/revisions')
          ? json({
              revisions: overrides.revisions ?? [sampleRevision],
              listInfo: { ...listInfo, returned: 1, ...overrides.info },
            })
          : json({ trip: overrides.trip ?? sampleTrip }),
      )

    it('旅程と変更履歴の両方が揃って初めて振り返りに渡す', async () => {
      const fetchFn = serve()
      const history = await loadReflectionHistory(sampleTrip.id, { fetchFn })
      expect(history.trip).toEqual(sampleTrip)
      expect(history.revisions).toEqual([sampleRevision])
    })

    it('履歴が打ち切られている場合は学び作成に使わない', async () => {
      const fetchFn = serve({ revisions: [], info: { truncated: true } })
      await expect(loadReflectionHistory(sampleTrip.id, { fetchFn })).rejects.toThrow(
        'すべて確認できませんでした',
      )
    })

    it('履歴に読み取れなかった項目がある場合は学び作成に使わない', async () => {
      const fetchFn = serve({ info: { skippedInvalid: 1 } })
      await expect(loadReflectionHistory(sampleTrip.id, { fetchFn })).rejects.toThrow(
        'すべて確認できませんでした',
      )
    })

    it('要求した旅程と別の旅程が返ってきたら使わない', async () => {
      const fetchFn = serve({ trip: { ...sampleTrip, id: 'trip-someone-else' } })
      await expect(loadReflectionHistory(sampleTrip.id, { fetchFn })).rejects.toThrow(
        'すべて確認できませんでした',
      )
    })

    it('別の旅程の変更履歴が混ざっていたら使わない', async () => {
      const fetchFn = serve({ revisions: [{ ...sampleRevision, tripId: 'trip-someone-else' }] })
      await expect(loadReflectionHistory(sampleTrip.id, { fetchFn })).rejects.toThrow(
        'すべて確認できませんでした',
      )
    })
  })
})

describe('認証とHTTPエラーの扱い', () => {
  it('認証トークンが取得できないときはリクエストせず、新しい匿名UIDを自動作成しない', async () => {
    const authError = new ClientAuthError('session_ended')
    vi.mocked(getAuthHeaders).mockRejectedValue(authError)
    const fetchFn = vi.fn()
    // 認証エラーは包み直さず、そのまま画面へ渡す（画面が「新しい利用」の要否を判断する）。
    await expect(loadSavedTrips({ fetchFn })).rejects.toBe(authError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('トークンを送って401が返ったときは、ステータス・コード・サーバーの文言を保つ', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(failure('session_revoked', '認証を継続できません。再認証が必要です', 401))
    const error = await loadSavedTrips({ fetchFn }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ReflectionApiError)
    expect(error).toMatchObject({
      status: 401,
      code: 'session_revoked',
      message: '認証を継続できません。再認証が必要です',
    })
    expect(fetchFn.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer test-token')
  })

  it('401の本文が読めないときも、認証の案内を使う', async () => {
    const fetchFn = vi.fn().mockResolvedValue(html(401))
    const error = await loadSavedLearnings({ fetchFn }).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 401 })
    expect((error as Error).message).toContain('認証')
    expect((error as Error).message).not.toContain('想定外')
  })

  it.each([
    [503, '保存機能は現在利用できません'],
    [502, '保存サービスに接続できませんでした'],
    [504, '保存サービスに接続できませんでした'],
    [409, 'ほかの操作で更新されました'],
    [500, '取得・更新できませんでした'],
  ])(
    'JSONではない%i応答でも、ステータスに合う案内を使う（想定外の応答にしない）',
    async (status, text) => {
      const fetchFn = vi.fn().mockResolvedValue(html(status))
      const error = await loadSavedTrips({ fetchFn }).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ status })
      expect((error as Error).message).toContain(text)
      expect((error as Error).message).not.toContain('想定外')
    },
  )

  it('成功のステータスなのに本文がJSONでない、または契約に合わないときは想定外の応答とする', async () => {
    for (const response of [html(200), json({ trips: 'x' })]) {
      const fetchFn = vi.fn().mockResolvedValue(response)
      const error = await loadSavedTrips({ fetchFn }).catch((reason: unknown) => reason)
      expect(error).toMatchObject({ status: 200 })
      expect((error as Error).message).toContain('想定外の応答')
    }
  })

  it('通信そのものが失敗したときは、通信の失敗として案内する', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(loadSavedTrips({ fetchFn })).rejects.toThrow('通信に失敗しました')
  })

  it('中止済みの信号ではリクエストしない', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi.fn()
    await expect(loadSavedTrips({ fetchFn, signal: controller.signal })).rejects.toThrow(
      '通信に失敗しました',
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('応答を待つ間に中止されたら、届いた応答を採用しない', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn().mockImplementation(async () => {
      controller.abort()
      return json({ trips: [sampleTrip], listInfo: { ...listInfo, returned: 1 } })
    })
    await expect(loadSavedTrips({ fetchFn, signal: controller.signal })).rejects.toThrow(
      '通信に失敗しました',
    )
  })
})

describe('承認済み学びのFirestore保存', () => {
  it('本人が承認した学びをexpectedVersion=0で新規保存する', async () => {
    const fetchFn = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/api/learnings') return json({ learnings: [], listInfo })
      return json({ version: 1, learning: sampleApprovedLearning })
    })
    const onSaved = vi.fn()
    const store = createFirestoreLearningStore(onSaved, fetchFn)
    expect(await store.save([sampleApprovedLearning])).toEqual({ ok: true })
    expect(onSaved).toHaveBeenCalledTimes(1)

    const [url, init] = fetchFn.mock.calls[1]
    expect(url).toBe('/api/learnings/learning-rest/approve')
    expect(init.method).toBe('POST')
    expect(init.headers.get('Authorization')).toBe('Bearer test-token')
    expect(JSON.parse(init.body)).toEqual({
      expectedVersion: 0,
      sourceTripId: sampleApprovedLearning.sourceTripId,
      category: sampleApprovedLearning.category,
      content: sampleApprovedLearning.content,
      scope: sampleApprovedLearning.scope,
    })
    expect(JSON.parse(init.body)).not.toHaveProperty('approval')
  })

  it('保存済みなら同じ内容を再送信せず、内容を変えたときだけ版を更新する', async () => {
    const updated = { ...sampleApprovedLearning, content: '次回は歩く距離を短くする' }
    const fetchFn = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path === '/api/learnings'
          ? learningList({ version: 4, learning: sampleApprovedLearning })
          : json({ version: 5, learning: updated }),
      )
    const store = createFirestoreLearningStore(undefined, fetchFn)
    expect(await store.save([sampleApprovedLearning])).toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(await store.save([updated])).toEqual({ ok: true })
    expect(JSON.parse(fetchFn.mock.calls[2][1].body).expectedVersion).toBe(4)
  })

  it('適用範囲だけを変えたときも、変更として版を更新する', async () => {
    const regional = {
      ...sampleApprovedLearning,
      scope: { kind: 'region' as const, region: sampleTrip.region },
    }
    const fetchFn = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path === '/api/learnings'
          ? learningList({ version: 2, learning: sampleApprovedLearning })
          : json({ version: 3, learning: regional }),
      )
    const store = createFirestoreLearningStore(undefined, fetchFn)
    expect(await store.save([sampleApprovedLearning])).toEqual({ ok: true })
    expect(await store.save([regional])).toEqual({ ok: true })
    const [call] = approveCalls(fetchFn)
    expect(JSON.parse(call[1].body)).toMatchObject({ expectedVersion: 2, scope: regional.scope })
  })

  it('適用範囲の項目の並び順が違っても、同じ内容なら再送信しない', async () => {
    const regional = { kind: 'region' as const, region: sampleTrip.region }
    const saved = { ...sampleApprovedLearning, scope: regional }
    // 保存先と画面で、オブジェクトのキーの並びが違っても同じ学びとして扱う。
    const reordered = {
      ...sampleApprovedLearning,
      scope: { region: sampleTrip.region, kind: 'region' as const },
    }
    expect(Object.keys(reordered.scope)).not.toEqual(Object.keys(saved.scope))
    const fetchFn = vi.fn().mockResolvedValue(learningList({ version: 3, learning: saved }))
    const result = await createFirestoreLearningStore(undefined, fetchFn).save([reordered])
    expect(result).toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  describe('一部だけ成功したとき', () => {
    const setup = () => {
      let firstSaved = false
      let failed = false
      const fetchFn = vi.fn().mockImplementation(async (path: string) => {
        if (path === '/api/learnings') {
          return learningList(
            ...(firstSaved ? [{ version: 1, learning: sampleApprovedLearning }] : []),
          )
        }
        if (path.endsWith('/learning-rest/approve')) {
          firstSaved = true
          return json({ version: 1, learning: sampleApprovedLearning })
        }
        if (!failed) {
          failed = true
          return failure('storage_unavailable', '保存できません', 503)
        }
        return json({ version: 1, learning: second })
      })
      const onSaved = vi.fn()
      return { fetchFn, onSaved, store: createFirestoreLearningStore(onSaved, fetchFn) }
    }

    it('全件成功とせず、保存できた学びのIDを返す。保存済みの一覧を取り直せるよう通知する', async () => {
      const { store, onSaved } = setup()
      const result = await store.save([sampleApprovedLearning, second])
      expect(result).toMatchObject({
        ok: false,
        savedIds: [sampleApprovedLearning.id],
        retryable: true,
      })
      if (!result.ok) {
        expect(result.message).toContain('1件は保存済みです')
        expect(result.message).toContain('保存できません')
      }
      // 失敗でも、1件でも保存できていれば、画面が一覧を取り直せるよう知らせる。
      expect(onSaved).toHaveBeenCalledTimes(1)
    })

    it('次回は成功済みの学びを再取得し、残りだけを保存する', async () => {
      const { store, onSaved, fetchFn } = setup()
      await store.save([sampleApprovedLearning, second])
      expect(await store.save([sampleApprovedLearning, second])).toEqual({ ok: true })
      expect(onSaved).toHaveBeenCalledTimes(2)
      expect(
        approveCalls(fetchFn).filter(([url]) => String(url).endsWith('/learning-rest/approve')),
      ).toHaveLength(1)
    })

    it('1件も保存できなかったときは、保存済みの一覧を取り直す通知をしない', async () => {
      const onSaved = vi.fn()
      const fetchFn = vi
        .fn()
        .mockImplementation(async (path: string) =>
          path === '/api/learnings'
            ? learningList()
            : failure('storage_unavailable', '保存できません', 503),
        )
      const result = await createFirestoreLearningStore(onSaved, fetchFn).save([
        sampleApprovedLearning,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [], retryable: true })
      if (!result.ok) expect(result.message).not.toContain('件は保存済み')
      expect(onSaved).not.toHaveBeenCalled()
    })
  })

  describe('保存できない理由に合わせた案内', () => {
    const failWith = async (code: string, message: string, status: number) => {
      const fetchFn = vi
        .fn()
        .mockImplementation(async (path: string) =>
          path === '/api/learnings' ? learningList() : failure(code, message, status),
        )
      return createFirestoreLearningStore(undefined, fetchFn).save([sampleApprovedLearning])
    }

    it('版の食い違い（409）：再読み込みを案内し、承認と入力が消えることも伝える', async () => {
      const result = await failWith('version_conflict', '版が一致しません', 409)
      expect(result).toMatchObject({ ok: false, retryable: false, savedIds: [] })
      if (!result.ok) {
        expect(result.message).toContain('再読み込み')
        expect(result.message).toContain('消えます')
      }
    })

    it('同じIDがすでにある（409）：再読み込みを案内する', async () => {
      const result = await failWith('already_exists', '同じIDがあります', 409)
      expect(result).toMatchObject({ ok: false, retryable: false })
      if (!result.ok) expect(result.message).toContain('再読み込み')
    })

    it('件数の上限（409）：保存できない理由を言い切り、再読み込みも再試行も案内しない', async () => {
      const result = await failWith('storage_limit_reached', '上限です', 409)
      expect(result).toMatchObject({ ok: false, retryable: false, savedIds: [] })
      if (!result.ok) {
        expect(result.message).toContain('上限に達している')
        expect(result.message).toContain('結果は変わりません')
        expect(result.message).not.toContain('再読み込み')
      }
    })

    it('撤回済みの学び（409）：保存できない理由と、候補を作り直す案内を示す', async () => {
      const result = await failWith('learning_revoked', '撤回済みです', 409)
      expect(result).toMatchObject({ ok: false, retryable: false })
      if (!result.ok) {
        expect(result.message).toContain('撤回済み')
        expect(result.message).toContain('作り直して')
        expect(result.message).not.toContain('再読み込み')
      }
    })

    it('保存サービスの停止（503）：サーバーの案内を使い、再試行できるものとして扱う', async () => {
      const result = await failWith('storage_unavailable', '保存サービスを利用できません', 503)
      expect(result).toMatchObject({ ok: false, retryable: true })
      if (!result.ok) {
        expect(result.message).toBe('保存サービスを利用できません')
      }
    })

    it('認証の失効（401）：サーバーの案内を使い、成功とも再読み込みの案内ともしない', async () => {
      const result = await failWith('session_revoked', '認証を継続できません', 401)
      expect(result).toMatchObject({ ok: false, retryable: true })
      if (!result.ok) {
        expect(result.message).toBe('認証を継続できません')
      }
    })

    it('JSONではない503（プロキシのHTML）でも、想定外の応答ではなく保存停止の案内を使う', async () => {
      const fetchFn = vi
        .fn()
        .mockImplementation(async (path: string) =>
          path === '/api/learnings' ? learningList() : html(503),
        )
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([
        sampleApprovedLearning,
      ])
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) {
        expect(result.message).toContain('保存機能は現在利用できません')
        expect(result.message).not.toContain('想定外')
      }
    })
  })

  describe('誤った保存を防ぐ検査', () => {
    it('承認された学びが0件なら、通信しない', async () => {
      const fetchFn = vi.fn()
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([])
      expect(result).toMatchObject({ ok: false })
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('同じIDの学びが重複して渡されたら、通信しない', async () => {
      const fetchFn = vi.fn()
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([
        sampleApprovedLearning,
        { ...sampleApprovedLearning, content: '別の内容' },
      ])
      expect(result).toMatchObject({ ok: false })
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('承認済みの形式ではない学び（本人の承認がない）は、通信しない', async () => {
      const fetchFn = vi.fn()
      const notApproved = { ...sampleApprovedLearning, approval: { status: 'pending' } }
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([
        notApproved as unknown as typeof sampleApprovedLearning,
      ])
      expect(result).toMatchObject({ ok: false })
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('保存済みの一覧が不完全（読み取れない項目あり）なら、新しい書き込みを行わない', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(json({ learnings: [], listInfo: { ...listInfo, skippedInvalid: 1 } }))
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([
        sampleApprovedLearning,
      ])
      expect(result).toMatchObject({ ok: false })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('保存済みの一覧が打ち切られているときも、新しい書き込みを行わない', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(json({ learnings: [], listInfo: { ...listInfo, truncated: true } }))
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([
        sampleApprovedLearning,
      ])
      expect(result).toMatchObject({ ok: false })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('初めて見た既存IDの内容を、本人確認なく上書きしない', async () => {
      const different = { ...sampleApprovedLearning, content: '別の内容へ更新したい' }
      const fetchFn = vi
        .fn()
        .mockResolvedValue(learningList({ version: 4, learning: sampleApprovedLearning }))
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([different])
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('一度確認した版が別端末で変更されたら古い内容で上書きしない', async () => {
      let remoteVersion = 4
      const edited = { ...sampleApprovedLearning, content: '休憩を増やしたい' }
      const fetchFn = vi.fn().mockImplementation(async () =>
        learningList({
          version: remoteVersion,
          learning:
            remoteVersion === 4
              ? sampleApprovedLearning
              : { ...sampleApprovedLearning, content: '別端末で更新した文章' },
        }),
      )
      const store = createFirestoreLearningStore(undefined, fetchFn)
      expect(await store.save([sampleApprovedLearning])).toEqual({ ok: true })
      remoteVersion = 5
      const result = await store.save([edited])
      expect(result).toMatchObject({ ok: false, retryable: false })
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('別の旅程で使われている学びIDと重複したら、書き込まない', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        learningList({
          version: 2,
          learning: { ...sampleApprovedLearning, sourceTripId: 'trip-someone-else' },
        }),
      )
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([
        sampleApprovedLearning,
      ])
      expect(result).toMatchObject({ ok: false, retryable: false, savedIds: [] })
      if (!result.ok) expect(result.message).toContain('別の旅行で使われている')
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('同じIDで分類（category）が違う学びとも、書き込まない', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        learningList({
          version: 2,
          learning: { ...sampleApprovedLearning, category: 'verification' },
        }),
      )
      const result = await createFirestoreLearningStore(undefined, fetchFn).save([
        sampleApprovedLearning,
      ])
      // 版の食い違いではなく、別の学びとのIDの重複として止める。
      expect(result).toMatchObject({ ok: false, retryable: false })
      if (!result.ok) expect(result.message).toContain('別の旅行で使われている')
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('保存先が返した内容が、送った内容と違うときは、保存できたとしない', async () => {
      const onSaved = vi.fn()
      const fetchFn = vi.fn().mockImplementation(async (path: string) =>
        path === '/api/learnings'
          ? learningList()
          : json({
              version: 1,
              learning: { ...sampleApprovedLearning, content: '送っていない別の内容' },
            }),
      )
      const result = await createFirestoreLearningStore(onSaved, fetchFn).save([
        sampleApprovedLearning,
        second,
      ])
      expect(result).toMatchObject({ ok: false, savedIds: [] })
      if (!result.ok) expect(result.message).toContain('想定外の応答')
      // 1件目で止まり、2件目は送らない。保存できた学びが無いので、一覧の取り直しも通知しない。
      expect(approveCalls(fetchFn)).toHaveLength(1)
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('通信の応答を受けた直後に中止されたら、その応答を保存済みに数えず、残りも送らない', async () => {
      const controller = new AbortController()
      const onSaved = vi.fn()
      const fetchFn = vi.fn().mockImplementation(async (path: string) => {
        if (path === '/api/learnings') {
          // 2件目はすでに同じ内容で保存されている（通信なしで「保存済み」と数えられる項目）。
          return learningList({ version: 1, learning: second })
        }
        controller.abort()
        return json({ version: 1, learning: sampleApprovedLearning })
      })
      const result = await createFirestoreLearningStore(onSaved, fetchFn).save(
        [sampleApprovedLearning, second],
        { signal: controller.signal },
      )
      expect(result).toMatchObject({ ok: false, savedIds: [] })
      if (!result.ok) expect(result.message).toContain('通信に失敗しました')
      expect(approveCalls(fetchFn)).toHaveLength(1)
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('通信が要らない項目の処理でも中止を確認し、中止後に成功を返さない', async () => {
      // 一覧の取得（通信の前後の確認）を通り抜けたあと、最初の項目の処理で中止に切り替わる信号。
      let reads = 0
      const signal = {
        get aborted() {
          reads += 1
          return reads >= 3
        },
      } as AbortSignal
      const fetchFn = vi
        .fn()
        .mockResolvedValue(learningList({ version: 1, learning: sampleApprovedLearning }))
      const result = await createFirestoreLearningStore(undefined, fetchFn).save(
        [sampleApprovedLearning],
        { signal },
      )
      expect(result).toMatchObject({ ok: false, savedIds: [] })
      if (!result.ok) expect(result.message).toContain('通信に失敗しました')
    })
  })
})
