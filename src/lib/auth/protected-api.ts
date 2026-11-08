'use client'

import type { FirebaseApp } from 'firebase/app'
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check'

import { getClientAuth } from '../firebase/client'
import { getAuthHeaders } from './client'
import { AppCheckUnavailableError } from './protected-api-errors'
import {
  beginSessionScopeOperation,
  getAuthHeadersForScope,
  type SessionScope,
} from './session-scope'

// 匿名利用と審査用ログインは別のFirebaseアプリを使うため、App Checkもアプリ単位で初期化する。
const appChecks = new WeakMap<FirebaseApp, AppCheck>()

// #60のアクセス券交換では、デモ用Firebaseアプリを引数に渡してBearer取得前にApp Checkを行う。
// #63と同じ分類で失敗させ、SDKの生のエラーをクライアントに返さない。
export async function getAppCheckToken(app: FirebaseApp = getClientAuth().app): Promise<string> {
  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY?.trim()
  if (!siteKey) throw new AppCheckUnavailableError('config_missing')
  try {
    let appCheck = appChecks.get(app)
    if (!appCheck) {
      appCheck = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: false,
      })
      appChecks.set(app, appCheck)
    }
    return (await getToken(appCheck)).token
  } catch {
    throw new AppCheckUnavailableError('token_failed')
  }
}

// 課金・保存APIへの同一オリジン要求に、本人のBearerとApp Checkを付ける。
// スコープを渡した場合は旧認証セッションのトークン送信を防ぐ。
export async function getProtectedApiHeaders(scope?: SessionScope): Promise<Headers> {
  const token = await getAppCheckToken()
  const headers = scope ? await getAuthHeadersForScope(scope) : await getAuthHeaders()
  headers.set('X-Firebase-AppCheck', token)
  return headers
}

// #63の明示的なスコープ付きAPIを維持し、#60のrunProtectedSessionと実装を共通化する。
export async function getProtectedApiHeadersForScope(scope: SessionScope): Promise<Headers> {
  return getProtectedApiHeaders(scope)
}

// #60: 画面に結び付いた認証世代でのみ送信・応答採用する。
// pagehide/BFCacheで中断し、送信済み処理は結果不明として旧画面へ反映しない。
export async function runProtectedSession<T>(
  scope: SessionScope,
  signal: AbortSignal | undefined,
  run: (fetchFn: typeof fetch, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const operation = beginSessionScopeOperation(scope, signal)
  const controller = new AbortController()
  const onPageHide = () => controller.abort()
  const documentSignal = AbortSignal.any([operation.signal, controller.signal])
  const scopedFetch: typeof fetch = async (input, init) => {
    if (typeof input !== 'string' || !input.startsWith('/api/') || input.includes('\\')) {
      throw new Error('同じサイト内のAPIを指定してください。')
    }
    const headers = new Headers(init?.headers)
    const protectedHeaders = await getProtectedApiHeadersForScope(scope)
    protectedHeaders.forEach((value, name) => headers.set(name, value))
    operation.assertCurrent()
    documentSignal.throwIfAborted()
    return fetch(input, { ...init, headers, signal: documentSignal, redirect: 'error' })
  }
  window.addEventListener('pagehide', onPageHide, { once: true })
  try {
    const result = await run(scopedFetch, documentSignal)
    operation.assertCurrent('unknown')
    documentSignal.throwIfAborted()
    return result
  } finally {
    window.removeEventListener('pagehide', onPageHide)
    operation.dispose()
  }
}
