// simulate 集成测试（T6 主接缝：SimulationInput 进、BattleEvent[] 出）。
// 规格依据：docs/specs/playable-core.md §引擎 API、§目标保留与重选规则、§Tick 决策与
// 结算顺序、§路径搜索与位置冲突、§事件 schema；Issue #6 五阶段检查点随 describe 分组
// 推进、在提交说明留痕。
//
// 预期值的独立事实来源：规格规则 + 各用例注释内记录的手工推演（offset↔axial 换算、
// BFS 逐层生成次序、目录数值与冷却换算、HP 链式算术），不依赖被测实现反推；
// 长事件流（F1/F4/F5）由"攻击 tick 时刻表字面量 + 目录数值"独立推导生成，
// 时刻表本身是手工推演的锚点；夹具场景 JSON 全部来自 tests/fixtures/scenarios/
// 单一来源体系（F11/F14 复用 T2 输入夹具，F3 复用 F2 几何）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AxialCoord } from "../src/engine/coordinates.ts";
import type {
  AttackEvent,
  BattleEndedEvent,
  BattleEvent,
  BattleStartedEvent,
  TargetAssignedEvent,
  TargetClearedEvent,
  UnitDiedEvent,
  UnitMovedEvent,
} from "../src/engine/events.ts";
import { previewInitial } from "../src/engine/preview.ts";
import { simulate } from "../src/engine/simulate.ts";
import { SimulationInputError } from "../src/engine/validate.ts";
import type { SimulationInput } from "../src/engine/types.ts";
import { defaultCatalog, defaultRules, loadScenarioFixture, rulesWith } from "./fixtures/loaders.ts";

function inputFor(scenarioName: string): SimulationInput {
  return {
    scenario: loadScenarioFixture(scenarioName) as SimulationInput["scenario"],
    catalog: defaultCatalog(),
    rules: defaultRules(),
  };
}

// ---- 预期事件构造器（sequence 显式传参 = 独立事实来源的手工编号）----

function started(sequence: number, scenarioId: string) {
  return {
    type: "BattleStarted" as const,
    sequence,
    tick: 0 as const,
    scenarioId,
    rulesSnapshot: { ticksPerSecond: 10, moveIntervalTicks: 5, timeoutTicks: 600 },
  };
}

function ta(
  sequence: number,
  tick: number,
  unitId: string,
  targetId: string,
  reason: "initial" | "retarget" = "initial",
) {
  return { type: "TargetAssigned" as const, sequence, tick, unitId, targetId, reason };
}

function tc(sequence: number, tick: number, unitId: string) {
  return { type: "TargetCleared" as const, sequence, tick, unitId };
}

function um(sequence: number, tick: number, unitId: string, from: AxialCoord, to: AxialCoord) {
  return { type: "UnitMoved" as const, sequence, tick, unitId, from, to };
}

function atk(sequence: number, tick: number, attackerId: string, targetId: string, damage: number) {
  return { type: "Attack" as const, sequence, tick, attackerId, targetId, damage };
}

function hp(
  sequence: number,
  tick: number,
  unitId: string,
  hpBefore: number,
  totalDamage: number,
  hpAfter: number,
) {
  return { type: "HpChanged" as const, sequence, tick, unitId, hpBefore, totalDamage, hpAfter };
}

function died(sequence: number, tick: number, unitId: string, position: AxialCoord) {
  return { type: "UnitDied" as const, sequence, tick, unitId, position };
}

function ended(
  sequence: number,
  tick: number,
  result: "blue" | "red" | "draw",
  reason: "wipeout" | "timeout",
) {
  return { type: "BattleEnded" as const, sequence, tick, result, reason };
}

// ---- 断言辅助 ----

function ofType<T extends BattleEvent["type"]>(
  events: BattleEvent[],
  type: T,
): Extract<BattleEvent, { type: T }>[] {
  return events.filter((event): event is Extract<BattleEvent, { type: T }> => event.type === type);
}

/** 某单位的实际移动轨迹（UnitMoved.to 序列）。 */
function movedPathOf(events: BattleEvent[], unitId: string): AxialCoord[] {
  return ofType(events, "UnitMoved")
    .filter((event) => event.unitId === unitId)
    .map((event) => event.to);
}

/** 某攻击者的攻击 tick 时刻表。 */
function attackTicksOf(events: BattleEvent[], attackerId: string): number[] {
  return ofType(events, "Attack")
    .filter((event) => event.attackerId === attackerId)
    .map((event) => event.tick);
}

/** 预览 = 实战（同源断言）：tick 1 初始分配（reason initial）必须与 previewInitial.targets 一致。 */
function assertInitialTargetsMatchPreview(events: BattleEvent[], input: SimulationInput): void {
  const preview = previewInitial(input);
  const expected = preview.targets.flatMap((entry) =>
    entry.targetId === null ? [] : [{ unitId: entry.unitId, targetId: entry.targetId }],
  );
  const actual = ofType(events, "TargetAssigned")
    .filter((event) => event.reason === "initial")
    .map((event) => ({ unitId: event.unitId, targetId: event.targetId }));
  assert.deepEqual(actual, expected, "tick 1 初始分配必须与 previewInitial 同源（预览 = 实战）");
}

/** 预览 = 实战（同源断言）：实际移动轨迹必须是预览路线的前缀。 */
function assertMovesFollowPreview(events: BattleEvent[], input: SimulationInput, unitId: string): void {
  const preview = previewInitial(input);
  const route = preview.routes.find((entry) => entry.unitId === unitId);
  const previewPath = route?.route.kind === "path" ? route.route.hexes : [];
  const moved = movedPathOf(events, unitId);
  assert.ok(
    moved.length <= previewPath.length,
    `${unitId} 移动步数（${moved.length}）不得超出预览路线长度（${previewPath.length}）`,
  );
  assert.deepEqual(
    moved,
    previewPath.slice(0, moved.length),
    `${unitId} 的实际移动必须沿预览路线逐格一致（预览 = 实战）`,
  );
}

// ---- 长事件流生成器（独立事实来源：攻击 tick 时刻表 + 目录数值 + 规格结算顺序）----

/** F1 全流：疾风剑士 vs 哨兵-盾卫贴脸互殴（cd 10 / cd 14，r1 第 13 次被击杀于 t121）。 */
function buildF1Expected(): object[] {
  const events: object[] = [];
  let seq = 0;
  const push = (event: Record<string, unknown>) => {
    events.push({ ...event, sequence: ++seq });
  };
  push(started(0, "fixture-f1-initial-engagement"));
  push({ type: "TargetAssigned", tick: 1, unitId: "r1", targetId: "u1", reason: "initial" });
  push({ type: "TargetAssigned", tick: 1, unitId: "u1", targetId: "r1", reason: "initial" });
  const u1Ticks = [1, 11, 21, 31, 41, 51, 61, 71, 81, 91, 101, 111, 121];
  const r1Ticks = [1, 15, 29, 43, 57, 71, 85, 99, 113];
  const ticks = [...new Set([...u1Ticks, ...r1Ticks])].sort((a, b) => a - b);
  let u1Hp = 650;
  let r1Hp = 900;
  for (const tick of ticks) {
    const r1Fires = r1Ticks.includes(tick);
    const u1Fires = u1Ticks.includes(tick);
    if (r1Fires) push({ type: "Attack", tick, attackerId: "r1", targetId: "u1", damage: 45 });
    if (u1Fires) push({ type: "Attack", tick, attackerId: "u1", targetId: "r1", damage: 70 });
    // HpChanged 按目标 unitId 升序产出（compareUnitIds 字典序："r1" < "u1"）
    if (u1Fires) {
      push({ type: "HpChanged", tick, unitId: "r1", hpBefore: r1Hp, totalDamage: 70, hpAfter: r1Hp - 70 });
      r1Hp -= 70;
    }
    if (r1Fires) {
      push({ type: "HpChanged", tick, unitId: "u1", hpBefore: u1Hp, totalDamage: 45, hpAfter: u1Hp - 45 });
      u1Hp -= 45;
    }
    if (r1Hp <= 0) {
      push({ type: "UnitDied", tick, unitId: "r1", position: { q: 2, r: 1 } });
      push({ type: "BattleEnded", tick, result: "blue", reason: "wipeout" });
      break;
    }
  }
  return events;
}

/** F4 全流：弩炮手 vs 接近中的哨兵-盾卫（t15 攻击与目标移动同 tick——已提交必中）。 */
function buildF4Expected(): object[] {
  const events: object[] = [];
  let seq = 0;
  const push = (event: Record<string, unknown>) => {
    events.push({ ...event, sequence: ++seq });
  };
  push(started(0, "fixture-f4-committed-attack"));
  push({ type: "TargetAssigned", tick: 1, unitId: "r1", targetId: "u1", reason: "initial" });
  push({ type: "TargetAssigned", tick: 1, unitId: "u1", targetId: "r1", reason: "initial" });
  push({ type: "Attack", tick: 1, attackerId: "u1", targetId: "r1", damage: 65 });
  push({ type: "HpChanged", tick: 1, unitId: "r1", hpBefore: 900, totalDamage: 65, hpAfter: 835 });
  push({ type: "UnitMoved", tick: 5, unitId: "r1", from: { q: 5, r: 1 }, to: { q: 4, r: 1 } });
  push({ type: "UnitMoved", tick: 10, unitId: "r1", from: { q: 4, r: 1 }, to: { q: 3, r: 1 } });
  push({ type: "UnitMoved", tick: 15, unitId: "r1", from: { q: 3, r: 1 }, to: { q: 2, r: 1 } });
  push({ type: "Attack", tick: 15, attackerId: "u1", targetId: "r1", damage: 65 });
  push({ type: "HpChanged", tick: 15, unitId: "r1", hpBefore: 835, totalDamage: 65, hpAfter: 770 });  const u1Ticks = [29, 43, 57, 71, 85, 99, 113, 127];
  const r1Ticks = [16, 30, 44, 58, 72, 86, 100, 114, 128];
  const ticks = [...new Set([...u1Ticks, ...r1Ticks])].sort((a, b) => a - b);
  let u1Hp = 400;
  let r1Hp = 770;
  for (const tick of ticks) {
    const r1Fires = r1Ticks.includes(tick);
    const u1Fires = u1Ticks.includes(tick);
    if (r1Fires) push({ type: "Attack", tick, attackerId: "r1", targetId: "u1", damage: 45 });
    if (u1Fires) push({ type: "Attack", tick, attackerId: "u1", targetId: "r1", damage: 65 });
    if (r1Fires) {
      push({ type: "HpChanged", tick, unitId: "u1", hpBefore: u1Hp, totalDamage: 45, hpAfter: u1Hp - 45 });
      u1Hp -= 45;
    }
    if (u1Fires) {
      push({ type: "HpChanged", tick, unitId: "r1", hpBefore: r1Hp, totalDamage: 65, hpAfter: r1Hp - 65 });
      r1Hp -= 65;
    }
    if (u1Hp <= 0) {
      push({ type: "UnitDied", tick, unitId: "u1", position: { q: 1, r: 1 } });
      push({ type: "BattleEnded", tick, result: "red", reason: "wipeout" });
      break;
    }
  }
  return events;
}

/** F5 全流：三疾风剑士同步齐射（cd 均 10），r1 每轮承伤 140，第 5 轮 t41 双亡边缘击杀。 */
function buildF5Expected(): object[] {
  const events: object[] = [];
  let seq = 0;
  const push = (event: Record<string, unknown>) => {
    events.push({ ...event, sequence: ++seq });
  };
  push(started(0, "fixture-f5-focus-aggregation"));
  push({ type: "TargetAssigned", tick: 1, unitId: "r1", targetId: "u1", reason: "initial" });
  push({ type: "TargetAssigned", tick: 1, unitId: "u1", targetId: "r1", reason: "initial" });
  push({ type: "TargetAssigned", tick: 1, unitId: "u2", targetId: "r1", reason: "initial" });
  let u1Hp = 650;
  let r1Hp = 650;
  for (const tick of [1, 11, 21, 31, 41]) {
    push({ type: "Attack", tick, attackerId: "r1", targetId: "u1", damage: 70 });
    push({ type: "Attack", tick, attackerId: "u1", targetId: "r1", damage: 70 });
    push({ type: "Attack", tick, attackerId: "u2", targetId: "r1", damage: 70 });
    // HpChanged 按目标 unitId 升序产出（"r1" < "u1"）
    push({ type: "HpChanged", tick, unitId: "r1", hpBefore: r1Hp, totalDamage: 140, hpAfter: r1Hp - 140 });
    r1Hp -= 140;
    push({ type: "HpChanged", tick, unitId: "u1", hpBefore: u1Hp, totalDamage: 70, hpAfter: u1Hp - 70 });
    u1Hp -= 70;
    if (r1Hp <= 0) {
      push({ type: "UnitDied", tick, unitId: "r1", position: { q: 2, r: 1 } });
      push({ type: "BattleEnded", tick, result: "blue", reason: "wipeout" });
      break;
    }
  }
  return events;
}

describe("simulate：valid-minimal 全流（基础推进与确定性）", () => {
  it("事件流关键事实：t1 初始分配、t5/t10 接近、t6 弓手首攻、t137 蓝方 wipeout", () => {
    // u1 = 哨兵-盾卫（蓝，近战）axial(1,1)；u2 = 弓手（红，射程 3）axial(2,4)。
    // u2 t5 移入射程 [(2,3)] → t6 首攻（冷却自实际攻击起算：次攻 t17 = 6+11）；
    // u1 t5/t10 两步接近后 t11 首攻；u2（450hp）在第 10 次被击（t137）阵亡。
    const events = simulate(inputFor("valid-minimal"));
    assert.equal(ofType(events, "BattleStarted").length, 1);
    assertInitialTargetsMatchPreview(events, inputFor("valid-minimal"));
    assert.deepEqual(attackTicksOf(events, "u2"), [6, 17, 28, 39, 50, 61, 72, 83, 94, 105, 116, 127]);
    assert.deepEqual(attackTicksOf(events, "u1"), [11, 25, 39, 53, 67, 81, 95, 109, 123, 137]);
    assert.deepEqual(
      ofType(events, "UnitMoved").map((event) => [event.unitId, event.tick]),
      [["u1", 5], ["u2", 5], ["u1", 10]],
    );
    assert.deepEqual(ofType(events, "UnitDied"), [
      { type: "UnitDied", sequence: 51, tick: 137, unitId: "u2", position: { q: 2, r: 3 } },
    ]);
    assert.deepEqual(ofType(events, "BattleEnded"), [
      { type: "BattleEnded", sequence: 52, tick: 137, result: "blue", reason: "wipeout" },
    ]);
  });

  it("I5 确定性：同输入两次运行事件流完全一致", () => {
    const input = inputFor("valid-minimal");
    assert.deepEqual(simulate(input), simulate(input));
  });

  it("rulesSnapshot 为输入 rules 的拷贝：运行后改动输入 rules 不影响已产出事件（纯函数纪律）", () => {
    const input = inputFor("valid-minimal");
    const events = simulate(input);
    const startedEvent = events[0] as BattleStartedEvent;
    input.rules.ticksPerSecond = 999;
    assert.equal(startedEvent.rulesSnapshot.ticksPerSecond, 10);
  });

  it("tick 上界由 rules.timeoutTicks 驱动：timeoutTicks=7 → BattleEnded.tick = 7（timeout 红方胜）", () => {
    const input = inputFor("valid-minimal");
    input.rules = rulesWith({ timeoutTicks: 7 });
    const events = simulate(input);
    const endedEvent = events[events.length - 1] as BattleEndedEvent;
    assert.equal(endedEvent.tick, 7);
    assert.equal(endedEvent.reason, "timeout");
    // t7 时弓手已命中盾卫一击（55）：remB×initR = 845×450 < remR×initB = 450×900 → 红方胜
    assert.equal(endedEvent.result, "red");
  });
});

describe("simulate：F1 初始接战（全流手工推演）", () => {
  it("事件流：t1 双方即攻；冷却节奏 10/14；r1 于 t121 被第 13 次击杀 → 蓝方 wipeout", () => {
    const events = simulate(inputFor("f1-initial-engagement"));
    assert.deepEqual(events, buildF1Expected());
  });

  it("I9 语义：击杀 tick 的 HpChanged 先于 UnitDied，hpAfter ≤ 0（I4 攻击全先于死亡事件）", () => {
    const events = simulate(inputFor("f1-initial-engagement"));
    const hpChanged = ofType(events, "HpChanged").at(-1);
    const died = ofType(events, "UnitDied").at(-1);
    assert.ok(hpChanged && died);
    assert.equal(hpChanged.unitId, "r1");
    assert.ok(hpChanged.hpAfter <= 0);
    assert.ok(hpChanged.sequence < died.sequence, "同 tick 的 HpChanged 必须先于 UnitDied");
  });

  it("I5 确定性双跑", () => {
    const input = inputFor("f1-initial-engagement");
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F2 首次移动时机与节奏", () => {
  const input = inputFor("f2-first-move-timing");

  it("I7 节奏合法：无 tick < moveIntervalTicks 的移动；移动间隔恰为 moveIntervalTicks", () => {
    const events = simulate(input);
    const moves = ofType(events, "UnitMoved");
    assert.deepEqual(
      moves.map((move) => [move.unitId, move.tick]),
      [["r1", 5], ["u1", 5], ["r1", 10]],
    );
    assert.deepEqual(attackTicksOf(events, "u1")[0], 6, "u1（弓手）t5 移入射程后 t6 首攻");
  });

  it("预览 = 实战：实际移动为预览路线前缀", () => {
    const events = simulate(input);
    assertInitialTargetsMatchPreview(events, input);
    assertMovesFollowPreview(events, input, "u1");
    assertMovesFollowPreview(events, input, "r1");
  });

  it("I5 确定性双跑", () => {
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F3 攻击冷却节奏（复用 F2 几何）", () => {
  it("冷却从实际攻击起算：u1 首攻 t6（移入射程后），次攻 t17 = 6+11 而非 1+11=12", () => {
    const events = simulate(inputFor("f2-first-move-timing"));
    assert.deepEqual(attackTicksOf(events, "u1"), [
      6, 17, 28, 39, 50, 61, 72, 83, 94, 105, 116, 127,
    ]);
    assert.deepEqual(attackTicksOf(events, "r1"), [
      11, 25, 39, 53, 67, 81, 95, 109, 123, 137,
    ]);
  });

  it("I6 冷却合法：同攻击者相邻两次 Attack 间隔 ≥ attackCooldownTicks（弓手 11 / 盾卫 14）", () => {
    const events = simulate(inputFor("f2-first-move-timing"));
    const u1Ticks = attackTicksOf(events, "u1");
    const r1Ticks = attackTicksOf(events, "r1");
    for (let index = 1; index < u1Ticks.length; index++) {
      assert.ok(u1Ticks[index]! - u1Ticks[index - 1]! >= 11);
    }
    for (let index = 1; index < r1Ticks.length; index++) {
      assert.ok(r1Ticks[index]! - r1Ticks[index - 1]! >= 14);
    }
  });
});

describe("simulate：F4 已提交攻击必中", () => {
  it("事件流（全流手工推演）：t15 目标移动与攻击同 tick，伤害照常计入", () => {
    const events = simulate(inputFor("f4-committed-attack"));
    assert.deepEqual(events, buildF4Expected());
  });

  it("同 tick 移开仍命中：t15 事件序 = UnitMoved(r1) → Attack(u1) → HpChanged(r1)", () => {
    // 攻击基于 tick 开始状态提交（r1 在 (3,1)，距 u1 为 2 ≤ 4）；r1 同 tick 移至 (2,1)
    // 也不影响命中——提交与结算解耦（规格"已提交攻击必中"）。
    const events = simulate(inputFor("f4-committed-attack"));
    const tick15 = events.filter((event) => event.tick === 15);
    assert.deepEqual(tick15, [
      um(8, 15, "r1", { q: 3, r: 1 }, { q: 2, r: 1 }),
      atk(9, 15, "u1", "r1", 65),
      hp(10, 15, "r1", 835, 65, 770),
    ]);
  });

  it("I5 确定性双跑", () => {
    const input = inputFor("f4-committed-attack");
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F5 集火汇总", () => {
  it("事件流（全流手工推演）：同 tick 2 次攻击聚合为单条 HpChanged（totalDamage = 140）", () => {
    const events = simulate(inputFor("f5-focus-aggregation"));
    assert.deepEqual(events, buildF5Expected());
  });

  it("I9 语义：每目标每 tick 至多一条 HpChanged；击杀 tick 的死亡攻击仍命中（r1 自己的攻击先于其死亡事件）", () => {
    const events = simulate(inputFor("f5-focus-aggregation"));
    const r1Changes = ofType(events, "HpChanged").filter((event) => event.unitId === "r1");
    assert.equal(r1Changes.length, 5, "5 个承伤 tick 各恰一条");
    const t41 = events.filter((event) => event.tick === 41);
    assert.deepEqual(t41, [
      atk(25, 41, "r1", "u1", 70),
      atk(26, 41, "u1", "r1", 70),
      atk(27, 41, "u2", "r1", 70),
      hp(28, 41, "r1", 90, 140, -50),
      hp(29, 41, "u1", 370, 70, 300),
      died(30, 41, "r1", { q: 2, r: 1 }),
      ended(31, 41, "blue", "wipeout"),
    ]);
  });

  it("I5 确定性双跑", () => {
    const input = inputFor("f5-focus-aggregation");
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F6 争格裁决（同格竞逐，按 unitId 升序先执行者胜）", () => {
  const input = inputFor("f6-contested-hex");

  it("败者停留且不换目标：u1 仅 t5 一次移动；无 TargetCleared / retarget；r1 于 t131 被击杀", () => {
    const events = simulate(input);
    assert.deepEqual(movedPathOf(events, "u1"), [{ q: 2, r: 1 }], "u1 争格失败后停留至接战");
    assert.deepEqual(movedPathOf(events, "r1"), [{ q: 4, r: 1 }, { q: 3, r: 1 }]);
    assert.equal(ofType(events, "TargetCleared").length, 0, "争格失败不得触发 TargetCleared");
    assert.deepEqual(
      ofType(events, "TargetAssigned").map((event) => event.reason),
      ["initial", "initial"],
      "仅 tick 1 的两条 initial 分配",
    );
    assert.deepEqual(ofType(events, "UnitDied"), [
      { type: "UnitDied", sequence: 51, tick: 131, unitId: "r1", position: { q: 3, r: 1 } },
    ]);
    assert.deepEqual(ofType(events, "BattleEnded"), [
      { type: "BattleEnded", sequence: 52, tick: 131, result: "blue", reason: "wipeout" },
    ]);
  });

  it("I5 确定性双跑", () => {
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F7 死亡释放格下一 tick 可用", () => {
  it("t61 r1 死亡；t62 u2 重选目标并进入其释放格 (2,1)——同 tick 不可入、次 tick 可入", () => {
    // r1 于 t61 被 u1 第 7 次攻击击杀（(2,1) 释放）；t62：u1/u2 重选 → r2；
    // u2 沿新路线 [(2,1), (2,0)] 进入手释放格（死亡结算后本 tick 无移动阶段，
    // 释放格自下一 tick 起可被 BFS 与占格判定使用）。
    const events = simulate(inputFor("f7-death-releases-cell"));
    const t61 = events.filter((event) => event.tick === 61);
    assert.deepEqual(t61, [
      atk(50, 61, "u1", "r1", 70),
      hp(51, 61, "r1", 60, 70, -10),
      died(52, 61, "r1", { q: 2, r: 1 }),
    ]);
    const t62 = events.filter((event) => event.tick === 62);
    assert.deepEqual(t62, [
      ta(53, 62, "u1", "r2", "retarget"),
      ta(54, 62, "u2", "r2", "retarget"),
      um(55, 62, "u2", { q: 2, r: 2 }, { q: 2, r: 1 }),
      atk(56, 62, "r2", "u1", 45),
      hp(57, 62, "u1", 245, 45, 200),
    ]);
    assert.equal(
      events.some((event) => event.type === "UnitMoved" && event.tick === 61),
      false,
      "死亡 tick 不得有任何单位进入释放格",
    );
  });

  it("I5 确定性双跑", () => {
    const input = inputFor("f7-death-releases-cell");
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F8 目标死亡重选（同 tick 攻击）", () => {
  it("t19 r1 被 3 名猎人击杀（u1 冷却未就绪不参与）；t20 u1 重选 r2 并立即攻击", () => {
    // u1（猎人，cd 9）首攻 t11 → 次攻就绪 t20；r1 于 t19 被 u2/u3/u4 第 3 轮齐射击杀；
    // t20 决策：u1 重选 → r2（距 (2,0) 为 2 ≤ 射程 2）→ TA(retarget) 与 Attack 同 tick。
    const events = simulate(inputFor("f8-target-death-retarget"));
    const t19 = events.filter((event) => event.tick === 19);
    assert.deepEqual(t19, [
      atk(28, 19, "u2", "r1", 48),
      atk(29, 19, "u3", "r1", 48),
      atk(30, 19, "u4", "r1", 48),
      hp(31, 19, "r1", 114, 144, -30),
      died(32, 19, "r1", { q: 4, r: 0 }),
    ]);
    assert.equal(
      events.some((event) => event.type === "Attack" && event.tick === 19 && event.attackerId === "u1"),
      false,
      "u1 冷却未就绪（t11 + 9 = 20），t19 不得提交攻击",
    );
    const t20 = events.filter((event) => event.tick === 20);
    assert.deepEqual(t20, [
      ta(33, 20, "u1", "r2", "retarget"),
      ta(34, 20, "u2", "r2", "retarget"),
      ta(35, 20, "u3", "r2", "retarget"),
      ta(36, 20, "u4", "r2", "retarget"),
      atk(37, 20, "u1", "r2", 48),
      hp(38, 20, "r2", 450, 48, 402),
    ]);
    assert.deepEqual(attackTicksOf(events, "u1"), [11, 20, 29, 38], "冷却严格自实际攻击起算");
  });

  it("I5 确定性双跑", () => {
    const input = inputFor("f8-target-death-retarget");
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F9 TargetCleared 触发与解围恢复", () => {
  it("t122 u1 目标清除；t123–154 无 u1 事件（静默重试）；t155 m1 死亡解封；t156 重选并恢复移动", () => {
    // 角落封锁几何：r2 驻 (0,0)，其仅有的两个盘内邻格 (1,0)/(0,1) 被 m1/m2 占驻
    // → r1 阵亡后 r2 对近战 u1 不可达 → TargetCleared；r2 持续攻击 m1（同距平局取
    // unitId 较小者），m1（500hp，每击 45）于 t155 被第 12 次攻击击杀 → 封锁解除；
    // t156 u1 重选 r2 并恢复移动（reason retarget）。
    const events = simulate(inputFor("f9-target-cleared-recovery"));
    assert.deepEqual(ofType(events, "TargetCleared"), [
      { type: "TargetCleared", sequence: 100, tick: 122, unitId: "u1" },
    ]);
    const silentWindow = events.filter(
      (event) => event.tick >= 123 && event.tick <= 154 && event.type !== "BattleEnded",
    );
    assert.equal(
      silentWindow.some((event) => "unitId" in event && event.unitId === "u1"),
      false,
      "TargetCleared 之后到下一条 TargetAssigned 之前，u1 不得产生 Attack / UnitMoved（I10）",
    );
    assert.deepEqual(
      events.filter((event) => event.tick === 155).map((event) => event.type),
      ["Attack", "HpChanged", "UnitDied"],
      "t155 r2 第 12 次攻击击杀 m1，封锁解除",
    );
    const t156 = events.filter((event) => event.tick === 156);
    assert.deepEqual(t156, [
      ta(114, 156, "r2", "m2", "retarget"),
      ta(115, 156, "u1", "r2", "retarget"),
      um(116, 156, "u1", { q: 5, r: 3 }, { q: 5, r: 2 }),
    ]);
  });

  it("I5 确定性双跑", () => {
    const input = inputFor("f9-target-cleared-recovery");
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F10 仅争格不换目标（后继者被驻守格持续阻挡）", () => {
  const input = inputFor("f10-block-no-retarget");

  it("事件流关键事实：u2 三步后自 t20 起被持续阻挡；w1/u1 击杀 r1（t61）终结战斗", () => {
    // 角落几何：r1 驻 (0,0)，w1 驻 (1,0)（开局即在射程）；(0,1) 为蓝方近战唯一可达终点。
    // u1 路线 [(0,2), (0,1)]、u2 路线 [(1,3), (1,2), (1,1), (0,1)]（(0,3) 为 u1 起始占格）。
    // u1 t10 驻守 (0,1) 后与 r1 接战；u2 的下一格 (0,1) 自 t20 起被 tick 开始占格 →
    // 等待重试、不换目标；r1 于 t61 被 w1（第 7 击）+ u1（第 6 击）合计 910 伤害击杀。
    const events = simulate(input);
    assert.deepEqual(movedPathOf(events, "u1"), [{ q: 0, r: 2 }, { q: 0, r: 1 }]);
    assert.deepEqual(movedPathOf(events, "u2"), [{ q: 1, r: 3 }, { q: 1, r: 2 }, { q: 1, r: 1 }]);
    assert.equal(
      ofType(events, "UnitMoved").some((event) => event.unitId === "u2" && event.tick > 15),
      false,
      "u2 必须自 t20 起因 (0,1) 被占而持续等待",
    );
    assert.equal(ofType(events, "TargetCleared").length, 0, "仅因下一格被占不得触发 TargetCleared");
    assert.deepEqual(
      ofType(events, "TargetAssigned").map((event) => event.reason),
      ["initial", "initial", "initial", "initial"],
    );
    assert.deepEqual(ofType(events, "UnitDied"), [
      { type: "UnitDied", sequence: 41, tick: 61, unitId: "r1", position: { q: 0, r: 0 } },
    ]);
    assert.deepEqual(ofType(events, "BattleEnded"), [
      { type: "BattleEnded", sequence: 42, tick: 61, result: "blue", reason: "wipeout" },
    ]);
    assert.deepEqual(attackTicksOf(events, "w1"), [1, 11, 21, 31, 41, 51, 61]);
    assert.deepEqual(attackTicksOf(events, "u1"), [11, 21, 31, 41, 51, 61]);
  });

  it("I5 确定性双跑", () => {
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F11 不可达换下一候选（战斗化，复用 T2 输入夹具）", () => {
  const input = inputFor("f11-unreachable-next-candidate");

  it("事件流关键事实：u1 沿预览路线推进至与 r2 相邻即停；r1 于 t43 被墙单位围杀、r2 于 t85 被击杀", () => {
    const events = simulate(input);
    assertInitialTargetsMatchPreview(events, input);
    assertMovesFollowPreview(events, input, "u1");
    assertMovesFollowPreview(events, input, "r2");
    assert.deepEqual(movedPathOf(events, "u1"), [
      { q: 1, r: 2 },
      { q: 2, r: 1 },
      { q: 3, r: 1 },
      { q: 4, r: 1 },
    ]);
    assert.deepEqual(movedPathOf(events, "r2"), [{ q: 5, r: 1 }, { q: 4, r: 2 }]);
    assert.deepEqual(
      ofType(events, "UnitDied").map((event) => [event.unitId, event.tick]),
      [["r1", 43], ["r2", 85]],
    );
    assert.deepEqual(ofType(events, "BattleEnded"), [
      { type: "BattleEnded", sequence: 116, tick: 85, result: "blue", reason: "wipeout" },
    ]);
  });

  it("I5 确定性双跑", () => {
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F14 BFS 确定性（战斗化，复用 T2 输入夹具）", () => {
  const input = inputFor("f14-bfs-determinism");

  it("事件流关键事实：双方沿固定邻居顺序路线各移一格后接战；r1 于 t126 被击杀", () => {
    const events = simulate(input);
    assertInitialTargetsMatchPreview(events, input);
    assertMovesFollowPreview(events, input, "u1");
    assertMovesFollowPreview(events, input, "r1");
    assert.deepEqual(movedPathOf(events, "u1"), [{ q: 2, r: 1 }]);
    assert.deepEqual(movedPathOf(events, "r1"), [{ q: 3, r: 1 }]);
    assert.deepEqual(attackTicksOf(events, "u1"), [
      6, 16, 26, 36, 46, 56, 66, 76, 86, 96, 106, 116, 126,
    ]);
    assert.deepEqual(ofType(events, "BattleEnded"), [
      { type: "BattleEnded", sequence: 51, tick: 126, result: "blue", reason: "wipeout" },
    ]);
  });

  it("I5 确定性双跑（含 BFS 路径完全一致）", () => {
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：强制校验门（与 previewInitial 同门同通道）", () => {
  it("E7 非法输入抛 SimulationInputError，携带结构化 ValidationError[]（复用 T1 夹具）", () => {
    const input = inputFor("f16-e7-empty-side");
    assert.throws(
      () => simulate(input),
      (error: unknown) =>
        error instanceof SimulationInputError &&
        error.errors.length === 1 &&
        error.errors[0]?.code === "EMPTY_SIDE" &&
        error.errors[0]?.path === "scenario.units",
    );
  });

  it("多错误聚合：unitId 重复与未知棋子定义同时报告", () => {
    const input = inputFor("valid-minimal");
    const units = input.scenario.units;
    if (!units[0] || !units[1]) throw new Error("夹具缺少预置棋子");
    units[1].unitId = units[0].unitId;
    units[1].unitDefId = "ghost-def";
    assert.throws(
      () => simulate(input),
      (error: unknown) =>
        error instanceof SimulationInputError &&
        error.errors
          .map((e) => e.code)
          .sort()
          .join(",") === "DUPLICATE_UNIT_ID,UNKNOWN_UNIT_DEF",
    );
  });

  it("结构残缺（缺 rules）以 TypeError 拒绝，不经 ValidationError 通道", () => {
    const input = inputFor("valid-minimal");
    delete (input as unknown as Record<string, unknown>).rules;
    assert.throws(() => simulate(input), TypeError);
  });
});
