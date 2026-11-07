import type { PlaceCandidate } from '../maps'

// 生成した予定の名称と、Places上の施設を、同じ施設とみなしてよいかの判定（名称・所在地のゲート）。
// 疎通確認で、別の施設（飲食店→別の飲食店、飲食店→医院）に紐付く事例があったため、名称が一致しない候補は
// 採用しない。名称の一致は、実在や同一性の保証ではない。迷う場合は「確認できない」にする。
//
// 採用する条件（すべて満たすときだけ）：
// - 名称が完全に一致する（部分一致は採用しない。「清水寺」と「清水寺 奥の院」のような別施設を避ける）。
// - 括弧書きは、支店名などの識別情報として扱う。両方にある場合は、一致が必要。
//   一方だけにある場合は、支店名の表記なら不一致、補足（「サンプル」など）なら無視する。
// - 候補の所在地が、旅程の地域と矛盾しない（地域の語のどれかが、住所に含まれる）。

const STRIP = /[\s・･,、。.\-‐‑–—―~〜～'"“”「」『』【】[\]()!！?？/／]/g
const PAREN_GROUP = /\(([^)]*)\)/g

const strip = (text: string): string => text.replace(STRIP, '')

export interface ParsedName {
  // 括弧書きを除いた名称（比較用）
  base: string
  // 括弧書きの内容（支店名・補足）
  qualifier: string
}

export function parseName(name: string): ParsedName {
  // 全角の括弧は、NFKCで半角になる。
  const text = name.normalize('NFKC').toLowerCase()
  const qualifiers: string[] = []
  const base = text.replace(PAREN_GROUP, (_match, inner: string) => {
    qualifiers.push(strip(inner))
    return ''
  })
  return { base: strip(base), qualifier: qualifiers.join('') }
}

// 括弧書きが、支店・店舗の指定にあたるか（施設の識別に必要な情報か）。
const BRANCH_QUALIFIER = /(店|支店|本店|分店|号店|店舗|営業所)$/

export type NameMatchKind = 'exact' | 'none'

export function compareNames(generated: string, found: string): NameMatchKind {
  const a = parseName(generated)
  const b = parseName(found)
  if (a.base.length === 0 || b.base.length === 0 || a.base !== b.base) return 'none'

  if (a.qualifier && b.qualifier) return a.qualifier === b.qualifier ? 'exact' : 'none'
  // 見つかった施設だけが、支店などを名乗る：生成した名称には支店の指定がなく、同じ施設と確かめられない。
  if (b.qualifier) return 'none'
  // 生成した名称だけに括弧書きがある：支店名の表記なら、その支店と確かめられない。補足なら無視する。
  if (a.qualifier && BRANCH_QUALIFIER.test(a.qualifier)) return 'none'
  return 'exact'
}

const REGION_SUFFIX = /(周辺|付近|近辺|エリア|地区|方面|一帯)$/

export function regionTokens(region: string): string[] {
  return (
    region
      .normalize('NFKC')
      .toLowerCase()
      // 括弧書きの補足（「（架空デモ）」など）は、地域の語に含めない。
      .replace(/\([^)]*\)/g, '')
      .split(/[・･,、，/／\s]+/)
      .map((token) => token.replace(REGION_SUFFIX, ''))
      .filter((token) => token.length > 0)
  )
}

// 「京都」は「東京都」にも含まれるため、その場合だけ区別する。
const containsToken = (text: string, token: string): boolean => {
  let from = text.indexOf(token)
  while (from !== -1) {
    if (!(token === '京都' && text[from - 1] === '東')) return true
    from = text.indexOf(token, from + 1)
  }
  return false
}

// 候補の所在地が、旅程の地域と矛盾しないか。住所が無い・地域の語が住所に無いときは、裏付けなし。
export function addressMatchesRegion(address: string | undefined, region: string): boolean {
  if (!address) return false
  const text = address.normalize('NFKC').toLowerCase().replace(/\s/g, '')
  const tokens = regionTokens(region)
  return tokens.length > 0 && tokens.some((token) => containsToken(text, token))
}

export type PlaceSelection =
  | { status: 'matched'; place: PlaceCandidate }
  // 名称が一致する候補が複数あり、1つに絞れない（チェーン店の複数店舗など）。
  | { status: 'ambiguous'; count: number }
  // 名称は一致するが、所在地が旅程の地域と一致する（と確かめられる）候補がない。
  | { status: 'region_mismatch' }
  // 候補はあるが、どれも名称が一致しない（別の施設の可能性）。
  | { status: 'mismatch' }
  | { status: 'no_candidates' }

export function selectPlace(
  generatedName: string,
  region: string,
  candidates: readonly PlaceCandidate[],
): PlaceSelection {
  if (candidates.length === 0) return { status: 'no_candidates' }

  const named = candidates.filter((place) => compareNames(generatedName, place.name) === 'exact')
  if (named.length === 0) return { status: 'mismatch' }

  const inRegion = named.filter((place) => addressMatchesRegion(place.address, region))
  if (inRegion.length === 0) return { status: 'region_mismatch' }

  // 同じ施設を指す重複（同一のPlace ID）は1件として数える。
  const distinct = new Set(inRegion.map((place) => place.placeId))
  if (distinct.size > 1) return { status: 'ambiguous', count: distinct.size }
  return { status: 'matched', place: inRegion[0] }
}
