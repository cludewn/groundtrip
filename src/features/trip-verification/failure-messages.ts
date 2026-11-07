import type { VerificationFailureKind } from './api-client'

// 根拠の確認が失敗したときの見出しと、次にとれる行動の案内。
// 失敗しても旅程は変わらない。その点を、すべての案内で伝える。
export const verificationFailureGuidance: Record<
  VerificationFailureKind,
  { title: string; action: string }
> = {
  external_service_error: {
    title: '外部の情報源に接続できず、根拠を確認できませんでした',
    action: '旅程はそのままです。時間をおいて、もう一度お試しください。',
  },
  invalid_request: {
    title: 'この旅程の内容では、根拠を確認できませんでした',
    action:
      '旅程はそのままです。予定の時刻が重なっていないかなどを見直すか、もう一度お試しください。',
  },
  payload_too_large: {
    title: '旅程のデータが大きすぎて、根拠を確認できませんでした',
    action: '旅程はそのままです。予定の数を減らして作り直すと、確認できる場合があります。',
  },
  service_unavailable: {
    title: '根拠の確認は現在利用できません',
    action:
      'このサービスでは、根拠の確認を一時的に停止しています。旅程はそのまま使えますが、根拠は未確認のままです。',
  },
  interrupted: {
    title: '通信が中断されました',
    action: '旅程はそのままです。接続を確認して、もう一度お試しください。',
  },
  unexpected: {
    title: '予期しない応答があり、確認結果を採用しませんでした',
    action: '旅程はそのままです。時間をおいて、もう一度お試しください。',
  },
}
