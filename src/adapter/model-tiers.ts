/** 思考强度档位（官方模型 id 后缀），从弱到强。 */
export const AGY_REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type AgyReasoningEffort = (typeof AGY_REASONING_EFFORTS)[number]

/**
 * 目录里可能出现的档位后缀。`xhigh` 属于「可识别、但不路由」的一档：官方 1.5.x
 * 给 Gemini 4 Hydrogen 加了 `-xhigh`，客户端若只认三档，这个 id 会被当成独立家族
 * 出现在模型选择器里；但宿主侧的 reasoning 只接受 low/medium/high，暴露它会让
 * 选中后调用直接以 UNSUPPORTED_REASONING_EFFORT 失败。
 *
 * 所以：识别它（折叠进家族、去掉显示名后缀），不把它放进 AGY_REASONING_EFFORTS
 * （不进思考强度菜单、不参与就近档位回退）。
 */
export type AgyModelTier = AgyReasoningEffort | 'xhigh'

/** 显示名映射（档位标签与思考强度菜单同名）。 */
export const AGY_REASONING_EFFORT_NAMES: Record<AgyReasoningEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

/**
 * 未选思考强度时的路由档位（官方 CLI 的默认模型是
 * `Gemini 3.8 Flash (Medium)`，与其中档一致）。
 */
export const DEFAULT_AGY_REASONING_EFFORT: AgyReasoningEffort = 'medium'

/**
 * 用户明确排除的模型家族（2026-10-16 指示：gpt-oss-120b 临近下架，不进选择器）。
 * 按家族排除：`gpt-oss-120b` 与其全部档位变体一并不出现。
 */
export const AGY_MODEL_EXCLUDED_FAMILIES: ReadonlySet<string> = new Set(['gpt-oss-120b'])

/** 识别 id 的思考强度后缀；识别不出返回 undefined。 */
export function tierForModelId(id: string): AgyModelTier | undefined {
  const match = /-(low|medium|high|xhigh)$/.exec(id)
  return match ? (match[1] as AgyModelTier) : undefined
}

/** 家族 id：去掉思考强度后缀；没有后缀时原样返回。 */
export function modelFamilyId(id: string): string {
  const tier = tierForModelId(id)
  return tier === undefined ? id : id.slice(0, -(tier.length + 1))
}

/** 显示名里的档位标签（如 `Claude Opus 5.5 (High)` → `Claude Opus 5.5`）。 */
function stripTierLabel(name: string): string {
  return name.replace(/\s*\((low|medium|high|xhigh)\)\s*$/i, '').trim() || name
}

/**
 * 把档位化的模型 id 折叠成家族条目，并记录各家族支持的档位。
 *
 * 模型选择只出**家族**（`claude-opus-5-5` 一行），思考强度由 DSH 的思考强度
 * 菜单选择后自动路由到对应档位模型（`claude-opus-5-5-high`）——2026-10-16
 * 用户指示「不要把思考强度单独放进模型，而是做一个路由」。
 * 被排除的家族（gpt-oss-120b）整组不出现。
 */
export function foldAgyModelFamilies(
  rows: readonly { id: string; name: string; description?: string }[],
): { models: Array<{ id: string; name: string; description?: string }>; tiers: Map<string, ReadonlySet<AgyModelTier>> } {
  const families = new Map<string, { id: string; name: string; description?: string; tiers: Set<AgyModelTier> }>()
  for (const row of rows) {
    const tier = tierForModelId(row.id)
    const familyId = modelFamilyId(row.id)
    if (AGY_MODEL_EXCLUDED_FAMILIES.has(familyId)) continue
    const entry = families.get(familyId) ?? {
      id: familyId,
      name: stripTierLabel(row.name),
      ...(row.description === undefined ? {} : { description: row.description }),
      tiers: new Set<AgyModelTier>(),
    }
    if (tier) entry.tiers.add(tier)
    if (entry.name === familyId && stripTierLabel(row.name) !== row.name) entry.name = stripTierLabel(row.name)
    families.set(familyId, entry)
  }
  const tiers = new Map<string, ReadonlySet<AgyModelTier>>()
  const models: Array<{ id: string; name: string; description?: string }> = []
  for (const entry of families.values()) {
    models.push({
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
    })
    tiers.set(entry.id, entry.tiers)
  }
  return { models, tiers }
}

/**
 * 家族 + 思考强度 → 官方档位模型 id。
 *
 * - 家族**有**档位变体：取请求档位；缺该档位时取最接近的已有档位
 *   （按 low→medium→high 顺序）；
 * - 家族**已知没有**档位变体（目录里的普通 id）：原样返回，不编造后缀；
 * - 家族未知（目录尚未观测到）：明确给了强度才拼后缀，否则原样返回。
 */
export function routeTieredModelId(
  familyId: string,
  effort: AgyReasoningEffort,
  tiers?: ReadonlySet<AgyModelTier>,
): string {
  if (tiers && tiers.size === 0) return familyId
  if (tiers && tiers.size > 0) {
    if (tiers.has(effort)) return `${familyId}-${effort}`
    const order = AGY_REASONING_EFFORTS
    const wanted = order.indexOf(effort)
    let best: AgyReasoningEffort | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of order) {
      if (!tiers.has(candidate)) continue
      const distance = Math.abs(order.indexOf(candidate) - wanted)
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
    }
    return best === undefined ? familyId : `${familyId}-${best}`
  }
  return `${familyId}-${effort}`
}
