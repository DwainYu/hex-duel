// simulate 集成测试（T6 主接缝：SimulationInput 进、BattleEvent[] 出）。
// 规格依据：docs/specs/playable-core.md §引擎 API、§Tick 决策与结算顺序、§事件 schema；
// Issue #6 五阶段检查点随 describe 分组推进。
//
// 预期值的独立事实来源：规格规则 + 各用例注释内记录的手工推演（目录数值、冷却换算），
// 不依赖被测实现反推；夹具场景 JSON 全部来自 tests/fixtures/scenarios/ 单一来源体系。
//
// 阶段 1（Simulation State、tick 快照、行动顺序 → 状态推进确定性）：
// 无决策事件，事件流 = BattleStarted(tick 0) + BattleEnded(timeout)。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { simulate } from "../src/engine/simulate.ts";
import { SimulationInputError } from "../src/engine/validate.ts";
import type {
  BattleEndedEvent,
  BattleEvent,
  BattleStartedEvent,
} from "../src/engine/events.ts";
import type { SimulationInput } from "../src/engine/types.ts";
import { defaultCatalog, defaultRules, loadScenarioFixture, rulesWith } from "./fixtures/loaders.ts";

function inputFor(scenarioName: string): SimulationInput {
  return {
    scenario: loadScenarioFixture(scenarioName) as SimulationInput["scenario"],
    catalog: defaultCatalog(),
    rules: defaultRules(),
  };
}

describe("simulate：阶段 1 —— 状态推进确定性", () => {
  it("valid-minimal：BattleStarted(tick 0) + BattleEnded(timeout, draw, tick 600)，中间零决策事件", () => {
    // 阶段 1 无决策与结算：双方满血存活到 timeoutTicks；
    // 比例判定 remB×initR = initB×initR = remR×initB → 相等 → draw(timeout)。
    const events = simulate(inputFor("valid-minimal"));
    assert.deepEqual(events, [
      {
        type: "BattleStarted",
        sequence: 1,
        tick: 0,
        scenarioId: "fixture-valid-minimal",
        rulesSnapshot: { ticksPerSecond: 10, moveIntervalTicks: 5, timeoutTicks: 600 },
      },
      {
        type: "BattleEnded",
        sequence: 2,
        tick: 600,
        result: "draw",
        reason: "timeout",
      },
    ]);
  });

  it("I5 确定性：同输入两次运行事件流完全一致", () => {
    const input = inputFor("valid-minimal");
    assert.deepEqual(simulate(input), simulate(input));
  });

  it("rulesSnapshot 为输入 rules 的拷贝：运行后改动输入 rules 不影响已产出事件（纯函数纪律）", () => {
    const input = inputFor("valid-minimal");
    const events = simulate(input);
    const started = events[0] as BattleStartedEvent;
    input.rules.ticksPerSecond = 999;
    assert.equal(started.rulesSnapshot.ticksPerSecond, 10);
  });

  it("tick 上界由 rules.timeoutTicks 驱动：timeoutTicks=7 → BattleEnded.tick = 7", () => {
    const input = inputFor("valid-minimal");
    input.rules = rulesWith({ timeoutTicks: 7 });
    const events = simulate(input);
    assert.equal(events.length, 2);
    const ended = events[1] as BattleEndedEvent;
    assert.equal(ended.tick, 7);
    assert.equal(ended.reason, "timeout");
    assert.equal(ended.result, "draw");
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
