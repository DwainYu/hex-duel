// simulate：战斗推演公开 API（T6，规格 docs/specs/playable-core.md §引擎 API、
// §目标保留与重选规则、§Tick 决策与结算顺序、§路径搜索与位置冲突、§事件 schema）。
//
// 纯函数：无浏览器依赖、无全局状态、不修改输入；同输入两次调用事件流完全一致（I5）。
// 坐标约定：事件位置字段一律引擎 axial (q, r)（T1 裁定，events.ts）。
//
// 双异常通道（T1 裁定）：入口第一行强制校验门——九码语义失败抛 SimulationInputError
// （携带 ValidationError[]），结构残缺抛 TypeError；战斗内不抛异常（无候选、路线失败、
// 争格失败均为合法待机状态；终止性由 timeoutTicks 循环上界结构性保证）。
//
// 事件顺序与 sequence（T6 实施前审查报告 §6）：事件在管线中的产出点即最终顺序——
// 决策期目标事件（TargetAssigned 先于 TargetCleared，各类内按 unitId 升序）先于
// 结算期事件（UnitMoved → Attack → HpChanged → UnitDied，BattleEnded 最后）；
// sequence 由 pushEvent 唯一入口统一赋值（从 1 连续不跳号，I8），全程无需"先收集再排序"。
//
// 决策期零突变（审查报告 §3）：所有决策基于同一份 tick 开始状态——决策结果以记录
// 收集（TargetOutcome / MoveIntent），结算期统一落账；"已提交攻击必中"由此成立。
//
// 实施阶段（Issue #6，检查点在提交说明留痕）：
// 阶段 1（33e30a8）：Simulation State、tick 快照、行动顺序——状态推进确定性。
// 阶段 2（c716889）：目标选择、路线、移动节奏、争格——决策两遍扫描 + 移动结算。
// 阶段 3（本提交）：攻击 / 冷却 / 伤害汇总 / 死亡 / 目标更新——已提交攻击必中。
// 阶段 4：wipeout / timeout / 平局补全测试 + 事件排序检查。
// 阶段 5：F1–F14 × I1–I10 全量不变量与确定性双跑。
import { hexDistance, type AxialCoord } from "./coordinates.ts";
import type { BattleEndedEvent, BattleEvent } from "./events.ts";
import { buildInitialState, type SimUnit, type SimulationState } from "./state.ts";
import { compareUnitIds } from "./snapshot.ts";
import { resolveTargetAndRoute } from "./targeting.ts";
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

/** 第一遍（目标遍历）的单棋子产出：结算期统一落账（决策期零突变）。 */
interface TargetOutcome {
  /** 非空 = 本 tick 发射一条目标事件（每单位至多一条；assigned 与 cleared 互斥）。 */
  targetEvent:
    | { kind: "assigned"; targetId: string; reason: "initial" | "retarget" }
    | { kind: "cleared" }
    | null;
  /** 本 tick 生效的目标；null = 无目标（本 tick 待机）。 */
  effectiveTargetId: string | null;
  /** 本 tick 生效的缓存路线；null = 沿用现有 remainingPath 不变。 */
  newPath: AxialCoord[] | null;
}

/** 第二遍（行动遍历）产出的移动意向；结算期按 unitId 升序（收集顺序）裁决执行。 */
interface MoveIntent {
  unitId: string;
  from: AxialCoord;
  to: AxialCoord;
}

/**
 * 第二遍产出的攻击提交（规格"已提交攻击必中"：基于 tick 开始的有效目标状态提交，
 * 目标在同 tick 移开或被其他攻击致死仍命中并计入伤害——提交与结算解耦）。
 */
interface AttackSubmission {
  attackerId: string;
  targetId: string;
}

function cellKey(cell: AxialCoord): string {
  return `${cell.q},${cell.r}`;
}

/**
 * simulate：完整推演到 BattleEnded，返回事件流。
 * - tick 循环 N = 1 … rules.timeoutTicks；每 tick：决策期（两遍扫描）→
 *   结算期（目标落账 → 移动结算 → 伤害/死亡[阶段 3]）→ 胜负检查；
 * - 所有存活棋子基于同一份 tick 开始状态决策（决策期对 state 零突变）；
 * - 胜负检查：wipeout 优先于 timeout（timeout 仅在末 tick 结算完成后判定）。
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

    // tick 开始占格集合（存活棋子）：决策与争格裁决共用的"tick 开始占格保护"事实来源。
    const occupiedAtTickStart = collectOccupied(state);

    // ---- 决策期（对 state 零突变）：按 actionOrder（unitId 升序）两遍扫描 ----
    // 第一遍（目标遍历）：目标验证 / 保留 / 重选 / 清除 + 缓存路线刷新（审查报告 §8.1）。
    const outcomes = new Map<string, TargetOutcome>();
    for (const unit of state.units) {
      if (!unit.alive) continue;
      outcomes.set(unit.unitId, resolveTargetOutcome(unit, state));
    }
    // 第二遍（行动遍历）：四态决策表（攻击 / 等待 / 移动 / 等待）——每棋子每 tick 至多一个动作。
    const moveIntents: MoveIntent[] = [];
    const attackSubmissions: AttackSubmission[] = [];
    for (const unit of state.units) {
      if (!unit.alive) continue;
      const outcome = outcomes.get(unit.unitId);
      if (!outcome) continue; // 防御性：第一遍已为全部存活单位产出
      decideAction(unit, outcome, state, occupiedAtTickStart, tick, moveIntents, attackSubmissions);
    }

    // ---- 结算期（统一落账）----
    applyTargetOutcomes(state, outcomes, tick, events);
    settleMoves(state, moveIntents, occupiedAtTickStart, input.rules.moveIntervalTicks, events);
    const damageByTarget = settleAttacks(state, attackSubmissions, events);
    settleDamage(state, damageByTarget, events);
    settleDeaths(state, events);

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

/** tick 开始占格集合：全部存活棋子的当前位置（死亡棋子的格自死亡结算起视为已释放）。 */
function collectOccupied(state: SimulationState): Set<string> {
  const occupied = new Set<string>();
  for (const unit of state.units) {
    if (unit.alive) occupied.add(cellKey(unit.position));
  }
  return occupied;
}

/**
 * 第一遍·目标遍历（规格 §目标保留与重选规则，每 tick 决策时执行）：
 * - 无目标（初始 / 已清除）→ 静默重试分配：resolved → TargetAssigned（首次 "initial"、
 *   其后 "retarget"，审查报告 §8.4 裁定）；无候选或全部不可达 → 保持无目标待机；
 * - 目标已死 → 重新选敌：找到 → TargetAssigned(retarget)，允许同 tick 行动；
 *   无有效新目标 → TargetCleared（清除过期目标与缓存路线），本 tick 待机；
 * - 目标存活且在射程内 → 保留目标（fresh hex 距离判定），缓存路线不动（脱离射程后可续用）；
 * - 目标存活、超射程且缓存非空 → 保留目标与路线（下一格被占的等待重试不在此处理，
 *   见 decideAction / settleMoves——审查报告 §8.1：不重算、不换目标）；
 * - 目标存活、超射程且缓存耗尽 → 重算路线（"必要时重算"）：命中其他候选 = 重选
 *   （TargetAssigned retarget）；命中当前目标 = 仅刷新路线，无事件；
 * - 重算后无可达候选 → 保留目标原地等待（审查报告 §8.5 裁定：存活目标不发 TargetCleared）。
 */
function resolveTargetOutcome(unit: SimUnit, state: SimulationState): TargetOutcome {
  if (unit.targetId === null) {
    const resolution = resolveTargetAndRoute(unit, state);
    if (resolution.kind === "resolved") {
      return {
        targetEvent: {
          kind: "assigned",
          targetId: resolution.targetId,
          reason: unit.hasAssignedTarget ? "retarget" : "initial",
        },
        effectiveTargetId: resolution.targetId,
        newPath: resolution.route.inRange ? [] : [...resolution.route.hexes],
      };
    }
    return { targetEvent: null, effectiveTargetId: null, newPath: null };
  }

  const target = state.units.find((candidate) => candidate.unitId === unit.targetId);
  if (!target || !target.alive) {
    const resolution = resolveTargetAndRoute(unit, state);
    if (resolution.kind === "resolved") {
      return {
        targetEvent: { kind: "assigned", targetId: resolution.targetId, reason: "retarget" },
        effectiveTargetId: resolution.targetId,
        newPath: resolution.route.inRange ? [] : [...resolution.route.hexes],
      };
    }
    return { targetEvent: { kind: "cleared" }, effectiveTargetId: null, newPath: [] };
  }

  if (hexDistance(unit.position, target.position) <= unit.range) {
    return { targetEvent: null, effectiveTargetId: unit.targetId, newPath: null };
  }
  if (unit.remainingPath.length > 0) {
    return { targetEvent: null, effectiveTargetId: unit.targetId, newPath: null };
  }
  const resolution = resolveTargetAndRoute(unit, state);
  if (resolution.kind === "resolved") {
    return {
      targetEvent:
        resolution.targetId !== unit.targetId
          ? { kind: "assigned", targetId: resolution.targetId, reason: "retarget" }
          : null,
      effectiveTargetId: resolution.targetId,
      newPath: resolution.route.inRange ? [] : [...resolution.route.hexes],
    };
  }
  return { targetEvent: null, effectiveTargetId: unit.targetId, newPath: null };
}

/**
 * 第二遍·行动遍历（规格 §Tick 决策与结算顺序 四态决策表）：
 * | 攻击 | 目标在射程 且 N ≥ attackReadyTick | 提交 Attack（阶段 3 接入） |
 * | 等待 | 目标在射程 且 N < attackReadyTick | 原地等待（不移动） |
 * | 移动 | 目标不在射程 且 N ≥ moveReadyTick 且下一格可进入 | 提交移动 |
 * | 等待 | 目标不在射程 且（N < moveReadyTick 或下一格不可进入） | 等待 |
 * 射程判定使用 fresh hex 距离（不依赖缓存路线）；"下一格可进入"按 tick 开始占格判定
 * （即使原占用者本 tick 同时离开，本 tick 亦不可进入——审查报告 §3）。
 */
function decideAction(
  unit: SimUnit,
  outcome: TargetOutcome,
  state: SimulationState,
  occupiedAtTickStart: Set<string>,
  tick: number,
  moveIntents: MoveIntent[],
  attackSubmissions: AttackSubmission[],
): void {
  const targetId = outcome.effectiveTargetId;
  if (targetId === null) return; // 无目标：本 tick 待机（I10）
  const target = state.units.find((candidate) => candidate.unitId === targetId);
  if (!target) return; // 防御性：第一遍已保证存活目标存在

  if (hexDistance(unit.position, target.position) <= unit.range) {
    // 攻击：目标在射程 且 N ≥ attackReadyTick → 提交攻击（已提交必中）；
    //       N < attackReadyTick → 原地等待（不移动——攻击等待不重置移动节奏）。
    if (tick >= unit.attackReadyTick) {
      attackSubmissions.push({ attackerId: unit.unitId, targetId });
    }
    return;
  }
  // 目标不在射程：按缓存路线取下一格（第一遍已刷新或保留）。
  const path = outcome.newPath ?? unit.remainingPath;
  const next = path[0];
  if (!next) return; // 无可达路线：保留目标等待（审查报告 §8.5）
  if (tick < unit.moveReadyTick) return; // 移动节奏未到：等待（moveReadyTick 不变）
  if (occupiedAtTickStart.has(cellKey(next))) {
    return; // 下一格被 tick 开始占格 → 等待重试、不换目标（审查报告 §8.1）
  }
  moveIntents.push({ unitId: unit.unitId, from: unit.position, to: next });
}

/**
 * 结算 1·目标落账：事件产出（类别固定顺序：先全部 TargetAssigned、再全部
 * TargetCleared，各类内按 unitId 升序——审查报告 §6）+ 状态写入。
 */
function applyTargetOutcomes(
  state: SimulationState,
  outcomes: Map<string, TargetOutcome>,
  tick: number,
  events: BattleEvent[],
): void {
  for (const unit of state.units) {
    const event = outcomes.get(unit.unitId)?.targetEvent;
    if (event?.kind === "assigned") {
      pushEvent(events, {
        type: "TargetAssigned",
        tick,
        unitId: unit.unitId,
        targetId: event.targetId,
        reason: event.reason,
      });
    }
  }
  for (const unit of state.units) {
    const event = outcomes.get(unit.unitId)?.targetEvent;
    if (event?.kind === "cleared") {
      pushEvent(events, { type: "TargetCleared", tick, unitId: unit.unitId });
    }
  }
  for (const unit of state.units) {
    if (!unit.alive) continue;
    const outcome = outcomes.get(unit.unitId);
    if (!outcome) continue;
    unit.targetId = outcome.effectiveTargetId;
    if (outcome.newPath !== null) {
      unit.remainingPath = outcome.newPath;
    }
    if (outcome.targetEvent?.kind === "assigned") {
      unit.hasAssignedTarget = true;
    }
  }
}

/**
 * 结算 2·移动结算（规格 §结算顺序 1）：按收集顺序（= actionOrder = unitId 升序）
 * 逐个执行。争格裁决：tick 开始被占据的格本 tick 任何单位不可进入（即使原占用者
 * 同时离开）；本 tick 已被更高序（先执行的）单位占用的格同理；败者停留、下 tick
 * 重试、不换目标（零落账：无事件、位置/缓存/节奏均不变）。
 */
function settleMoves(
  state: SimulationState,
  intents: MoveIntent[],
  occupiedAtTickStart: Set<string>,
  moveIntervalTicks: number,
  events: BattleEvent[],
): void {
  const takenThisTick = new Set<string>();
  for (const intent of intents) {
    const key = cellKey(intent.to);
    if (occupiedAtTickStart.has(key) || takenThisTick.has(key)) {
      continue; // 败者停留：moveReadyTick 不变，下 tick 重试（仅成功移动推进节奏）
    }
    takenThisTick.add(key);
    const unit = state.units.find((candidate) => candidate.unitId === intent.unitId);
    if (!unit || !unit.alive) continue; // 防御性：决策与结算之间无死亡（阶段 3 起亦然）
    unit.position = intent.to;
    unit.remainingPath.shift();
    unit.moveReadyTick = state.tick + moveIntervalTicks;
    pushEvent(events, {
      type: "UnitMoved",
      tick: state.tick,
      unitId: unit.unitId,
      from: intent.from,
      to: intent.to,
    });
  }
}

/**
 * 结算 3·攻击结算（规格 §结算顺序 2 前置）：按收集顺序（= actionOrder = unitId 升序）
 * 产出 Attack 事件并推进攻击冷却（冷却从实际攻击后起算）；同时按目标聚合本 tick
 * 全部已提交攻击的伤害（hpBefore 取 tick 开始 HP——伤害尚未落账）。
 * 已提交攻击必中：不检查目标当前生死（提交基于 tick 开始状态，死亡在死亡结算才生效）。
 */
function settleAttacks(
  state: SimulationState,
  submissions: AttackSubmission[],
  events: BattleEvent[],
): Map<string, { hpBefore: number; totalDamage: number }> {
  const damageByTarget = new Map<string, { hpBefore: number; totalDamage: number }>();
  for (const submission of submissions) {
    const attacker = state.units.find((candidate) => candidate.unitId === submission.attackerId);
    if (!attacker || !attacker.alive) continue; // 防御性：决策与结算之间无死亡
    pushEvent(events, {
      type: "Attack",
      tick: state.tick,
      attackerId: attacker.unitId,
      targetId: submission.targetId,
      damage: attacker.ad,
    });
    attacker.attackReadyTick = state.tick + attacker.attackCooldownTicks;
    const aggregated = damageByTarget.get(submission.targetId);
    if (aggregated) {
      aggregated.totalDamage += attacker.ad;
    } else {
      const target = state.units.find((candidate) => candidate.unitId === submission.targetId);
      damageByTarget.set(submission.targetId, {
        hpBefore: target ? target.hp : 0,
        totalDamage: attacker.ad,
      });
    }
  }
  return damageByTarget;
}

/**
 * 结算 4·伤害汇总（规格 §结算顺序 2）：每个受伤目标一条 HpChanged
 * （每目标每 tick 至多一条，I9；键按 compareUnitIds 排序产出），并落账 HP。
 */
function settleDamage(
  state: SimulationState,
  damageByTarget: Map<string, { hpBefore: number; totalDamage: number }>,
  events: BattleEvent[],
): void {
  const targetIds = [...damageByTarget.keys()].sort(compareUnitIds);
  for (const targetId of targetIds) {
    const aggregated = damageByTarget.get(targetId);
    if (!aggregated) continue;
    const target = state.units.find((candidate) => candidate.unitId === targetId);
    if (!target || !target.alive) continue; // 防御性
    const hpAfter = aggregated.hpBefore - aggregated.totalDamage;
    target.hp = hpAfter;
    pushEvent(events, {
      type: "HpChanged",
      tick: state.tick,
      unitId: targetId,
      hpBefore: aggregated.hpBefore,
      totalDamage: aggregated.totalDamage,
      hpAfter,
    });
  }
}

/**
 * 结算 5·死亡结算（规格 §结算顺序 3）：hpAfter ≤ 0 → UnitDied，移出棋盘并释放占格
 * （alive=false 自下一 tick 起不再阻挡/不再成为候选）；本 tick 无后续移动阶段，
 * "释放的位置下一 tick 才可使用"由结算顺序结构性保证。
 */
function settleDeaths(state: SimulationState, events: BattleEvent[]): void {
  for (const unit of state.units) {
    if (!unit.alive || unit.hp > 0) continue;
    unit.alive = false;
    pushEvent(events, {
      type: "UnitDied",
      tick: state.tick,
      unitId: unit.unitId,
      position: unit.position,
    });
  }
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
