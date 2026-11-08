'use client'

import { useState } from 'react'

import { requestTripGeneration } from '@/features/trip-planner/api-client'
import { verifyTripWithProtectedApi } from '@/features/trip-verification/protected-verify'
import { startNewAnonymousSession } from '@/lib/auth/client'
import { getProtectedApiHeadersForScope } from '@/lib/auth/protected-api'
import { useSessionScope } from '@/lib/auth/use-session-scope'
import { isDemoSessionActive } from '@/lib/firebase/client'

import { HomePlanner } from './home-planner'

export function SessionHomePlanner() {
  const session = useSessionScope()
  const [starting, setStarting] = useState(false)
  const scope = session.status === 'authenticated' ? session.scope : undefined
  const demo = session.status !== 'restoring' && isDemoSessionActive()
  const demoEnded = session.status === 'session_ended' && demo
  let message = ''
  if (session.status === 'restoring') message = '利用状態を確認しています。'
  if (session.status === 'session_ended' || session.status === 'error')
    message = session.error.message
  if (demoEnded) message = 'デモの利用状態を確認できません。提出資料のURLを開き直してください。'

  return (
    <>
      {scope && demo && (
        <p role="note" className="gt-notice mb-4">
          デモの旅程・学び・利用枠は共有されます。個人情報は入力しないでください。
        </p>
      )}
      {message && (
        <p role="status" className="mb-3 text-sm">
          {message}
        </p>
      )}
      {session.status === 'session_ended' && !demoEnded && (
        <button
          type="button"
          className="mb-4 min-h-11 rounded-lg border border-gt-muted bg-gt-paper px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gt-preview disabled:opacity-60"
          disabled={starting}
          onClick={async () => {
            setStarting(true)
            try {
              await startNewAnonymousSession()
            } catch {
              // 失敗は既存の認証購読から表示する。
            } finally {
              setStarting(false)
            }
          }}
        >
          新しい利用を始める
        </button>
      )}
      <HomePlanner
        generate={(request, options) =>
          scope
            ? requestTripGeneration(request, {
                ...options,
                getHeaders: () => getProtectedApiHeadersForScope(scope),
              })
            : Promise.resolve({
                ok: false,
                failure: { kind: 'auth_required', message },
              })
        }
        verify={(trip, options) =>
          scope
            ? verifyTripWithProtectedApi(trip, options)
            : Promise.resolve({
                ok: false,
                failure: { kind: 'auth_required', message },
              })
        }
      />
    </>
  )
}
