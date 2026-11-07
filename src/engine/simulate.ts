// simulate：战斗推演公开 API（T6，规格 docs/specs/playable-core.md §引擎 API、
// §Tick 决策与结算顺序、§事件 schema）。
//
// 纯函数：无浏览器依赖、无全局状态、不修改输入；同输入两次调用事件流完全一致（I5）。
// 坐标约定：事件位置字段一律引擎 axial (q, r)（T1 裁定，events.ts）。
//
// 双异常通道（T1 裁定）：入口第一行强制校验门——九码语义失败抛 SimulationInputError
// （携带 ValidationError[]），结构残缺抛 TypeError；战斗内不抛异常（无候选、路线失败、
// 争格失败均为合法待机状态；终止性由 timeoutTicks 循环上界结构性保证）。
//
// 事件顺序与 sequence（T6 实施前审查报告 §6）：事件在管线中的产出点即最终顺序——
// 决策期目标事件按 actionOrder（unitId 升序）先于结算期事件；sequence 由 pushEvent
// 唯一入口统一赋值（从 1 连续不跳号，I8），全程无需"先收集再排序"。
//
// 实施阶段（Issue #6，检查点在提交说明留痕）：
// 阶段 1（本提交）：Simulation State、tick 快照、行动顺序——无决策事件，
//   事件流 = BattleStarted + BattleEnded(timeout)；状态推进确定性。
// 阶段 2：决策两遍扫描 + 移动结算 + 争格裁决 + 缓存路线。
// 阶段 3：攻击 / 冷却 / 伤害汇总 / 死亡 / 目标更新。
// 阶段 4：wipeout / timeout / 平局补全测试 + 事件排序检查。
// 阶段 5：F1–F14 × I1–I10 全量不变量与确定性双跑。
import type { BattleEndedEvent, BattleEvent } from "./events.ts";
import { buildInitialState, type SimulationState } from "./state.ts";
import type { Rules, Side, SimulationInput } from "./types.ts";
import { requireValidSimulationInput } from "./validate.ts";

/** 尚未分配 sequence 的事件（pushEvent 唯一入口统一赋 sequence）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PendingEvent = DistributiveOmit<BattleEvent, "sequence">;

/**
 * 唯一事件出口：sequence = events.length + 1（从 1 连续、按产出顺序、不跳号——I8）。
 * 调用点按事件类别的管线产出顺序调用，不做排序修正。
 */
function pushEvent(events: BattleEvent[], event: PendingEvent): void {
  events.push({ ...event, sequence: events.length + 1 } as BattleEvent);
}

/**
 * simulate：完整推演到 BattleEnded，返回事件流。
 * - tick 循环 N = 1 … rules.timeoutTicks；每 tick：决策期（阶段 2 接入）→
 *   结算期（阶段 2/3 接入）→ 胜负检查（wipeout 优先于 timeout）；
 * - 胜负检查在每 tick 结算完成后执行：一方无存活 → 对方胜（双方同 tick 全灭 = 平局）；
 *   tick 达 timeoutTicks 且双方存活 → 整数交叉相乘比例判定（高者胜、相等平局）。
 */
export function simulate(input: SimulationInput): BattleEvent[] {
  requireValidSimulationInput(input);
  const state = buildInitialState(input);
  const events: BattleEvent[] = [];
  pushEvent(events, {
    type: "BattleStarted",
    tick: 0,
    scenarioId: input.scenario.scenarioId,
    rulesSnapshot: { ...input.rules },
  });

  for (let tick = 1; tick <= input.rules.timeoutTicks; tick++) {
    state.tick = tick;
    // 此刻 state 即"tick N 开始状态快照"：决策期（阶段 2 接入）对它零突变，
    // 决策结果以记录收集，由结算期统一落账——规格"基于同一份 tick 开始状态快照决策"。

    // ---- 决策期（阶段 2 接入）：按 actionOrder（unitId 升序）两遍扫描 ----
    // 第一遍（目标遍历）：目标验证 / 保留 / 重选 / 清除，产出 TargetAssigned / TargetCleared。
    // 第二遍（行动遍历）：四态决策表（攻击 / 等待 / 移动 / 等待），产出 Attack 与移动意向。

    // ---- 结算期（阶段 2/3 接入）：移动结算（争格裁决）→ 伤害汇总 → 死亡结算 ----

    // ---- 胜负检查（每 tick 结算完成后；wipeout 优先于 timeout）----
    const ended = checkVictory(state, input.rules);
    if (ended) {
      pushEvent(events, ended);
      return events;
    }
  }
  // 防御性兜底：末 tick（timeoutTicks，E9 保证正整数）的胜负检查必已返回。
  throw new TypeError("tick 循环未在 timeoutTicks 内产出 BattleEnded（编程错误）");
}

/**
 * 胜负检查（规格 §结算顺序 4）：
 * 1. wipeout：一方无存活 → 对方胜；双方同 tick 全灭 → 平局；
 * 2. timeout：tick 达 timeoutTicks 的结算全部完成后，双方存活 → 比较
 *    remB×initR vs remR×initB（整数交叉相乘，无除法舍入），高者胜、相等平局。
 * 返回 null 表示战斗继续。
 */
function checkVictory(state: SimulationState, rules: Rules): Omit<BattleEndedEvent, "sequence"> | null {
  const aliveBySide: Record<Side, number> = { blue: 0, red: 0 };
  const hpBySide: Record<Side, number> = { blue: 0, red: 0 };
  for (const unit of state.units) {
    if (!unit.alive) continue;
    aliveBySide[unit.side] += 1;
    hpBySide[unit.side] += unit.hp;
  }

  if (aliveBySide.blue === 0 || aliveBySide.red === 0) {
    const result: Side | "draw" =
      aliveBySide.blue === 0 && aliveBySide.red === 0
        ? "draw"
        : aliveBySide.blue === 0
          ? "red"
          : "blue";
    return { type: "BattleEnded", tick: state.tick, result, reason: "wipeout" };
  }

  if (state.tick >= rules.timeoutTicks) {
    const lhs = hpBySide.blue * state.initialHpBySide.red;
    const rhs = hpBySide.red * state.initialHpBySide.blue;
    const result: Side | "draw" = lhs === rhs ? "draw" : lhs > rhs ? "blue" : "red";
    return { type: "BattleEnded", tick: state.tick, result, reason: "timeout" };
  }
  return null;
}
