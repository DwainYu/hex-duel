// previewInitial 集成测试（T2 主接缝：SimulationInput 进、PreviewResult 出）。
// 规格依据：docs/specs/playable-core.md §引擎 API、§目标与路线管线；Issue #2 验收标准。
//
// 预期值独立事实来源：规格规则 + 各用例注释内记录的手工 BFS 推演（起点、墙格、
// 终点与逐层生成次序），不依赖被测实现反推；夹具场景 JSON 全部来自
// tests/fixtures/scenarios/ 单一来源体系（T1 奠基，T6 复用同一输入场景），不复制场景数据。
//
// 四态覆盖说明：path（F11 u1/r2、F14 双方）、in-range（墙单位与被贴脸目标）、
// unreachable（t2-unreachable-walled 的 u1）；no-target 在合法 SimulationInput 下不可达
// （校验 E7 保证双方非空、初始全员存活），该态由 targeting.test.ts 在管线层覆盖。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { offsetToAxial, type AxialCoord } from "../src/engine/coordinates.ts";
import { previewInitial, type PreviewResult } from "../src/engine/preview.ts";
import { SimulationInputError } from "../src/engine/validate.ts";
import type { SimulationInput } from "../src/engine/types.ts";
import { defaultCatalog, defaultRules, loadScenarioFixture } from "./fixtures/loaders.ts";
import { assertPathWellFormed } from "./helpers/path-checks.ts";

function inputFor(scenarioName: string): SimulationInput {
  return {
    scenario: loadScenarioFixture(scenarioName) as SimulationInput["scenario"],
    catalog: defaultCatalog(),
    rules: defaultRules(),
  };
}

/** 场景单位的引擎 axial 坐标（offsetToAxial 已经 T1 坐标测试锁定，此处仅作占格集合构造）。 */
function axialOf(input: SimulationInput, unitId: string): AxialCoord {
  const found = input.scenario.units.find((u) => u.unitId === unitId)!;
  return offsetToAxial(found.position.col, found.position.row);
}

describe("previewInitial：F11 不可达换下一候选（主接缝集成）", () => {
  const input = inputFor("f11-unreachable-next-candidate");
  const result = previewInitial(input);

  it("targets：u1 跳过被围死的 r1，锁定下一候选 r2；其余按最近目标分配", () => {
    assert.deepEqual(result.targets, [
      { unitId: "r1", targetId: "w1" },
      { unitId: "r2", targetId: "w1" },
      { unitId: "u1", targetId: "r2" },
      { unitId: "w1", targetId: "r1" },
      { unitId: "w2", targetId: "r1" },
      { unitId: "w3", targetId: "r1" },
      { unitId: "w4", targetId: "r1" },
      { unitId: "w5", targetId: "r1" },
      { unitId: "w6", targetId: "r1" },
    ]);
  });

  it("routes：四态中的 path / in-range 均出现，路径与参照推演逐格一致", () => {
    // 参照推演：u1(axial(0,3)) → r2 路径绕开蓝方墙 [(1,2),(2,1),(3,1),(4,1),(5,1)]；
    // r2(axial(6,0)) → w1 路径 [(5,1),(4,2)]；墙单位与 r1 贴脸 in-range。
    assert.deepEqual(result.routes, [
      { unitId: "r1", targetId: "w1", route: { kind: "in-range" } },
      { unitId: "r2", targetId: "w1", route: { kind: "path", hexes: [{ q: 5, r: 1 }, { q: 4, r: 2 }] } },
      {
        unitId: "u1",
        targetId: "r2",
        route: {
          kind: "path",
          hexes: [{ q: 1, r: 2 }, { q: 2, r: 1 }, { q: 3, r: 1 }, { q: 4, r: 1 }, { q: 5, r: 1 }],
        },
      },
      { unitId: "w1", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w2", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w3", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w4", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w5", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w6", targetId: "r1", route: { kind: "in-range" } },
    ]);
    for (const entry of result.routes) {
      if (entry.route.kind !== "path") continue;
      const targetId = entry.targetId;
      assert.ok(targetId);
      assertPathWellFormed(
        axialOf(input, entry.unitId),
        entry.route.hexes,
        axialOf(input, targetId),
        1,
        input.scenario.units.map((u) => axialOf(input, u.unitId)),
      );
    }
  });

  it("focusCounts：r1 被 6 枚墙单位集火，w1 被 r1/r2 集火，r2 被 u1 集火", () => {
    assert.deepEqual(result.focusCounts, { r1: 6, r2: 1, w1: 2 });
  });

  it("actionOrder：全部 unitId 升序（模拟器结算顺序【APPROXIMATED A9】，非真实行动优先级）", () => {
    assert.deepEqual(result.actionOrder, ["r1", "r2", "u1", "w1", "w2", "w3", "w4", "w5", "w6"]);
  });
});

describe("previewInitial：F14 BFS 确定性（主接缝集成）", () => {
  const input = inputFor("f14-bfs-determinism");

  it("开阔场多等长路径下，双方路径由固定邻居顺序唯一决定（参照推演逐格一致）", () => {
    const result = previewInitial(input);
    // u1(axial(1,1)) → r1(axial(3,2))：首层 (+1,0)→(2,1) 最先入队，其次从 (2,1) 生成终点 (3,1)。
    // r1(axial(3,2)) → u1(axial(1,1))：首层 (+1,0)→(4,2)、(+1,-1)→(4,1)、(0,-1)→(3,1) 依次探索，
    // 终点 (2,1) 自 (3,1) 的 (-1,0) 方向生成。
    assert.deepEqual(result.routes, [
      { unitId: "r1", targetId: "u1", route: { kind: "path", hexes: [{ q: 3, r: 1 }, { q: 2, r: 1 }] } },
      { unitId: "u1", targetId: "r1", route: { kind: "path", hexes: [{ q: 2, r: 1 }, { q: 3, r: 1 }] } },
    ]);
    assert.deepEqual(result.targets, [
      { unitId: "r1", targetId: "u1" },
      { unitId: "u1", targetId: "r1" },
    ]);
    assert.deepEqual(result.focusCounts, { r1: 1, u1: 1 });
    assert.deepEqual(result.actionOrder, ["r1", "u1"]);
  });

  it("同输入两次调用输出完全一致（纯函数 / I5 预览侧）", () => {
    const a = previewInitial(input);
    const b = previewInitial(input);
    assert.deepEqual(a, b);
  });

  it("不修改输入（纯函数：调用前后输入深相等）", () => {
    const before = JSON.stringify(input);
    previewInitial(input);
    assert.equal(JSON.stringify(input), before);
  });
});

describe("previewInitial：t2-unreachable-walled 唯一候选不可达", () => {
  const input = inputFor("t2-unreachable-walled");
  const result = previewInitial(input);

  it("u1 的唯一候选 r1 被己方墙围死 → targetId null + unreachable 态", () => {
    assert.deepEqual(result.targets, [
      { unitId: "r1", targetId: "w1" },
      { unitId: "u1", targetId: null },
      { unitId: "w1", targetId: "r1" },
      { unitId: "w2", targetId: "r1" },
      { unitId: "w3", targetId: "r1" },
      { unitId: "w4", targetId: "r1" },
      { unitId: "w5", targetId: "r1" },
      { unitId: "w6", targetId: "r1" },
    ]);
    assert.deepEqual(result.routes, [
      { unitId: "r1", targetId: "w1", route: { kind: "in-range" } },
      { unitId: "u1", targetId: null, route: { kind: "unreachable" } },
      { unitId: "w1", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w2", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w3", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w4", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w5", targetId: "r1", route: { kind: "in-range" } },
      { unitId: "w6", targetId: "r1", route: { kind: "in-range" } },
    ]);
  });

  it("focusCounts：r1 被 6 枚墙单位集火，w1 被 r1 集火；u1 无目标不进集火统计", () => {
    assert.deepEqual(result.focusCounts, { r1: 6, w1: 1 });
  });

  it("actionOrder：全部 unitId 升序", () => {
    assert.deepEqual(result.actionOrder, ["r1", "u1", "w1", "w2", "w3", "w4", "w5", "w6"]);
  });
});

describe("previewInitial：强制校验门与确定性", () => {
  it("非法输入抛 SimulationInputError，携带结构化 ValidationError[]（复用 T1 的 F16 夹具）", () => {
    const input = inputFor("f16-e7-empty-side");
    assert.throws(
      () => previewInitial(input),
      (error: unknown) =>
        error instanceof SimulationInputError &&
        error.errors.length === 1 &&
        error.errors[0]?.code === "EMPTY_SIDE" &&
        error.errors[0]?.path === "scenario.units",
    );
  });

  it("三个夹具各自同输入两次调用输出完全一致（确定性）", () => {
    for (const fixture of [
      "f11-unreachable-next-candidate",
      "f14-bfs-determinism",
      "t2-unreachable-walled",
    ]) {
      const input = inputFor(fixture);
      const a: PreviewResult = previewInitial(input);
      const b: PreviewResult = previewInitial(input);
      assert.deepEqual(a, b, `夹具 ${fixture} 两次调用必须一致`);
    }
  });
});
