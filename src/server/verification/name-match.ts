import type { PlaceCandidate } from '../maps'

// 生成した予定の名称と、Places上の施設を、同じ施設とみなしてよいかの判定（名称・所在地のゲート）。
// 疎通確認で、別の施設（飲食店→別の飲食店、飲食店→医院）に紐付く事例があったため、名称が一致しない候補は
// 採用しない。名称の一致は、実在や同一性の保証ではない。迷う場合は「確認できない」にする。
//
// 採用する条件（すべて満たすときだけ）：
// - 名称が完全に一致する（部分一致は採用しない。「清水寺」と「清水寺 奥の院」のような別施設を避ける）。
//   比較で無視するのは、空白と、引用符・括弧類（「」『』【】“”）の装飾だけ。「/」「・」などの記号は、
//   名称の一部として扱う（「A/B」と「AB」を同じにしない）。
// - 括弧書きは、施設の識別情報（支店・別館など）として扱う。両方にあれば一致が必要。
//   一方にしかなければ、同じ施設と確かめられないため、不一致とする（「資料館（別館）」と「資料館」）。
// - 候補の所在地が、住所の行政区画（都道府県・市区町村）で、旅程の地域と一致する。
//   地域の語が、住所の文字列のどこかに含まれるだけでは、一致としない（東京都目黒区東山を、京都・東山としない）。

// 比較で無視する文字：空白と、引用符・括弧類の装飾だけ。
const IGNORED = /[\s「」『』【】“”"]/g
const PAREN_GROUP = /\(([^)]*)\)/g

const strip = (text: string): string => text.replace(IGNORED, '')

export interface ParsedName {
  // 括弧書きを除いた名称（比較用）
  base: string
  // 括弧書きの内容（支店名・別館など。識別情報）
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

export type NameMatchKind = 'exact' | 'none'

export function compareNames(generated: string, found: string): NameMatchKind {
  const a = parseName(generated)
  const b = parseName(found)
  if (a.base.length === 0 || b.base.length === 0 || a.base !== b.base) return 'none'
  // 括弧書きは、識別情報。両方にあれば一致が必要で、一方にしかなければ、同じ施設と確かめられない。
  return a.qualifier === b.qualifier ? 'exact' : 'none'
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

// 日本の住所の行政区画：都道府県の名称と、市区町村（郡を含む）の名称を、住所の先頭から順に読み取る。
// 読み取れない（日本の住所と確かめられない）ときは、null。町名・丁目・建物名は、行政区画として扱わない。
const COUNTRY_PREFIX = /^(日本|japan)[、,\s]*/
const POSTAL_CODE = /^〒?\s*\d{3}-?\d{4}\s*/
const PREFECTURE = /^(北海道|東京都|京都府|大阪府|[^\s\d、,]{2,3}県)/
const MUNICIPALITY = /^([^\s\d、,]{1,6}?)(郡|市|区|町|村)/

export function administrativeUnits(address: string | undefined): string[] | null {
  if (!address) return null
  let rest = address.normalize('NFKC').trim().replace(COUNTRY_PREFIX, '').replace(POSTAL_CODE, '')
  const prefecture = PREFECTURE.exec(rest)?.[1]
  if (!prefecture) return null
  const units = [prefecture]
  rest = rest.slice(prefecture.length)
  for (let match = MUNICIPALITY.exec(rest); match; match = MUNICIPALITY.exec(rest)) {
    units.push(match[0])
    rest = rest.slice(match[0].length)
  }
  return units
}

// 地域の語は、行政区画の名称（「京都」と「京都市」「京都府」、「東山」と「東山区」）と一致するときだけ、一致とする。
// 住所に文字列として含まれるだけ（別の都道府県の「東山」町など）では、一致としない。
const unitMatches = (unit: string, token: string): boolean =>
  token === unit || token === unit.slice(0, -1)

// 候補の所在地が、旅程の地域と、行政区画で一致するか。住所が無い・日本の住所と確かめられない・
// 地域の語が行政区画に無いときは、裏付けなし（確認できない）。
export function addressMatchesRegion(address: string | undefined, region: string): boolean {
  const units = administrativeUnits(address)
  if (!units) return false
  return regionTokens(region).some((token) => units.some((unit) => unitMatches(unit, token)))
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
