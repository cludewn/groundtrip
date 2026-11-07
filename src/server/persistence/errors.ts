import { z } from 'zod'

const failures = {
  invalid_request: [400, '入力の形式または内容が正しくありません。'],
  payload_too_large: [413, '入力データが大きすぎます。'],
  unsupported_media_type: [415, 'Content-Typeにapplication/jsonを指定してください。'],
  version_conflict: [409, '保存内容の版が変わりました。最新の内容を確認してください。'],
  already_exists: [409, '同じIDの保存データが存在します。'],
  revision_mismatch: [409, '現在の旅程と変更候補の対象が一致しません。'],
  invalid_stored_data: [500, '保存データの形式を確認できませんでした。'],
  storage_unavailable: [503, '保存サービスを利用できません。時間をおいて再試行してください。'],
} as const

export class PersistenceError extends Error {
  constructor(readonly code: keyof typeof failures) {
    super(failures[code][1])
    this.name = 'PersistenceError'
  }

  get status() {
    return failures[this.code][0]
  }
}

// Zodで形が確定したデータを走査する。JSONのエスケープで入る孤立サロゲートも、
// Firestoreへ渡す前に拒否する。
function hasWellFormedStrings(value: unknown): boolean {
  if (typeof value === 'string') return value.isWellFormed()
  if (value === null || typeof value !== 'object') return true
  return Object.entries(value).every(
    ([key, field]) => key.isWellFormed() && hasWellFormedStrings(field),
  )
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success || !hasWellFormedStrings(result.data)) {
    throw new PersistenceError('invalid_request')
  }
  return result.data
}

export function parseStored<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success || !hasWellFormedStrings(result.data)) {
    throw new PersistenceError('invalid_stored_data')
  }
  return result.data
}
