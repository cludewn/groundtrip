import type { PlaceCandidate } from '../maps'

// 生成した予定の名称と、Places上の施設を、同じ施設とみなしてよいかの判定（名称一致のゲート）。
// 疎通確認で、別の施設（飲食店→別の飲食店、飲食店→医院）に紐付く事例があったため、名称が一致しない候補は
// 採用しない。名称の一致は、実在や同一性の保証ではない。迷う場合は「確認できない」にする。

export function normalizeName(name: string): string {
  return (
    name
      .normalize('NFKC')
      .toLowerCase()
      // 括弧書き（「（支店）」「（架空）」等の補足）は、比較から外す。
      .replace(/[（(][^）)]*[）)]/g, '')
      // 空白・区切りの記号の違いを吸収する（「奥丹清水」と「奥丹 清水」を同じにする）。
      .replace(/[\s・･,、。.\-‐‑–—―~〜～'"“”「」『』【】[\]!！?？/／]/g, '')
  )
}

export type NameMatchKind = 'exact' | 'partial' | 'none'

// 部分一致は、短いほうが3文字以上で、長いほうの半分以上を占めるときだけ認める。
// 「清水」が「清水寺」「清水五条駅」にも含まれてしまうような、緩すぎる一致を避ける。
const MIN_PARTIAL_LENGTH = 3
const MIN_PARTIAL_RATIO = 0.5

export function compareNames(generated: string, found: string): NameMatchKind {
  const a = normalizeName(generated)
  const b = normalizeName(found)
  if (a.length === 0 || b.length === 0) return 'none'
  if (a === b) return 'exact'
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (
    shorter.length >= MIN_PARTIAL_LENGTH &&
    shorter.length / longer.length >= MIN_PARTIAL_RATIO &&
    longer.includes(shorter)
  ) {
    return 'partial'
  }
  return 'none'
}

export type PlaceSelection =
  | { status: 'matched'; place: PlaceCandidate; match: 'exact' | 'partial' }
  // 名称が一致する候補が複数あり、1つに絞れない（チェーン店の複数店舗など）。
  | { status: 'ambiguous'; count: number }
  // 候補はあるが、どれも名称が一致しない（別の施設の可能性）。
  | { status: 'mismatch' }
  | { status: 'no_candidates' }

export function selectPlace(
  generatedName: string,
  candidates: readonly PlaceCandidate[],
): PlaceSelection {
  if (candidates.length === 0) return { status: 'no_candidates' }

  const scored = candidates.map((place) => ({
    place,
    match: compareNames(generatedName, place.name),
  }))
  const exact = scored.filter((item) => item.match === 'exact')
  const pool = exact.length > 0 ? exact : scored.filter((item) => item.match === 'partial')

  if (pool.length === 0) return { status: 'mismatch' }
  // 同じ施設を指す重複（同一のPlace ID）は1件として数える。
  const distinct = new Set(pool.map((item) => item.place.placeId))
  if (distinct.size > 1) return { status: 'ambiguous', count: distinct.size }
  const [first] = pool
  return { status: 'matched', place: first.place, match: first.match as 'exact' | 'partial' }
}
