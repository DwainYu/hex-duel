// simulate 集成测试（T6 主接缝：SimulationInput 进、BattleEvent[] 出）。
// 规格依据：docs/specs/playable-core.md §引擎 API、§Tick 决策与结算顺序、§事件 schema；
// Issue #6 五阶段检查点随 describe 分组推进、在提交说明留痕。
//
// 预期值的独立事实来源：规格规则 + 各用例注释内记录的手工推演（offset↔axial 换算、
// BFS 逐层生成次序、目录数值与冷却换算），不依赖被测实现反推；
// 夹具场景 JSON 全部来自 tests/fixtures/scenarios/ 单一来源体系（F11/F14 复用 T2 输入）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AxialCoord } from "../src/engine/coordinates.ts";
import type {
  BattleEndedEvent,
  BattleEvent,
  BattleStartedEvent,
  TargetAssignedEvent,
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

function um(sequence: number, tick: number, unitId: string, from: AxialCoord, to: AxialCoord) {
  return { type: "UnitMoved" as const, sequence, tick, unitId, from, to };
}

function ended(
  sequence: number,
  tick: number,
  result: "blue" | "red" | "draw",
  reason: "wipeout" | "timeout",
) {
  return { type: "BattleEnded" as const, sequence, tick, result, reason };
}

/** 某单位的实际移动轨迹（UnitMoved.to 序列）。 */
function movedPathOf(events: BattleEvent[], unitId: string): AxialCoord[] {
  return events
    .filter((event): event is UnitMovedEvent => event.type === "UnitMoved" && event.unitId === unitId)
    .map((event) => event.to);
}

/** 预览 = 实战（同源断言）：tick 1 初始分配（reason initial）必须与 previewInitial.targets 一致。 */
function assertInitialTargetsMatchPreview(events: BattleEvent[], input: SimulationInput): void {
  const preview = previewInitial(input);
  const expected = preview.targets.flatMap((entry) =>
    entry.targetId === null ? [] : [{ unitId: entry.unitId, targetId: entry.targetId }],
  );
  const actual = events
    .filter((event): event is TargetAssignedEvent => event.type === "TargetAssigned" && event.reason === "initial")
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

describe("simulate：valid-minimal 全流（基础推进与确定性）", () => {
  it("事件流：tick 1 初始分配 + 双方接近 + 超时平局（手工推演全流）", () => {
    // u1 = 哨兵-盾卫（蓝，射程 1）axial(1,1)；u2 = 弓手（红，射程 3）axial(2,4)，相距 4。
    // u2 距目标 4 > 3 → BFS 首个射程内终点 (2,3)（首层 (0,-1) 方向生成）→ 路线 [(2,3)]。
    // u1 路线 [(2,1), (2,2), (2,3)]（绕开 u2 起点）。t5 双方各移一格；
    // t10 u1 移至 (2,2) 后与 u2（t5 起驻 (2,3)）相邻 → in-range 停止。
    const events = simulate(inputFor("valid-minimal"));
    assert.deepEqual(events, [
      started(1, "fixture-valid-minimal"),
      ta(2, 1, "u1", "u2"),
      ta(3, 1, "u2", "u1"),
      um(4, 5, "u1", { q: 1, r: 1 }, { q: 2, r: 1 }),
      um(5, 5, "u2", { q: 2, r: 4 }, { q: 2, r: 3 }),
      um(6, 10, "u1", { q: 2, r: 1 }, { q: 2, r: 2 }),
      ended(7, 600, "draw", "timeout"),
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

  it("tick 上界由 rules.timeoutTicks 驱动：timeoutTicks=7 → BattleEnded.tick = 7", () => {
    const input = inputFor("valid-minimal");
    input.rules = rulesWith({ timeoutTicks: 7 });
    const events = simulate(input);
    const endedEvent = events[events.length - 1] as BattleEndedEvent;
    assert.equal(endedEvent.tick, 7);
    assert.equal(endedEvent.reason, "timeout");
    assert.equal(endedEvent.result, "draw");
  });
});

describe("simulate：F2 首次移动时机与节奏", () => {
  const input = inputFor("f2-first-move-timing");

  it("事件流：t5 双方首移（≥ moveIntervalTicks）；u1（弓手）进入射程即停；r1 t10 抵达", () => {
    // u1 = 弓手（射程 3）axial(1,1)，r1 = 哨兵-盾卫 axial(5,1)，同排相距 4。
    // u1 路线 [(2,1)]（(2,1) 距 r1 为 3 ≤ 3，首层即终点）；r1 路线 [(4,1), (3,1), (2,1)]。
    // t5：r1→(4,1)、u1→(2,1)（结算按 unitId 升序：r1 先于 u1）。
    // t10：r1→(3,1)；u1 已在射程（距 (4,1) 为 2 ≤ 3）不再移动。
    // t15：r1 与 u1 相邻（距离 1 ≤ 1）进入射程停止；此后静默至超时。
    const events = simulate(input);
    assert.deepEqual(events, [
      started(1, "fixture-f2-first-move-timing"),
      ta(2, 1, "r1", "u1"),
      ta(3, 1, "u1", "r1"),
      um(4, 5, "r1", { q: 5, r: 1 }, { q: 4, r: 1 }),
      um(5, 5, "u1", { q: 1, r: 1 }, { q: 2, r: 1 }),
      um(6, 10, "r1", { q: 4, r: 1 }, { q: 3, r: 1 }),
      ended(7, 600, "draw", "timeout"),
    ]);
  });

  it("I7 节奏合法：无 tick < moveIntervalTicks 的移动；同单位相邻移动间隔 ≥ moveIntervalTicks", () => {
    const events = simulate(input);
    const moves = events.filter((event): event is UnitMovedEvent => event.type === "UnitMoved");
    assert.ok(moves.length >= 3);
    for (const move of moves) {
      assert.ok(move.tick >= 5, `首次移动 tick ${move.tick} 必须 ≥ moveIntervalTicks=5`);
    }
    const r1Moves = moves.filter((move) => move.unitId === "r1").map((move) => move.tick);
    assert.deepEqual(r1Moves, [5, 10], "r1 移动间隔必须恰为 moveIntervalTicks=5");
  });

  it("I5 确定性双跑", () => {
    const input = inputFor("f2-first-move-timing");
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F6 争格裁决（同格竞逐，按 unitId 升序先执行者胜）", () => {
  const input = inputFor("f6-contested-hex");

  it("事件流：t10 双方争 (3,1)，r1（unitId 较小）胜出，u1 败者停留且不换目标", () => {
    // u1 = 疾风剑士 axial(1,1)、r1 = 哨兵-盾卫 axial(5,1)，同排相距 4，路线相向：
    // u1 = [(2,1), (3,1), (4,1)]；r1 = [(4,1), (3,1), (2,1)]。
    // t5：r1→(4,1)、u1→(2,1)。t10：双方下一格同为 (3,1)（tick 开始均空闲，均提交）；
    // 结算 r1 先执行占 (3,1)，u1 落败停留（零事件、moveReadyTick 不变、不换目标）。
    // t11 起双方相邻进入射程 → 等待至超时。
    const events = simulate(input);
    assert.deepEqual(events, [
      started(1, "fixture-f6-contested-hex"),
      ta(2, 1, "r1", "u1"),
      ta(3, 1, "u1", "r1"),
      um(4, 5, "r1", { q: 5, r: 1 }, { q: 4, r: 1 }),
      um(5, 5, "u1", { q: 1, r: 1 }, { q: 2, r: 1 }),
      um(6, 10, "r1", { q: 4, r: 1 }, { q: 3, r: 1 }),
      ended(7, 600, "draw", "timeout"),
    ]);
  });

  it("败者停留：u1 全程仅 1 次移动，且无 TargetCleared / 重选事件（仅因争格不换目标）", () => {
    const events = simulate(inputFor("f6-contested-hex"));
    assert.equal(movedPathOf(events, "u1").length, 1, "u1 在 t5 移动一次后必须停留");
    assert.equal(
      events.some((event) => event.type === "TargetCleared"),
      false,
      "争格失败不得触发 TargetCleared",
    );
    assert.equal(
      events.filter((event): event is TargetAssignedEvent => event.type === "TargetAssigned").length,
      2,
      "仅允许 tick 1 的两条 initial 分配，不得出现 retarget",
    );
  });

  it("I5 确定性双跑", () => {
    const input = inputFor("f6-contested-hex");
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F10 仅争格不换目标（后继者被驻守格持续阻挡）", () => {
  const input = inputFor("f10-block-no-retarget");

  it("事件流：u1 驻守唯一射程内空格 (0,1) 后，u2 的下一格被 tick 开始占格，此后永久等待", () => {
    // 角落几何（唯一射程内空格，endpoint 被强制汇聚）：r1 = 哨兵-盾卫驻角落 axial(0,0)
    // （offset(1,1)，角格仅 (1,0)/(0,1) 两个盘内邻格）；w1 = 疾风剑士 axial(1,0)
    // （offset(2,1)）开局即在射程 → 全程驻守 (1,0)；(0,1) 成为蓝方近战唯一可达终点。
    // u1 = 疾风剑士 axial(0,3)（offset(2,4)）路线 [(0,2), (0,1)]；
    // u2 = 疾风剑士 axial(0,4)（offset(3,5)）路线 [(1,3), (1,2), (1,1), (0,1)]（(0,3) 为
    // u1 起始占格，BFS 绕行）。t5/t10 双方按节奏各移一格；t15 u2 移至 (1,1)；
    // t20 起 u2 的下一格 (0,1) 被 tick 开始占格（u1 于 t10 驻守）→ 等待重试、
    // 不换目标、不重算路线，直至超时。
    const events = simulate(input);
    assert.deepEqual(events, [
      started(1, "fixture-f10-block-no-retarget"),
      ta(2, 1, "r1", "w1"),
      ta(3, 1, "u1", "r1"),
      ta(4, 1, "u2", "r1"),
      ta(5, 1, "w1", "r1"),
      um(6, 5, "u1", { q: 0, r: 3 }, { q: 0, r: 2 }),
      um(7, 5, "u2", { q: 0, r: 4 }, { q: 1, r: 3 }),
      um(8, 10, "u1", { q: 0, r: 2 }, { q: 0, r: 1 }),
      um(9, 10, "u2", { q: 1, r: 3 }, { q: 1, r: 2 }),
      um(10, 15, "u2", { q: 1, r: 2 }, { q: 1, r: 1 }),
      ended(11, 600, "draw", "timeout"),
    ]);
  });

  it("被阻挡者不换目标：u2 无 TargetCleared / retarget，且 t15 后无移动", () => {
    const events = simulate(inputFor("f10-block-no-retarget"));
    assert.equal(
      events.some((event) => event.type === "TargetCleared"),
      false,
      "仅因下一格被占不得触发 TargetCleared",
    );
    const u2Moves = events.filter(
      (event): event is UnitMovedEvent => event.type === "UnitMoved" && event.unitId === "u2",
    );
    assert.deepEqual(
      u2Moves.map((move) => move.tick),
      [5, 10, 15],
      "u2 必须在 t15 后因 (0,1) 被占而持续等待",
    );
  });

  it("I5 确定性双跑", () => {
    const input = inputFor("f10-block-no-retarget");
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F11 不可达换下一候选（战斗化，复用 T2 输入夹具）", () => {
  const input = inputFor("f11-unreachable-next-candidate");

  it("事件流：初始分配与 T2 预览同源；u1 沿预览路线推进至与 r2 相邻即停", () => {
    // T2 预览（同源事实来源）：r1→w1（in-range）、r2→w1（路线 [(5,1), (4,2)]）、
    // u1→r2（路线 [(1,2), (2,1), (3,1), (4,1), (5,1)]）、w1–w6→r1（in-range）。
    // t5/t10：r2 与 u1 各移一格（互不冲突）；r2 抵达 (4,2) 后与 w1 相邻停止；
    // u1 依次推进，t20 抵达 (4,1) 后与 r2（距离 1）进入射程 → fresh 判定优先，
    // 不再消费缓存的第 5 步 (5,1)，静默至超时。
    const events = simulate(input);
    assert.deepEqual(events, [
      started(1, "fixture-f11-unreachable-next-candidate"),
      ta(2, 1, "r1", "w1"),
      ta(3, 1, "r2", "w1"),
      ta(4, 1, "u1", "r2"),
      ta(5, 1, "w1", "r1"),
      ta(6, 1, "w2", "r1"),
      ta(7, 1, "w3", "r1"),
      ta(8, 1, "w4", "r1"),
      ta(9, 1, "w5", "r1"),
      ta(10, 1, "w6", "r1"),
      um(11, 5, "r2", { q: 6, r: 0 }, { q: 5, r: 1 }),
      um(12, 5, "u1", { q: 0, r: 3 }, { q: 1, r: 2 }),
      um(13, 10, "r2", { q: 5, r: 1 }, { q: 4, r: 2 }),
      um(14, 10, "u1", { q: 1, r: 2 }, { q: 2, r: 1 }),
      um(15, 15, "u1", { q: 2, r: 1 }, { q: 3, r: 1 }),
      um(16, 20, "u1", { q: 3, r: 1 }, { q: 4, r: 1 }),
      ended(17, 600, "draw", "timeout"),
    ]);
  });

  it("预览 = 实战：初始分配与两条路线均与 previewInitial 同源", () => {
    const events = simulate(inputFor("f11-unreachable-next-candidate"));
    assertInitialTargetsMatchPreview(events, input);
    assertMovesFollowPreview(events, input, "u1");
    assertMovesFollowPreview(events, input, "r2");
  });

  it("I5 确定性双跑", () => {
    assert.deepEqual(simulate(input), simulate(input));
  });
});

describe("simulate：F14 BFS 确定性（战斗化，复用 T2 输入夹具）", () => {
  const input = inputFor("f14-bfs-determinism");

  it("事件流：双方沿固定邻居顺序的路线各移一格后相邻停止（与 T2 预览逐格一致）", () => {
    // T2 预览：u1(axial(1,1)) 路线 [(2,1), (3,1)]；r1(axial(3,2)) 路线 [(3,1), (2,1)]。
    // t5 各移首格后相邻（距离 1）→ 均进入射程停止；无争格（首步不同格）。
    const events = simulate(input);
    assert.deepEqual(events, [
      started(1, "fixture-f14-bfs-determinism"),
      ta(2, 1, "r1", "u1"),
      ta(3, 1, "u1", "r1"),
      um(4, 5, "r1", { q: 3, r: 2 }, { q: 3, r: 1 }),
      um(5, 5, "u1", { q: 1, r: 1 }, { q: 2, r: 1 }),
      ended(6, 600, "draw", "timeout"),
    ]);
  });

  it("预览 = 实战：实际移动为预览路线前缀", () => {
    const events = simulate(inputFor("f14-bfs-determinism"));
    assertInitialTargetsMatchPreview(events, input);
    assertMovesFollowPreview(events, input, "u1");
    assertMovesFollowPreview(events, input, "r1");
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
