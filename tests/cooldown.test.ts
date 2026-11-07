// 冷却换算测试（T6 辅接缝，规格 docs/specs/playable-core.md §Tick 决策与结算顺序）：
// attackCooldownTicks = max(1, round(ticksPerSecond / attackSpeed))【APPROXIMATED A4】。
// 预期值的独立事实来源：规格文字（"常规四舍五入（0.5 向上，正值域）"+ 示例表），
// 不依赖被测实现反推。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attackCooldownTicks } from "../src/engine/cooldown.ts";
import { defaultRules, rulesWith } from "./fixtures/loaders.ts";

describe("attackCooldownTicks：冷却整数换算【APPROXIMATED A4】", () => {
  const rules = defaultRules(); // ticksPerSecond = 10

  it("规格示例表四组值（tps=10）：0.7→14、0.5→20、1.1→9、10→1", () => {
    assert.equal(attackCooldownTicks(rules, 0.7), 14);
    assert.equal(attackCooldownTicks(rules, 0.5), 20);
    assert.equal(attackCooldownTicks(rules, 1.1), 9);
    assert.equal(attackCooldownTicks(rules, 10), 1);
  });

  it("0.5 向上取整：10 / 0.8 = 12.5 → 13", () => {
    assert.equal(attackCooldownTicks(rules, 0.8), 13);
  });

  it("攻速高于 ticksPerSecond 时钳制为 1 tick：10 / 30 ≈ 0.33 → round 0 → max(1, 0) = 1", () => {
    assert.equal(attackCooldownTicks(rules, 30), 1);
  });

  it("随 ticksPerSecond 线性缩放：tps=20、as=0.5 → 40", () => {
    assert.equal(attackCooldownTicks(rulesWith({ ticksPerSecond: 20 }), 0.5), 40);
  });
});
