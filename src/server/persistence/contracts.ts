import { z } from 'zod'

import { ApprovedLearningSchema, LearningSchema, RevisionSchema, TripSchema } from '@/domain'
import { IdSchema, TextSchema } from '@/domain/primitives'
import { MAX_LEARNING_CONTENT_LENGTH } from '@/lib/learnings/lifecycle'

export const RecordIdSchema = IdSchema.max(256).refine((id) => id.isWellFormed())
export const VersionSchema = z.int().nonnegative()

// 既存の旅程生成結果を本人が保存する。学びの反映情報は、後続のサーバー生成フローが設定する。
export const CreateTripBodySchema = TripSchema.refine(
  (trip) => trip.version === 0 && trip.learningApplications.length === 0,
)

export const UpdateTripBodySchema = z.strictObject({
  expectedVersion: VersionSchema,
  preferences: z.array(TextSchema),
})

export const PendingRevisionSchema = RevisionSchema.safeExtend({
  approval: z.strictObject({ status: z.literal('pending') }),
})

export const ApproveLearningBodySchema = z.strictObject({
  expectedVersion: VersionSchema,
  sourceTripId: RecordIdSchema,
  category: LearningSchema.shape.category,
  content: TextSchema.max(MAX_LEARNING_CONTENT_LENGTH),
  scope: LearningSchema.shape.scope,
})

export const VersionedLearningSchema = z.strictObject({
  version: VersionSchema.positive(),
  learning: ApprovedLearningSchema,
})

export const TripResponseSchema = z.strictObject({ trip: TripSchema })
export const TripListResponseSchema = z.strictObject({ trips: z.array(TripSchema) })
export const RevisionResponseSchema = z.strictObject({ revision: PendingRevisionSchema })
export const RevisionListResponseSchema = z.strictObject({
  revisions: z.array(PendingRevisionSchema),
})
export const LearningListResponseSchema = z.strictObject({
  learnings: z.array(VersionedLearningSchema),
})

export type ApproveLearningBody = z.infer<typeof ApproveLearningBodySchema>
export type PendingRevision = z.infer<typeof PendingRevisionSchema>
export type VersionedLearning = z.infer<typeof VersionedLearningSchema>
