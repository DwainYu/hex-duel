// 不变量检查器（T6，规格 docs/specs/playable-core.md §Testing Decisions 不变量清单）。
// 阶段 4 先落事件结构类不变量（I8 sequence 连续性 + 类别固定顺序 + 同类内 unitId 升序）；
// 阶段 5 补齐位置/目标/节奏类不变量（I1–I7、I9、I10）并对全部夹具接线。
// 独立事实来源：规格 §事件 schema 与 §Tick 决策与结算顺序的文字定义。
import assert from "node:assert/strict";

import type { BattleEvent } from "../../src/engine/events.ts";

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
