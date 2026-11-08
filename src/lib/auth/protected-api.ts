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
import {
  beginSessionScopeOperation,
  getAuthHeadersForScope,
  type SessionScope,
} from './session-scope'

const appChecks = new WeakMap<FirebaseApp, AppCheck>()

export async function getAppCheckToken(app = getClientAuth().app): Promise<string> {
  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY?.trim()
  if (!siteKey) throw new Error('アプリの検証設定がありません。')
  let appCheck = appChecks.get(app)
  if (!appCheck) {
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: false,
    })
    appChecks.set(app, appCheck)
  }
  return (await getToken(appCheck)).token
}

// 課金・保存APIへの同一オリジン要求だけに使う。認証疎通用のBearerヘルパーは独立に保つ。
export async function getProtectedApiHeaders(scope?: SessionScope): Promise<Headers> {
  const token = await getAppCheckToken()
  const headers = scope ? await getAuthHeadersForScope(scope) : await getAuthHeaders()
  headers.set('X-Firebase-AppCheck', token)
  return headers
}

export async function runProtectedSession<T>(
  scope: SessionScope,
  signal: AbortSignal | undefined,
  run: (fetchFn: typeof fetch, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const operation = beginSessionScopeOperation(scope, signal)
  const controller = new AbortController()
  const onPageHide = () => controller.abort()
  // BFCacheへ入る際も送信・本文の読み取りを止める。
  const documentSignal = AbortSignal.any([operation.signal, controller.signal])
  const scopedFetch: typeof fetch = async (input, init) => {
    if (typeof input !== 'string' || !input.startsWith('/api/') || input.includes('\\')) {
      throw new Error('同じサイト内のAPIを指定してください。')
    }
    const headers = new Headers(init?.headers)
    const protectedHeaders = await getProtectedApiHeaders(scope)
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
