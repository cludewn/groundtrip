import { describe, expect, it } from 'vitest'

import { TripSchema, type Evidence, type Trip } from '@/domain'
import { sampleTrip } from '@/domain/samples'

import { summarizeVerification } from './verification-summary'
import { withdrawVerification } from './withdraw-verification'

const evidence = (id: string, kind: Evidence['source']['kind'], status: Evidence['status']) =>
  ({
    id,
    subject: 'place_identity',
    claim: '施設の同定',
    applicability: '名称と地域',
    source: { kind, label: kind },
    checkedAt: '2026-11-08T10:00:00+09:00',
    status,
    explanation: '説明',
  }) satisfies Evidence

const basis: Trip = TripSchema.parse({
  ...sampleTrip,
  stops: sampleTrip.stops.map((stop) => ({ ...stop, placeId: null, evidence: [] })),
})
const result: Trip = TripSchema.parse({
  ...basis,
  stops: basis.stops.map((stop) => ({
    ...stop,
    placeId: `place-${stop.id}`,
    evidence: [evidence(`e-${stop.id}`, 'places', 'consistent')],
  })),
})

const withoutEvidence = (trip: Trip) =>
  trip.stops.map((stop) => ({ ...stop, evidence: [], placeId: null }))

describe('withdrawVerification', () => {
  it('照合で付いた根拠とPlace IDを、照合前の状態に戻す。名称・時刻・固定は変えない', () => {
    const changed: Trip = {
      ...result,
      version: result.version + 1,
      stops: result.stops.map((stop) =>
        stop.id === 'stop-lunch' ? { ...stop, isFixed: true } : stop,
      ),
    }

    const withdrawn = withdrawVerification(changed, { basis, result })

    for (const stop of withdrawn.stops) {
      expect(stop.evidence).toEqual([])
      expect(stop.placeId).toBeNull()
    }
    expect(withoutEvidence(withdrawn)).toEqual(withoutEvidence(changed))
    expect(withdrawn.version).toBe(changed.version)
  })

  it('変更で新しく付いた根拠（差し替えた予定）と、新しい予定はそのまま残す', () => {
    const own = evidence('e-new', 'places', 'consistent')
    const changed: Trip = {
      ...result,
      stops: [
        result.stops[0],
        { ...result.stops[1], name: '差し替えた店', placeId: 'place-new', evidence: [own] },
        result.stops[2],
        { ...result.stops[2], id: 'stop-extra', evidence: [own] },
      ],
    }

    const withdrawn = withdrawVerification(changed, { basis, result })

    expect(withdrawn.stops[0].evidence).toEqual([])
    expect(withdrawn.stops[1].evidence).toEqual([own])
    expect(withdrawn.stops[1].placeId).toBe('place-new')
    expect(withdrawn.stops[2].evidence).toEqual([])
    expect(withdrawn.stops[3].evidence).toEqual([own])
  })

  it('照合前から根拠があった予定は、その根拠に戻す（なくさない）', () => {
    const original = evidence('e-original', 'official', 'consistent')
    const basisWithOwn: Trip = {
      ...basis,
      stops: basis.stops.map((stop, i) => (i === 0 ? { ...stop, evidence: [original] } : stop)),
    }

    const withdrawn = withdrawVerification(result, { basis: basisWithOwn, result })

    expect(withdrawn.stops[0].evidence).toEqual([original])
  })
})

describe('summarizeVerification', () => {
  it('状態ごとの件数、最新の照合日時、Google由来の根拠の有無を数える', () => {
    const trip: Trip = {
      ...basis,
      stops: [
        { ...basis.stops[0], evidence: [evidence('a', 'places', 'consistent')] },
        {
          ...basis.stops[1],
          evidence: [
            { ...evidence('b', 'routes', 'conflicting'), checkedAt: '2026-11-08T11:00:00+09:00' },
            evidence('c', 'simulation', 'unverifiable'),
          ],
        },
        basis.stops[2],
      ],
    }

    expect(summarizeVerification(trip)).toEqual({
      counts: { consistent: 1, conflicting: 1, unverifiable: 1 },
      total: 3,
      latestCheckedAt: '2026-11-08T11:00:00+09:00',
      usesGoogle: true,
    })
  })

  it('模擬・公式だけならGoogle由来ではなく、根拠がなければ件数は0', () => {
    expect(summarizeVerification(basis)).toMatchObject({ total: 0, usesGoogle: false })
    const sim: Trip = {
      ...basis,
      stops: [{ ...basis.stops[0], evidence: [evidence('s', 'simulation', 'consistent')] }],
    }
    expect(summarizeVerification(sim).usesGoogle).toBe(false)
  })
})
