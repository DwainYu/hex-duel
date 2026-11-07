// 不变量检查器（T6，规格 docs/specs/playable-core.md §Testing Decisions 不变量清单 I1–I10）。
// 独立事实来源：规格 §事件 schema、§Tick 决策与结算顺序、§路径搜索与位置冲突的文字定义；
// 冷却换算复用 src/engine/cooldown.ts（其正确性由 cooldown.test.ts 以规格示例锁定），
// 坐标换算复用 src/engine/coordinates.ts（T1 坐标测试锁定）——不构成对被测实现的循环依赖。
//
// 位置/目标/节奏类不变量通过事件流重放检查（事件流是引擎对外唯一事实来源）：
// 从场景 JSON 重建初始占位与初始 HP，逐事件推进，不读取引擎内部状态。
import assert from "node:assert/strict";

import { attackCooldownTicks } from "../../src/engine/cooldown.ts";
import {
  axialToOffset,
  isOnBoard,
  offsetToAxial,
  type AxialCoord,
} from "../../src/engine/coordinates.ts";
import type { BattleEvent } from "../../src/engine/events.ts";
import { simulate } from "../../src/engine/simulate.ts";
import type { SimulationInput } from "../../src/engine/types.ts";

/** 事件类别固定顺序（规格 §事件 schema）：BattleStarted 为 tick 0 前置，其余按序。 */
const CATEGORY_ORDER: Record<BattleEvent["type"], number> = {
  BattleStarted: -1,
  TargetAssigned: 0,
  TargetCleared: 1,
  UnitMoved: 2,
  Attack: 3,
  HpChanged: 4,
  UnitDied: 5,
  BattleEnded: 6,
};

/** 事件内的排序键字段：Attack 按 attackerId，其余决策/结算事件按 unitId。 */
function sortKeyOf(event: BattleEvent): string | null {
  if (event.type === "Attack") return event.attackerId;
  if (
    event.type === "TargetAssigned" ||
    event.type === "TargetCleared" ||
    event.type === "UnitMoved" ||
    event.type === "HpChanged" ||
    event.type === "UnitDied"
  ) {
    return event.unitId;
  }
  return null; // BattleStarted / BattleEnded 无 unitId 维度
}

function cellKey(cell: AxialCoord): string {
  return `${cell.q},${cell.r}`;
}

function ofType<T extends BattleEvent["type"]>(
  events: BattleEvent[],
  type: T,
): Extract<BattleEvent, { type: T }>[] {
  return events.filter((event): event is Extract<BattleEvent, { type: T }> => event.type === type);
}

function unitDefOf(input: SimulationInput, unitId: string) {
  const scenarioUnit = input.scenario.units.find((unit) => unit.unitId === unitId);
  if (!scenarioUnit) return undefined;
  return input.catalog.units.find((def) => def.unitDefId === scenarioUnit.unitDefId);
}

/**
 * I8 + 事件结构不变量（对任意完整事件流检查）：
 * 1. sequence 从 1 开始、按产出顺序连续不跳号；
 * 2. BattleStarted 为首个事件且 tick = 0；BattleEnded 为末个事件；
 * 3. 每 tick 内事件类别按固定顺序递增（TargetAssigned → TargetCleared → UnitMoved →
 *    Attack → HpChanged → UnitDied）；
 * 4. 同 tick 同类事件按 unitId（Attack 按 attackerId）升序。
 */
export function assertEventStructure(events: BattleEvent[]): void {
  events.forEach((event, index) => {
    assert.equal(event.sequence, index + 1, "sequence 必须从 1 开始连续不跳号（I8）");
  });
  assert.ok(events.length >= 2, "事件流至少含 BattleStarted 与 BattleEnded");
  assert.equal(events[0]?.type, "BattleStarted", "BattleStarted 必须是首个事件");
  assert.equal(events[0]?.tick, 0, "BattleStarted 为 tick 0");
  assert.equal(events.at(-1)?.type, "BattleEnded", "BattleEnded 必须是末个事件");

  let previousTick = 0;
  let previousCategory = Number.NEGATIVE_INFINITY;
  let previousKey: string | null = null;
  for (const event of events) {
    if (event.type === "BattleStarted") continue;
    if (event.tick !== previousTick) {
      previousTick = event.tick;
      previousCategory = Number.NEGATIVE_INFINITY;
      previousKey = null;
    }
    const category = CATEGORY_ORDER[event.type];
    assert.ok(
      category >= previousCategory,
      `tick ${event.tick} 的 ${event.type} 违反类别固定顺序（前一类别 ${previousCategory}）`,
    );
    const key = sortKeyOf(event);
    // 同类内 unitId 升序：仅在本事件与前一事件同类（类别未切换）时比较
    if (key !== null && category === previousCategory) {
      assert.ok(
        previousKey === null || previousKey <= key,
        `tick ${event.tick} 的同类事件 ${event.type} 违反 unitId 升序：${previousKey} → ${key}`,
      );
    }
    previousCategory = category;
    previousKey = key;
  }
}

/**
 * I1 / I2 / I3 / I4 / I9 / I10（事件流重放）：
 * - I1 位置合法：每个 tick 结算后所有存活棋子在棋盘内且互不重叠；
 * - I2 无非法占格：UnitMoved 的目标格在该 tick 开始时未被占用，且本 tick 未被
 *   更高序（先结算的）单位占用；from 与重放位置一致；
 * - I3 目标有效：每条 Attack 的目标在该 tick 开始时存活（同 tick 死亡 = 已提交必中，合法）；
 * - I4 死亡不可攻击：UnitDied 之后不再出现对该 unitId 的 Attack
 *   （同 tick 的 Attack 全部先于 UnitDied，按 sequence 判定）；
 * - I9 每目标每 tick 至多一条 HpChanged；hpBefore 链与初始 HP 一致；
 *   hpAfter = hpBefore − totalDamage；hpAfter ≤ 0 ⇒ 该 tick 存在对应 UnitDied；
 * - I10 无目标不行动：从未分配目标、以及 TargetCleared 之后到下一条 TargetAssigned
 *   之前，不产生该单位的 Attack / UnitMoved。
 */
export function checkReplayInvariants(input: SimulationInput, events: BattleEvent[]): void {
  const positions = new Map<string, AxialCoord>();
  const alive = new Map<string, boolean>();
  const hpChain = new Map<string, number>();
  for (const unit of input.scenario.units) {
    positions.set(unit.unitId, offsetToAxial(unit.position.col, unit.position.row));
    alive.set(unit.unitId, true);
    const def = unitDefOf(input, unit.unitId);
    assert.ok(def, `重放前提：unitDefId ${unit.unitDefId} 必在目录（输入已过校验门）`);
    hpChain.set(unit.unitId, def.hp);
  }

  const diedAt = new Map<string, { tick: number; sequence: number }>();
  const targetState = new Map<string, "never" | "assigned" | "cleared">();

  // tick 开始占格（存活棋子）与本 tick 已被先执行单位占用的格
  let tickStartOccupied = new Set<string>();
  let takenThisTick = new Set<string>();
  const refreshTickStart = (): void => {
    tickStartOccupied = new Set(
      [...positions.entries()]
        .filter(([unitId]) => alive.get(unitId))
        .map(([, cell]) => cellKey(cell)),
    );
    takenThisTick = new Set();
  };
  refreshTickStart();

  /** I1：当前快照中所有存活棋子在棋盘内且互不重叠（每个 tick 结算后调用）。 */
  const assertTickBoundary = (tick: number): void => {
    const seen = new Set<string>();
    for (const [unitId, cell] of positions) {
      if (!alive.get(unitId)) continue;
      const offset = axialToOffset(cell.q, cell.r);
      assert.ok(
        isOnBoard(offset.col, offset.row),
        `I1 tick ${tick}：存活棋子 ${unitId} 越界 (${cell.q},${cell.r})`,
      );
      const key = cellKey(cell);
      assert.ok(
        !seen.has(key),
        `I1 tick ${tick}：存活棋子 ${unitId} 与他人重叠于 (${cell.q},${cell.r})`,
      );
      seen.add(key);
    }
  };

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const next = events[index + 1];
    const isTickEnd = next === undefined || next.tick !== event.tick;

    switch (event.type) {
      case "TargetAssigned": {
        targetState.set(event.unitId, "assigned");
        break;
      }
      case "TargetCleared": {
        targetState.set(event.unitId, "cleared");
        break;
      }
      case "UnitMoved": {
        const state = targetState.get(event.unitId) ?? "never";
        assert.equal(
          state,
          "assigned",
          `I10 tick ${event.tick}：${event.unitId} 无有效目标却移动`,
        );
        const key = cellKey(event.to);
        assert.ok(
          !tickStartOccupied.has(key),
          `I2 tick ${event.tick}：${event.unitId} 进入 tick 开始被占格 (${event.to.q},${event.to.r})`,
        );
        assert.ok(
          !takenThisTick.has(key),
          `I2 tick ${event.tick}：${event.unitId} 进入本 tick 已被先执行单位占用的格 (${event.to.q},${event.to.r})`,
        );
        takenThisTick.add(key);
        assert.deepEqual(
          positions.get(event.unitId),
          event.from,
          `I2 tick ${event.tick}：${event.unitId} 的 from 与重放位置不一致`,
        );
        positions.set(event.unitId, event.to);
        break;
      }
      case "Attack": {
        const state = targetState.get(event.attackerId) ?? "never";
        assert.equal(
          state,
          "assigned",
          `I10 tick ${event.tick}：${event.attackerId} 无有效目标却攻击`,
        );
        const death = diedAt.get(event.targetId);
        if (death) {
          assert.ok(
            death.tick >= event.tick,
            `I3 tick ${event.tick}：Attack 的目标 ${event.targetId} 已于 tick ${death.tick} 死亡`,
          );
          if (death.tick === event.tick) {
            assert.ok(
              event.sequence < death.sequence,
              `I4 tick ${event.tick}：对 ${event.targetId} 的 Attack 未先于其 UnitDied`,
            );
          }
        }
        break;
      }
      case "HpChanged": {
        const expected = hpChain.get(event.unitId);
        assert.ok(
          expected !== undefined && expected === event.hpBefore,
          `I9 tick ${event.tick}：${event.unitId} 的 hpBefore ${event.hpBefore} 与重放链 ${expected} 不一致`,
        );
        assert.equal(
          event.hpAfter,
          event.hpBefore - event.totalDamage,
          `I9 tick ${event.tick}：${event.unitId} 的 hpAfter ≠ hpBefore − totalDamage`,
        );
        hpChain.set(event.unitId, event.hpAfter);
        break;
      }
      case "UnitDied": {
        alive.set(event.unitId, false);
        diedAt.set(event.unitId, { tick: event.tick, sequence: event.sequence });
        break;
      }
      default:
        break;
    }

    if (isTickEnd) {
      assertTickBoundary(event.tick);
      refreshTickStart();
    }
  }

  // I9 补充：每目标每 tick 至多一条 HpChanged
  const seenHp = new Set<string>();
  for (const event of ofType(events, "HpChanged")) {
    const key = `${event.unitId}@${event.tick}`;
    assert.ok(!seenHp.has(key), `I9：${event.unitId} 在 tick ${event.tick} 出现多条 HpChanged`);
    seenHp.add(key);
  }
  // I9 补充：hpAfter ≤ 0 ⇒ 同 tick 存在对应 UnitDied
  const deaths = new Set(ofType(events, "UnitDied").map((event) => `${event.unitId}@${event.tick}`));
  for (const event of ofType(events, "HpChanged")) {
    if (event.hpAfter <= 0) {
      assert.ok(
        deaths.has(`${event.unitId}@${event.tick}`),
        `I9：${event.unitId} 在 tick ${event.tick} hpAfter ≤ 0 却无 UnitDied`,
      );
    }
  }
  // I6：同一攻击者相邻两次 Attack 间隔 ≥ attackCooldownTicks
  const ticksByAttacker = new Map<string, number[]>();
  for (const event of ofType(events, "Attack")) {
    const ticks = ticksByAttacker.get(event.attackerId) ?? [];
    ticks.push(event.tick);
    ticksByAttacker.set(event.attackerId, ticks);
  }
  for (const [attackerId, ticks] of ticksByAttacker) {
    const def = unitDefOf(input, attackerId);
    assert.ok(def, `I6：攻击者 ${attackerId} 必有目录定义`);
    const cooldown = attackCooldownTicks(input.rules, def.attackSpeed);
    for (let index = 1; index < ticks.length; index++) {
      assert.ok(
        ticks[index]! - ticks[index - 1]! >= cooldown,
        `I6：${attackerId} 相邻攻击间隔 ${ticks[index]! - ticks[index - 1]!} < 冷却 ${cooldown}`,
      );
    }
  }
  // I7：同一单位首次移动 tick ≥ moveIntervalTicks，且相邻移动间隔 ≥ moveIntervalTicks
  const ticksByMover = new Map<string, number[]>();
  for (const event of ofType(events, "UnitMoved")) {
    const ticks = ticksByMover.get(event.unitId) ?? [];
    ticks.push(event.tick);
    ticksByMover.set(event.unitId, ticks);
  }
  for (const [unitId, ticks] of ticksByMover) {
    assert.ok(
      ticks[0]! >= input.rules.moveIntervalTicks,
      `I7：${unitId} 首次移动 tick ${ticks[0]} < moveIntervalTicks`,
    );
    for (let index = 1; index < ticks.length; index++) {
      assert.ok(
        ticks[index]! - ticks[index - 1]! >= input.rules.moveIntervalTicks,
        `I7：${unitId} 相邻移动间隔 ${ticks[index]! - ticks[index - 1]!} < moveIntervalTicks`,
      );
    }
  }
}

/**
 * I1–I10 全量检查入口：对同一输入做确定性双跑（I5），并对首跑事件流执行
 * 结构与重放不变量。任何一条失败即抛出断言异常。
 */
export function checkAllInvariants(input: SimulationInput): void {
  const first = simulate(input);
  const second = simulate(input);
  assert.deepEqual(first, second, "I5 确定性：同输入两次运行事件流必须完全一致");
  assertEventStructure(first);
  checkReplayInvariants(input, first);
}
