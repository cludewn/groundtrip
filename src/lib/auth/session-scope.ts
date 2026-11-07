'use client'

import { getAuthSnapshot } from './client'

// データを取得・表示・編集した時点の認証セッションを表す不変の値。
// 取得した画面は、この値を結果と一緒に保持し、保存・生成の送信前に現在のセッションと照合する。
// Firebaseのトークンやユーザーオブジェクトは持たない。UIDだけで識別する。
export type SessionScope = Readonly<{ uid: string }>

// 取得したデータに、それを取得したセッションを結び付けて保持するための型。
// 同じIDとversionでも、別UIDのスコープのデータとは別物として扱える。
export type ScopedValue<T> = Readonly<{ scope: SessionScope; value: T }>

// 取得時と現在でUIDが違う。前のセッションのデータを新しいUIDで使ってはいけない。
// 利用側は表示・編集・選択・進行中の読み込みを破棄し、操作を失敗として扱う。
export class SessionChangedError extends Error {
  readonly code = 'session_changed' as const

  constructor() {
    super(
      '認証セッションが変わりました。前のセッションのデータは使えません。読み込み直してください',
    )
    this.name = 'SessionChangedError'
  }
}

// UIDからスコープを作る。作成後は変更できない。
export function createSessionScope(uid: string): SessionScope {
  return Object.freeze({ uid })
}

// 現在のセッションのスコープを取る。復元失敗・セッション終了では匿名アカウントを作らず、ClientAuthErrorで失敗する。
export async function captureSessionScope(): Promise<SessionScope> {
  const { uid } = await getAuthSnapshot()
  return createSessionScope(uid)
}

export function isSameScope(a: SessionScope, b: SessionScope): boolean {
  return a.uid === b.uid
}

// 取得時のスコープが現在のスコープと同じであることを確認する。違えばSessionChangedErrorを投げる。
export function assertSameScope<T>(scoped: ScopedValue<T>, current: SessionScope): void {
  if (!isSameScope(scoped.scope, current)) throw new SessionChangedError()
}

// 取得時のスコープと同じセッションのときだけ、認証ヘッダーを返す（失敗時は閉じる）。
// UIDとトークンは同じUserから同時に取るため、UIDの確認とトークンが食い違わない。
// UIDが違えばSessionChangedErrorを投げ、新しいUIDのトークンを呼び出し側へ渡さない。
// セッション終了・取得失敗はClientAuthErrorのまま伝え、匿名アカウントの再作成も再送もしない。
export async function getAuthHeadersForScope(scope: SessionScope): Promise<Headers> {
  const { uid, token } = await getAuthSnapshot()
  if (uid !== scope.uid) throw new SessionChangedError()
  return new Headers({ Authorization: `Bearer ${token}` })
}
