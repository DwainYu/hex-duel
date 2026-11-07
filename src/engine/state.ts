// 战斗状态（T6，规格 docs/specs/playable-core.md §Tick 决策与结算顺序）：
// SimUnit 在 UnitSnapshot 之上扩展战斗节奏与目标缓存字段；SimulationState 是
// tick 循环的权威状态。决策期对当前 tick 的状态零突变（决策结果以记录收集、
// 结算期统一落账），保证规格要求的"所有存活棋子基于同一份 tick 开始状态快照决策"。
//
// 路线缓存裁定（T6 实施前审查报告 §8.1，主控确认 2026-11-07）：remainingPath 跨
// tick 缓存、仅在分配目标 / 路线耗尽 / 目标变更时重算；下一格被 tick 开始占格 →
// 等待重试、不换目标、不重算——使四态决策表"下一格可进入"、占格保护与
// "仅因争格等待重试"各句均可测、无死条件。
import type { AxialCoord } from "./coordinates.ts";
import { attackCooldownTicks } from "./cooldown.ts";
import { buildInitialSnapshot, type StateSnapshot, type UnitSnapshot } from "./snapshot.ts";
import type { Side, SimulationInput } from "./types.ts";

/** 战斗中的单个棋子状态（T2 快照最小集 + T6 战斗扩展字段）。 */
export interface SimUnit extends UnitSnapshot {
  /** 当前 HP（初始 = 目录 def.hp；伤害结算落账，死亡判据 hpAfter ≤ 0）。 */
  hp: number;
  /** 攻击力（目录解析，构建期一次）。 */
  ad: number;
  /** 预计算的攻击冷却（max(1, round(tps/as))，【APPROXIMATED A4】，见 cooldown.ts）。 */
  attackCooldownTicks: number;
  /** 下次可攻击的 tick（初始 1；冷却从实际攻击后起算）。 */
  attackReadyTick: number;
  /** 下次可移动的 tick（初始 = moveIntervalTicks；仅成功移动推进，等待/争格失败不变）。 */
  moveReadyTick: number;
  /** 当前目标；null = 无目标（初始 / TargetCleared 之后；每 tick 决策期静默重试分配）。 */
  targetId: string | null;
  /**
   * 缓存路线：从当前位置到目标射程内合法空格的剩余路径（不含当前格；in-range 时为空）。
   * 坐标为引擎 axial (q, r)；成功移动后弹出一格。
   */
  remainingPath: AxialCoord[];
}

/** tick 循环的权威战斗状态（units 沿用 buildInitialSnapshot 的 unitId 升序约定）。 */
export interface SimulationState {
  /** 已推进到的 tick（0 = 战斗开始前；BattleStarted 为 tick 0，决策事件从 tick 1 起）。 */
  tick: number;
  /** 全部棋子（含已死亡，死亡者 alive=false 且其占格自下一 tick 起不再阻挡）。 */
  units: SimUnit[];
  /** 双方初始总 HP（超时比例判定的分母：remB×initR vs remR×initB，整数交叉相乘）。 */
  initialHpBySide: Record<Side, number>;
}

/**
 * 由已通过校验的 SimulationInput 构建 tick 0 初始状态（simulate 与 previewInitial
 * 共用 buildInitialSnapshot：位置 offset→axial 转换 + unitId 升序 + 防御性 TypeError）。
 * 前置条件：输入已通过 validateSimulationInput（unitDefId 必在目录、数值合法）。
 */
export function buildInitialState(input: SimulationInput): SimulationState {
  const snapshot: StateSnapshot = buildInitialSnapshot(input);
  const defById = new Map(input.catalog.units.map((def) => [def.unitDefId, def]));
  const units: SimUnit[] = snapshot.units.map((unit) => {
    const def = defById.get(unit.unitDefId);
    if (!def) {
      // 防御性：绕过校验直调时以 TypeError 显式拒绝（形状断言通道，与 T1 约定一致）。
      throw new TypeError(
        `输入结构非法（scenario.units）：unitDefId ${unit.unitDefId} 不在传入目录（须先通过 validateSimulationInput）`,
      );
    }
    return {
      ...unit,
      hp: def.hp,
      ad: def.ad,
      attackCooldownTicks: attackCooldownTicks(input.rules, def.attackSpeed),
      attackReadyTick: 1,
      moveReadyTick: input.rules.moveIntervalTicks,
      targetId: null,
      remainingPath: [],
    };
  });
  const initialHpBySide: Record<Side, number> = { blue: 0, red: 0 };
  for (const unit of units) {
    initialHpBySide[unit.side] += unit.hp;
  }
  return { tick: 0, units, initialHpBySide };
}
