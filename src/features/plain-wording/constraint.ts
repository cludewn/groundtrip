import type { ConstraintCheck, TravelMode } from '@/domain'

import {
  CONSTRAINT_SATISFIED_TEMPLATE,
  CONSTRAINT_WORDING,
  MODE_LABELS,
  MODES_PLACEHOLDER,
  MODES_UNSPECIFIED,
  REASON_PREFIX,
  type Tone,
} from './wording'

export type ConstraintContext = {
  // 検証に使った移動手段（例：['walk']）。未指定なら「手段は未指定」と書く。
  travelModes?: readonly TravelMode[]
}

export type ConstraintWording = {
  label: string
  detail: string
  tone: Tone
  // 承認できる案として出してよいか。satisfiedだけがtrue。本人の承認そのものではない。
  canApprove: boolean
}

export function describeTravelModes(modes: readonly TravelMode[] | undefined): string {
  const unique = [...new Set(modes ?? [])]
  if (unique.length === 0) return MODES_UNSPECIFIED
  const labels = unique.map((mode) => MODE_LABELS[mode])
  return unique.length === 1 ? `${labels[0]}のみ` : labels.join('・')
}

// 制約判定（決定論的な検証の結果）を、利用者向けの言葉にする。根拠の照合や本人の承認とは別。
// 「間に合う見込み」は、satisfiedのときだけ使う。
export function describeConstraint(
  check: Pick<ConstraintCheck, 'status' | 'explanation'>,
  context: ConstraintContext = {},
): ConstraintWording {
  switch (check.status) {
    case 'satisfied': {
      const wording = CONSTRAINT_WORDING.satisfied
      return {
        label: wording.label,
        detail: CONSTRAINT_SATISFIED_TEMPLATE.replace(
          MODES_PLACEHOLDER,
          describeTravelModes(context.travelModes),
        ),
        tone: wording.tone,
        canApprove: wording.canApprove,
      }
    }
    case 'violated': {
      const wording = CONSTRAINT_WORDING.violated
      return {
        label: wording.label,
        detail: `${REASON_PREFIX}${check.explanation} ${wording.detail}`,
        tone: wording.tone,
        canApprove: wording.canApprove,
      }
    }
    case 'unknown': {
      const wording = CONSTRAINT_WORDING.unknown
      return {
        label: wording.label,
        detail: `${wording.detail} ${REASON_PREFIX}${check.explanation}`,
        tone: wording.tone,
        canApprove: wording.canApprove,
      }
    }
    case 'not_checked': {
      const wording = CONSTRAINT_WORDING.not_checked
      return {
        label: wording.label,
        detail: wording.detail,
        tone: wording.tone,
        canApprove: wording.canApprove,
      }
    }
  }
}
