// 冷却换算（规格 docs/specs/playable-core.md §Tick 决策与结算顺序）：
// attackCooldownTicks = max(1, round(ticksPerSecond / attackSpeed))【APPROXIMATED A4】。
// 取整 = 常规四舍五入（0.5 向上，正值域；Math.round 对正值即此语义），下限 1 tick。
// 纯函数，无浏览器依赖；与标称攻速存在 ≤ 半 tick 偏差，由研究轨道回填替换。
import type { Rules } from "./types.ts";

/** 攻击冷却（整数 tick）：提交攻击后到下次可攻击的最小间隔。 */
export function attackCooldownTicks(rules: Rules, attackSpeed: number): number {
  return Math.max(1, Math.round(rules.ticksPerSecond / attackSpeed));
}
