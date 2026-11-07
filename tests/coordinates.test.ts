// 坐标几何测试：规格 docs/specs/playable-core.md §坐标体系（v1.0.2）要求的四类测试
//（56 格双射完整性、邻接一致性、越界拒绝、全格往返恒等，参数化覆盖全部 56 格）
// + hex 距离与邻接的少量单测。
// 测试接缝：offsetToAxial / axialToOffset / hexDistance / isOnBoard 纯函数（规格辅接缝）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOARD_COLS,
  BOARD_ROWS,
  axialNeighbors,
  axialToOffset,
  hexDistance,
  isOnBoard,
  offsetToAxial,
  type AxialCoord,
} from "../src/engine/coordinates.ts";

/** 全部 56 格（col 1–7, row 1–8，1 基）。 */
function allBoardCells(): { col: number; row: number }[] {
  const cells: { col: number; row: number }[] = [];
  for (let row = 1; row <= BOARD_ROWS; row++) {
    for (let col = 1; col <= BOARD_COLS; col++) {
      cells.push({ col, row });
    }
  }
  return cells;
}

// 独立事实来源：odd-r（奇数行右移）offset 邻居增量表（0 基 dcol/drow）。
// 取自六边形网格标准奇偶错位邻居表，不依赖被测实现推导，用于交叉验证转换正确性。
const ODD_R_NEIGHBOR_DELTAS: Record<number, [number, number][]> = {
  0: [
    [+1, 0],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, +1],
    [0, +1],
  ], // 0 基偶数行
  1: [
    [+1, 0],
    [+1, -1],
    [0, -1],
    [-1, 0],
    [0, +1],
    [+1, +1],
  ], // 0 基奇数行
};

describe("棋盘定义", () => {
  it("棋盘为 7 列 × 8 行共 56 格", () => {
    assert.equal(BOARD_COLS, 7);
    assert.equal(BOARD_ROWS, 8);
    assert.equal(allBoardCells().length, 56);
  });
});

describe("offset↔axial 转换四类测试", () => {
  it("双射完整性：56 格映射到 56 个互不相同的 axial 坐标", () => {
    const axialKeys = new Set<string>();
    for (const { col, row } of allBoardCells()) {
      const { q, r } = offsetToAxial(col, row);
      axialKeys.add(`${q},${r}`);
    }
    assert.equal(axialKeys.size, 56);
  });

  it("邻接一致性：offset 邻居（独立邻居表）↔ axial 邻居（参数化 56 格）", () => {
    for (const { col, row } of allBoardCells()) {
      const parity = (row - 1) & 1;
      const deltas = ODD_R_NEIGHBOR_DELTAS[parity] ?? [];
      const offsetNeighborKeys = new Set(
        deltas
          .map(([dc, dr]) => ({ col: col + dc, row: row + dr }))
          .filter((c) => isOnBoard(c.col, c.row))
          .map((c) => `${c.col},${c.row}`),
      );
      const axial = offsetToAxial(col, row);
      const axialNeighborsAsOffsetKeys = axialNeighbors(axial)
        .map((n) => axialToOffset(n.q, n.r))
        .filter((c) => isOnBoard(c.col, c.row))
        .map((c) => `${c.col},${c.row}`);

      assert.equal(
        axialNeighborsAsOffsetKeys.length,
        offsetNeighborKeys.size,
        `格 (col=${col}, row=${row}) 邻居数量不一致`,
      );
      for (const key of axialNeighborsAsOffsetKeys) {
        assert.ok(
          offsetNeighborKeys.has(key),
          `格 (col=${col}, row=${row})：axial 邻居 ${key} 不在独立 odd-r 邻居表中`,
        );
      }
    }
  });

  it("越界拒绝：offsetToAxial 对棋盘外或非整数坐标抛出异常（参数化）", () => {
    const invalidCells: { col: number; row: number }[] = [
      { col: 0, row: 1 },
      { col: 8, row: 1 },
      { col: -1, row: 4 },
      { col: 1, row: 0 },
      { col: 1, row: 9 },
      { col: 4, row: -2 },
      { col: 1.5, row: 1 },
      { col: 1, row: 2.5 },
      { col: Number.NaN, row: 1 },
    ];
    for (const { col, row } of invalidCells) {
      assert.throws(
        () => offsetToAxial(col, row),
        `offsetToAxial(col=${col}, row=${row}) 应拒绝棋盘外/非法坐标`,
      );
    }
  });

  it("isOnBoard：全部 56 格为 true，越界与非整数为 false（参数化）", () => {
    for (const { col, row } of allBoardCells()) {
      assert.ok(isOnBoard(col, row), `isOnBoard(${col}, ${row}) 应为 true`);
    }
    const invalidCells: { col: number; row: number }[] = [
      { col: 0, row: 1 },
      { col: 8, row: 1 },
      { col: 1, row: 0 },
      { col: 1, row: 9 },
      { col: 1.5, row: 1 },
      { col: Number.NaN, row: 1 },
    ];
    for (const { col, row } of invalidCells) {
      assert.ok(!isOnBoard(col, row), `isOnBoard(${col}, ${row}) 应为 false`);
    }
  });

  it("全格往返恒等：axialToOffset(offsetToAxial(col, row)) 还原原格（参数化 56 格）", () => {
    for (const { col, row } of allBoardCells()) {
      const axial = offsetToAxial(col, row);
      assert.deepEqual(
        axialToOffset(axial.q, axial.r),
        { col, row },
        `格 (col=${col}, row=${row}) 往返转换不恒等`,
      );
    }
  });
});

describe("hex 距离与邻接", () => {
  const origin: AxialCoord = { q: 0, r: 0 };
  // 独立事实来源：手工推得的立方坐标距离工作样例（max(|dq|, |dr|, |dq+dr|)）。
  const distanceCases: [AxialCoord, AxialCoord, number][] = [
    [origin, origin, 0],
    [origin, { q: 1, r: 0 }, 1],
    [origin, { q: 0, r: -1 }, 1],
    [origin, { q: 2, r: -1 }, 2],
    [origin, { q: -2, r: 2 }, 2],
    [origin, { q: 1, r: 1 }, 2],
    [{ q: 2, r: -1 }, { q: -1, r: 1 }, 3],
    [{ q: -3, r: 1 }, { q: 2, r: -2 }, 5],
  ];

  it("hex 距离符合立方坐标公式（已知样例）", () => {
    for (const [a, b, expected] of distanceCases) {
      assert.equal(hexDistance(a, b), expected, `distance(${a.q},${a.r} → ${b.q},${b.r})`);
    }
  });

  it("hex 距离对称", () => {
    for (const [a, b] of distanceCases) {
      assert.equal(hexDistance(a, b), hexDistance(b, a));
    }
  });

  it("邻接等价于距离 1（六个轴向邻居抽样 + 非邻接反例）", () => {
    for (const [dq, dr] of [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ] as const) {
      assert.equal(hexDistance(origin, { q: dq, r: dr }), 1, `delta(${dq},${dr}) 应邻接`);
    }
    assert.notEqual(hexDistance(origin, { q: 1, r: 1 }), 1);
  });

  it("每个 axial 格恰有 6 个无界邻居且互不重复", () => {
    const neighbors = axialNeighbors(origin);
    assert.equal(neighbors.length, 6);
    assert.equal(new Set(neighbors.map((n) => `${n.q},${n.r}`)).size, 6);
  });

  it("棋盘内邻居数量在 2–6 之间（参数化 56 格）", () => {
    for (const { col, row } of allBoardCells()) {
      const boardNeighborCount = axialNeighbors(offsetToAxial(col, row))
        .map((n) => axialToOffset(n.q, n.r))
        .filter((c) => isOnBoard(c.col, c.row)).length;
      assert.ok(
        boardNeighborCount >= 2 && boardNeighborCount <= 6,
        `格 (col=${col}, row=${row}) 棋盘内邻居数为 ${boardNeighborCount}`,
      );
    }
  });
});
