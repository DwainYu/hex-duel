// 测试共享助手：path 态路线的结构不变量校验（targeting / preview 测试共用，单一口径）。
// 断言的是"路径合法性"这一结构性质，起点/终点/占格等预期值由各测试用例自行给定；
// hexDistance 复用 src/engine/coordinates.ts（其正确性已由 T1 坐标测试以独立样例表锁定），
// 此处不构成对被测寻路实现的循环依赖（本助手不使用 computeRoute）。
import assert from "node:assert/strict";

import { hexDistance, type AxialCoord } from "../../src/engine/coordinates.ts";

/**
 * 结构不变量：路径非空、不含起点、逐格邻接、不经过被占格、
 * 终点为目标射程内的空格、长度不短于起终点 hex 距离（无权重 BFS 的下界；绕障时可更长）。
 */
export function assertPathWellFormed(
  start: AxialCoord,
  hexes: AxialCoord[],
  target: AxialCoord,
  range: number,
  occupied: AxialCoord[],
): void {
  const occupiedKeys = new Set(occupied.map((c) => `${c.q},${c.r}`));
  const endpoint = hexes[hexes.length - 1];
  assert.ok(hexes.length >= 1 && endpoint, "path 态路径至少含 1 格");
  assert.notDeepEqual(endpoint, start, "路径不得含当前格");
  assert.ok(hexDistance(endpoint, target) <= range, "终点必须在目标射程内");
  assert.ok(
    !occupiedKeys.has(`${endpoint.q},${endpoint.r}`),
    "终点必须是空格（目标所在格不可为终点）",
  );
  let prev = start;
  for (const cell of hexes) {
    assert.equal(
      hexDistance(prev, cell),
      1,
      `路径必须逐格邻接：(${prev.q},${prev.r}) → (${cell.q},${cell.r})`,
    );
    assert.ok(!occupiedKeys.has(`${cell.q},${cell.r}`), `路径不得经过被占格：(${cell.q},${cell.r})`);
    prev = cell;
  }
  assert.ok(
    hexes.length >= hexDistance(start, endpoint),
    "BFS 无权重最短路长度不得短于起终点 hex 距离（绕障时可更长）",
  );
}
