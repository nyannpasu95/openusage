import type { PluginMeta, PluginOutput } from "@/lib/plugin-types"

type ProgressLine = Extract<
  PluginOutput["lines"][number],
  { type: "progress" }
>

export type TrayUsageIncrease = {
  providerId: string
  fractionIncrease: number
}

function getMenubarProgress(
  meta: PluginMeta,
  output: PluginOutput,
  preferWeekly: boolean,
): ProgressLine | null {
  if (preferWeekly && meta.weeklyCandidate) {
    const weeklyLine = output.lines.find(
      (line): line is ProgressLine =>
        line.type === "progress" && line.label === meta.weeklyCandidate
    )
    if (weeklyLine) return weeklyLine
  }

  for (const candidate of meta.primaryCandidates ?? []) {
    const line = output.lines.find(
      (item): item is ProgressLine =>
        item.type === "progress" && item.label === candidate
    )
    if (line) return line
  }

  return null
}

export function getTrayUsageIncrease(args: {
  meta: PluginMeta
  previousData: PluginOutput | null
  nextData: PluginOutput
  preferWeekly?: boolean
}): TrayUsageIncrease | null {
  const {
    meta,
    previousData,
    nextData,
    preferWeekly = false,
  } = args

  if (!previousData) return null
  if (
    previousData.providerId !== meta.id ||
    nextData.providerId !== meta.id ||
    previousData.plan !== nextData.plan
  ) {
    return null
  }

  const previousLine = getMenubarProgress(meta, previousData, preferWeekly)
  const nextLine = getMenubarProgress(meta, nextData, preferWeekly)
  if (!previousLine || !nextLine || previousLine.label !== nextLine.label) return null
  if (
    !Number.isFinite(previousLine.used) ||
    !Number.isFinite(previousLine.limit) ||
    !Number.isFinite(nextLine.used) ||
    !Number.isFinite(nextLine.limit) ||
    previousLine.limit <= 0 ||
    nextLine.limit <= 0
  ) {
    return null
  }

  const usedIncrease = nextLine.used - previousLine.used
  if (usedIncrease <= 0) return null

  return {
    providerId: meta.id,
    fractionIncrease: usedIncrease / nextLine.limit,
  }
}

export function pickLargestTrayUsageIncrease(
  candidates: Iterable<TrayUsageIncrease>,
  providerOrder: string[],
): TrayUsageIncrease | null {
  const orderById = new Map(providerOrder.map((id, index) => [id, index]))
  let selected: TrayUsageIncrease | null = null

  for (const candidate of candidates) {
    if (!selected || candidate.fractionIncrease > selected.fractionIncrease) {
      selected = candidate
      continue
    }
    if (candidate.fractionIncrease < selected.fractionIncrease) continue

    const candidateOrder = orderById.get(candidate.providerId) ?? Number.MAX_SAFE_INTEGER
    const selectedOrder = orderById.get(selected.providerId) ?? Number.MAX_SAFE_INTEGER
    if (candidateOrder < selectedOrder) selected = candidate
  }

  return selected
}
