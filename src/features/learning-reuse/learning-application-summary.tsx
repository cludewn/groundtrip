import type { ApprovedLearning, Trip } from '@/domain'

interface LearningApplicationSummaryProps {
  trip: Trip
  learnings: readonly ApprovedLearning[]
}

// Tripに残るのは、生成時にAIが申告して契約で検証された「適用先・説明」の記録。
// 学びが旅程差分を引き起こしたという因果関係や、制約成立を保証する表示ではない。
export function LearningApplicationSummary({ trip, learnings }: LearningApplicationSummaryProps) {
  const byId = new Map(learnings.map((learning) => [learning.id, learning]))
  const stopNames = new Map(trip.stops.map((stop) => [stop.id, stop.name]))
  const visible = trip.learningApplications.flatMap((application) => {
    const learning = byId.get(application.learningId)
    if (!learning) return []
    return [
      {
        id: application.learningId,
        content: learning.content,
        explanation: application.explanation,
        targets: application.targetStopIds
          .map((id) => stopNames.get(id))
          .filter((name): name is string => name !== undefined),
      },
    ]
  })

  return (
    <section aria-label="今回の旅程への学びの適用記録" className="space-y-2">
      <h2 className="text-lg font-semibold">選んだ学びはどう使われた？</h2>
      {visible.length === 0 ? (
        <p className="text-sm">
          この旅程には、選んだ学びの適用記録がありません。
          選んだ学びが必ず予定を変えるとは限りません。
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((item) => (
            <li key={item.id} className="rounded-lg border border-current/20 p-3">
              <p className="font-medium">{item.content}</p>
              <p className="mt-1 text-sm">対象：{item.targets.join('、')}</p>
              <p className="mt-1 text-sm">{item.explanation}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-current/70">
        上記は旅程生成時の適用記録です。別の条件で作った旅程との実測比較ではなく、
        旅程の違いが学びだけによるものだとは断定できません。
      </p>
    </section>
  )
}
