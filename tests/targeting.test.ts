// 目标与路线管线测试（T2，规格 docs/specs/playable-core.md §目标与路线管线、§路径搜索与位置冲突）。
// 辅接缝：rankTargets / computeRoute / resolveTargetAndRoute 纯函数（规格 §Testing Decisions
// 模块与夹具明确列出"目标管线：排序与平局、绕障 BFS、敌方格不可终点、四态 RouteResult"）。
//
// 预期值的独立事实来源：规格坐标/距离公式 + 各用例注释内记录的手工 BFS 推演
//（起点、墙格、终点与逐层生成次序），不依赖被测实现反推；
// 路径断言另用 tests/helpers/path-checks.ts 的结构不变量校验兜底。
//
// 注意：合成快照的 axial 位置必须能映射到棋盘内 offset 格（computeRoute 按 56 格棋盘做
// 越界过滤），本文件所有坐标均已按 offsetToAxial 公式核对。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HEX_NEIGHBOR_DELTAS } from "../src/engine/coordinates.ts";
import {
  computeRoute,
  rankTargets,
  resolveTargetAndRoute,
  type CandidateRoute,
} from "../src/engine/targeting.ts";
import type { StateSnapshot, UnitSnapshot } from "../src/engine/snapshot.ts";
import type { Side } from "../src/engine/types.ts";
import { assertPathWellFormed } from "./helpers/path-checks.ts";

/** 构造合成单位快照（unitDefId 仅作占位标识，管线逻辑不消费）。 */
function unit(
  unitId: string,
  side: Side,
  q: number,
  r: number,
  range = 1,
  alive = true,
): UnitSnapshot {
  return { unitId, unitDefId: `def-${unitId}`, side, position: { q, r }, range, alive };
}

/** 构造状态快照（units 按 unitId 升序存放，与 buildInitialSnapshot 的约定一致）。 */
function snapshot(...units: UnitSnapshot[]): StateSnapshot {
  return {
    units: [...units].sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)),
  };
}

describe("rankTargets：排序与平局【APPROXIMATED A1/A2】", () => {
  it("按 hex 距离升序排列全部存活敌方棋子", () => {
    const self = unit("u1", "blue", 0, 3);
    const snap = snapshot(
      self,
      unit("r1", "red", 3, 3), // d3
      unit("r2", "red", 1, 3), // d1
      unit("r3", "red", 2, 2), // d2
    );
    const ranked = rankTargets(self, snap);
    assert.deepEqual(
      ranked.map((u) => u.unitId),
      ["r2", "r3", "r1"],
    );
  });

  it("同距按 unitId 排序（字符串逐码元比较：r10 < r2）", () => {
    const self = unit("u1", "blue", 0, 0);
    const snap = snapshot(
      self,
      unit("r2", "red", 0, 1), // d1
      unit("r10", "red", 1, 0), // d1
    );
    const ranked = rankTargets(self, snap);
    assert.deepEqual(
      ranked.map((u) => u.unitId),
      ["r10", "r2"],
      "同距平局必须按 unitId 稳定排序；unitId 为字符串，按码元序比较",
    );
  });

  it("过滤己方棋子与已死亡棋子", () => {
    const self = unit("u1", "blue", 0, 0);
    const snap = snapshot(
      self,
      unit("u2", "blue", 1, 0), // 己方，排除
      unit("r1", "red", 2, 0),
      unit("r2", "red", 1, 0, 1, false), // 已死亡，排除
    );
    const ranked = rankTargets(self, snap);
    assert.deepEqual(
      ranked.map((u) => u.unitId),
      ["r1"],
    );
  });

  it("无存活敌方棋子 → 空数组（no-target 的来源）", () => {
    const self = unit("u1", "blue", 0, 0);
    const snap = snapshot(self, unit("u2", "blue", 1, 0), unit("r1", "red", 1, 0, 1, false));
    assert.deepEqual(rankTargets(self, snap), []);
  });

  it("不修改传入快照（纯函数）", () => {
    const self = unit("u1", "blue", 0, 3);
    const snap = snapshot(
      self,
      unit("r1", "red", 3, 3),
      unit("r2", "red", 1, 3),
    );
    const before = JSON.stringify(snap.units.map((u) => u.unitId));
    rankTargets(self, snap);
    assert.equal(JSON.stringify(snap.units.map((u) => u.unitId)), before);
  });
});

describe("computeRoute：BFS 寻路", () => {
  it("已在射程内 → in-range（hexes 为空，不进入 BFS）", () => {
    const self = unit("u1", "blue", 1, 1);
    const snap = snapshot(self, unit("r1", "red", 2, 1)); // 相邻，射程 1
    assert.deepEqual(computeRoute(self, snap, "r1"), { inRange: true, hexes: [] });
  });

  it("远程棋子在射程内同样直接 in-range", () => {
    const self = unit("u1", "blue", 1, 1, 3);
    const snap = snapshot(self, unit("r1", "red", 2, 2)); // hex 距离 2 ≤ 3
    assert.deepEqual(computeRoute(self, snap, "r1"), { inRange: true, hexes: [] });
  });

  it("开阔场最短路：固定邻居顺序锁定唯一路径（F14 同款几何，手工推演值）", () => {
    // 起点 (1,1)=off(2,2)，目标 (3,2)=off(5,3)，距离 3，终点取距目标 1 格的空格。
    // 参照推演：首层邻居 (+1,0)→(2,1) 最先入队，其次从 (2,1) 生成 (3,1) 命中终点。
    const self = unit("u1", "blue", 1, 1);
    const snap = snapshot(self, unit("r1", "red", 3, 2));
    const route: CandidateRoute | null = computeRoute(self, snap, "r1");
    assert.deepEqual(route, {
      inRange: false,
      hexes: [
        { q: 2, r: 1 },
        { q: 3, r: 1 },
      ],
    });
    assertPathWellFormed(
      self.position,
      route?.hexes ?? [],
      { q: 3, r: 2 },
      1,
      [self.position, { q: 3, r: 2 }],
    );
  });

  it("被占格不可通行（不可穿越、不可为中间点）：绕障路径逐格避开墙", () => {
    // 起点 (0,3)=off(1,4)，目标 (3,3)=off(5,4)，墙 = (1,3)、(2,2)、(2,3)。
    // 参照推演：绕南侧空档，路径 = [(0,4), (1,4), (2,4)]，
    // 终点 (2,4)=off(5,5) 与目标相邻；墙格与目标格全程未进入。
    const blocker1 = unit("u9", "blue", 1, 3);
    const blocker2 = unit("u8", "blue", 2, 2);
    const self = unit("u1", "blue", 0, 3);
    const target = unit("r1", "red", 3, 3);
    const snap = snapshot(self, blocker1, blocker2, target);
    const route = computeRoute(self, snap, "r1");
    assert.deepEqual(route, {
      inRange: false,
      hexes: [
        { q: 0, r: 4 },
        { q: 1, r: 4 },
        { q: 2, r: 4 },
      ],
    });
    assertPathWellFormed(self.position, route?.hexes ?? [], target.position, 1, [
      self.position,
      blocker1.position,
      blocker2.position,
      target.position,
    ]);
  });

  it("敌方棋子所在格不可为终点：唯一缺口在后方时绕行至空格", () => {
    // 目标 (3,3)=off(5,4) 的 6 邻居中 5 格被占，唯一合法终点 (2,3)=off(4,4)。
    // 起点 (3,5)=off(5,6) 距目标 2、距缺口 3，但通往目标的近路全被环封死，
    // 参照推演路径 = [(2,5), (1,5), (1,4), (2,3)]，终点是空格而非目标所在格。
    const self = unit("u1", "blue", 3, 5);
    const target = unit("r1", "red", 3, 3);
    const snap = snapshot(
      self,
      target,
      unit("r2", "red", 4, 3),
      unit("r3", "red", 4, 2),
      unit("r4", "red", 3, 2),
      unit("r5", "red", 2, 4),
      unit("r6", "red", 3, 4),
    );
    const route = computeRoute(self, snap, "r1");
    assert.deepEqual(route, {
      inRange: false,
      hexes: [
        { q: 2, r: 5 },
        { q: 1, r: 5 },
        { q: 1, r: 4 },
        { q: 2, r: 3 },
      ],
    });
    assertPathWellFormed(
      self.position,
      route?.hexes ?? [],
      target.position,
      1,
      snap.units.map((u) => u.position),
    );
  });

  it("目标被完全围死（全部射程内空格被占）→ null", () => {
    // 目标 (3,3) 的 6 邻居全部被占：目标所在格虽"距离 0"也不算射程内空格。
    const self = unit("u1", "blue", 0, 3);
    const target = unit("r1", "red", 3, 3);
    const snap = snapshot(
      self,
      target,
      unit("r2", "red", 4, 3),
      unit("r3", "red", 4, 2),
      unit("r4", "red", 3, 2),
      unit("r5", "red", 2, 3),
      unit("r6", "red", 2, 4),
      unit("r7", "red", 3, 4),
    );
    assert.equal(computeRoute(self, snap, "r1"), null);
  });

  it("目标不存在或已死亡 → null（防御性契约）", () => {
    const self = unit("u1", "blue", 0, 0);
    const snap = snapshot(self, unit("r1", "red", 2, 0, 1, false), unit("u2", "blue", 1, 0));
    assert.equal(computeRoute(self, snap, "r1"), null, "死亡目标");
    assert.equal(computeRoute(self, snap, "rX"), null, "不存在的目标");
    assert.equal(computeRoute(self, snap, "u2"), null, "己方棋子不是合法目标");
  });

  it("BFS 首步遵循固定邻居顺序：首选方向被占时顺延到下一可用方向", () => {
    // 起点 (0,2)=off(1,3)，(+1,0) 方向的 (1,2) 被占 → 首步顺延到 (+1,-1)→(1,1)。
    // 参照推演：路径 = [(1,1), (2,1), (3,1)]，终点 (3,1)=off(5,2) 与目标 (3,2) 相邻。
    const self = unit("u1", "blue", 0, 2);
    const target = unit("r1", "red", 3, 2);
    const snap = snapshot(self, unit("u2", "blue", 1, 2), target);
    const route = computeRoute(self, snap, "r1");
    assert.deepEqual(route, {
      inRange: false,
      hexes: [
        { q: 1, r: 1 },
        { q: 2, r: 1 },
        { q: 3, r: 1 },
      ],
    });
    assertPathWellFormed(self.position, route?.hexes ?? [], target.position, 1, [
      self.position,
      { q: 1, r: 2 },
      target.position,
    ]);
  });

  it("同参两次调用结果完全一致（BFS 确定性）", () => {
    const self = unit("u1", "blue", 1, 1);
    const snap = snapshot(self, unit("r1", "red", 3, 2));
    const a = computeRoute(self, snap, "r1");
    const b = computeRoute(self, snap, "r1");
    assert.deepEqual(a, b);
  });

  it("邻居顺序常量与规格一致（独立事实来源）", () => {
    assert.deepEqual(HEX_NEIGHBOR_DELTAS.map((d) => [d.q, d.r]), [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ]);
  });
});

describe("resolveTargetAndRoute：按排序取第一个路线有效候选", () => {
  it("无任何存活敌方候选 → no-target", () => {
    const self = unit("u1", "blue", 0, 0);
    const snap = snapshot(self, unit("u2", "blue", 1, 0), unit("r1", "red", 1, 0, 1, false));
    assert.deepEqual(resolveTargetAndRoute(self, snap), { kind: "no-target" });
  });

  it("首候选不可达 → 换下一候选（F11 微缩；墙用己方单位，红方候选仅两个）", () => {
    const self = unit("u1", "blue", 0, 3);
    const target = unit("r1", "red", 3, 3);
    const snap = snapshot(
      self,
      target,
      unit("r8", "red", 5, 1), // 开阔远端候选
      // 己方墙：把 r1 的 6 邻居全部占住（己方单位不是 u1 的候选）
      unit("u2", "blue", 4, 3),
      unit("u3", "blue", 4, 2),
      unit("u4", "blue", 3, 2),
      unit("u5", "blue", 2, 3),
      unit("u6", "blue", 2, 4),
      unit("u7", "blue", 3, 4),
    );
    const resolution = resolveTargetAndRoute(self, snap);
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind === "resolved") {
      assert.equal(resolution.targetId, "r8", "必须跳过不可达的 r1，落到下一可达候选");
      assert.equal(resolution.route.inRange, false);
      assert.ok(resolution.route.hexes.length >= 1);
    }
  });

  it("全部候选不可达 → unreachable", () => {
    const self = unit("u1", "blue", 0, 3);
    const snap = snapshot(
      self,
      unit("r1", "red", 3, 3),
      // 己方墙：红方唯一候选 r1 被完全围死
      unit("u2", "blue", 4, 3),
      unit("u3", "blue", 4, 2),
      unit("u4", "blue", 3, 2),
      unit("u5", "blue", 2, 3),
      unit("u6", "blue", 2, 4),
      unit("u7", "blue", 3, 4),
    );
    assert.deepEqual(resolveTargetAndRoute(self, snap), { kind: "unreachable" });
  });

  it("首候选在射程内 → 直接命中，不再考察后续候选", () => {
    const self = unit("u1", "blue", 1, 1);
    const snap = snapshot(self, unit("r1", "red", 2, 1), unit("r2", "red", 5, 5));
    const resolution = resolveTargetAndRoute(self, snap);
    assert.deepEqual(resolution, {
      kind: "resolved",
      targetId: "r1",
      route: { inRange: true, hexes: [] },
    });
  });
});
