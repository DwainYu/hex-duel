// 坐标几何：规格 docs/specs/playable-core.md §坐标体系（v1.0.2）
// 逻辑坐标：offset { col, row }，1 基，col ∈ 1–7，row ∈ 1–8，pointy-top，odd-r 奇数行右移。
// 引擎内部：axial (q, r)；hex 距离 = max(|dq|, |dr|, |dq+dr|)；邻接 = 距离 1。
// 本模块为纯函数，无浏览器依赖。

export interface OffsetCoord {
  col: number;
  row: number;
}

export interface AxialCoord {
  q: number;
  r: number;
}

/** 棋盘列数（offset 1 基 col ∈ 1–7）。 */
export const BOARD_COLS = 7;
/** 棋盘行数（offset 1 基 row ∈ 1–8）。 */
export const BOARD_ROWS = 8;

/** BFS 固定邻居顺序（规格 §路径搜索与位置冲突，确定性要求）。 */
export const HEX_NEIGHBOR_DELTAS: readonly AxialCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

/** offset 坐标是否为棋盘内合法整格（col 1–7、row 1–8，整数）。 */
export function isOnBoard(col: number, row: number): boolean {
  return (
    Number.isInteger(col) &&
    Number.isInteger(row) &&
    col >= 1 &&
    col <= BOARD_COLS &&
    row >= 1 &&
    row <= BOARD_ROWS
  );
}

/**
 * offset（1 基）→ axial。先转 0 基 c0 = col−1、r0 = row−1，
 * 再按 odd-r：q = c0 − (r0 − (r0 & 1)) / 2；r = r0。
 * 棋盘外或非整数坐标属于编程错误，直接拒绝（RangeError）；
 * 输入合法性判断使用 isOnBoard。
 */
export function offsetToAxial(col: number, row: number): AxialCoord {
  if (!isOnBoard(col, row)) {
    throw new RangeError(
      `offset 坐标越界：col=${col}, row=${row}（合法范围 col 1–${BOARD_COLS}, row 1–${BOARD_ROWS}，且必须为整数）`,
    );
  }
  const c0 = col - 1;
  const r0 = row - 1;
  return { q: c0 - (r0 - (r0 & 1)) / 2, r: r0 };
}

/**
 * axial → offset（1 基）。odd-r 逆变换：c0 = q + (r − (r & 1)) / 2；r0 = r。
 * 纯公式（全平面双射，不做棋盘边界判断）；是否在棋盘内用
 * isOnBoard(axialToOffset(q, r)) 判断，便于邻居越界检查统一走“转换后过滤”。
 */
export function axialToOffset(q: number, r: number): OffsetCoord {
  const c0 = q + (r - (r & 1)) / 2;
  return { col: c0 + 1, row: r + 1 };
}

/** hex 距离（axial 立方坐标公式）。 */
export function hexDistance(a: AxialCoord, b: AxialCoord): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}

/** 6 个 axial 邻居（无界，不限棋盘；顺序 = HEX_NEIGHBOR_DELTAS，确定性）。 */
export function axialNeighbors(a: AxialCoord): AxialCoord[] {
  return HEX_NEIGHBOR_DELTAS.map((d) => ({ q: a.q + d.q, r: a.r + d.r }));
}
