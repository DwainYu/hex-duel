// 目标与路线管线（规格 docs/specs/playable-core.md §目标与路线管线、§路径搜索与位置冲突）。
// 编辑器预览（T4）与战斗引擎（T6）共用的权威实现——"预览 = 实战"由同源保证。
//
// 置信度纪律：rankTargets 的排序规则 = hex 距离 + unitId 平局【APPROXIMATED A1/A2】——
// 真实 TFT 的六级比较序与 targetPriority 留在研究轨道（EXP-001/002/003A/B），不得表述为已验证机制。
//
// 纯函数，无浏览器依赖；不修改传入快照；无隐藏全局状态。
import {
  axialToOffset,
  axialNeighbors,
  hexDistance,
  isOnBoard,
  type AxialCoord,
} from "./coordinates.ts";
import { compareUnitIds, type StateSnapshot, type UnitSnapshot } from "./snapshot.ts";

/** 单一候选目标的路线计算结果（resolveTargetAndRoute 的内层产物）。 */
export interface CandidateRoute {
  /** true = 目标已在射程内（hex 距离 ≤ 本棋子 range），无需移动；此时 hexes 恒为空数组。 */
  inRange: boolean;
  /**
   * 从当前位置到目标射程内合法空格的完整路径（不含当前格，末格 = 终点）。
   * in-range 态为空数组。坐标为引擎 axial (q, r)（T1 裁定：位置字段一律 axial）。
   */
  hexes: AxialCoord[];
}

/** resolveTargetAndRoute 的三态结果：预览四态 RouteResult 的直接来源（见 preview.ts）。 */
export type TargetResolution =
  | { kind: "no-target" }
  | { kind: "unreachable" }
  | { kind: "resolved"; targetId: string; route: CandidateRoute };

/**
 * rankTargets：对全部存活敌方棋子按 hex 距离升序排序，同距按 unitId 稳定排序。
 * 【APPROXIMATED A1/A2】真实 TFT 为六级比较序（移动步数/距离/中心距/targetPriority/…），
 * 本简化仅作确定性近似，由研究轨道回填替换。
 * 纯函数：返回新数组，不修改快照。
 */
export function rankTargets(unit: UnitSnapshot, snapshot: StateSnapshot): UnitSnapshot[] {
  return snapshot.units
    .filter((candidate) => candidate.alive && candidate.side !== unit.side)
    .sort((a, b) => {
      const distanceDelta =
        hexDistance(unit.position, a.position) - hexDistance(unit.position, b.position);
      return distanceDelta !== 0 ? distanceDelta : compareUnitIds(a.unitId, b.unitId);
    });
}

/**
 * computeRoute：单一候选目标的 BFS 寻路（规格 §路径搜索与位置冲突）。
 * - 固定邻居顺序 HEX_NEIGHBOR_DELTAS（确定性）；
 * - 被占格（双方存活棋子）不可通行：既不可为路径中间点，也不可为终点；
 * - 终点 = 距目标 hex 距离 ≤ 本棋子 range 的合法空格（目标所在格被占，天然排除——
 *   "目标所在格本身不算射程内空格"）；
 * - 射程判定使用 hex 距离（射程 1 的近战与目标相邻即达标）；
 * - 无可达终点 → null；目标不存在 / 已死亡 / 为己方 → null（防御性契约）。
 *
 * BFS 无权重，首个被生成的终点即最短路径之一（同层内由队列顺序 + 邻居顺序唯一决定），
 * 回溯父链得到确定路径。纯函数：不修改快照，返回新数组。
 */
export function computeRoute(
  unit: UnitSnapshot,
  snapshot: StateSnapshot,
  targetId: string,
): CandidateRoute | null {
  const target = snapshot.units.find((candidate) => candidate.unitId === targetId);
  if (!target || !target.alive || target.side === unit.side) {
    return null;
  }
  if (hexDistance(unit.position, target.position) <= unit.range) {
    return { inRange: true, hexes: [] };
  }

  const cellKey = (cell: AxialCoord): string => `${cell.q},${cell.r}`;
  const occupiedKeys = new Set(
    snapshot.units.filter((candidate) => candidate.alive).map((c) => cellKey(c.position)),
  );
  const startKey = cellKey(unit.position);
  const isEndpoint = (cell: AxialCoord) => hexDistance(cell, target.position) <= unit.range;

  const visited = new Set<string>([startKey]);
  const parentByKey = new Map<string, string>();
  const queue: AxialCoord[] = [unit.position];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    for (const neighbor of axialNeighbors(current)) {
      const { col, row } = axialToOffset(neighbor.q, neighbor.r);
      if (!isOnBoard(col, row)) {
        continue; // 棋盘外
      }
      const neighborKey = cellKey(neighbor);
      if (occupiedKeys.has(neighborKey) || visited.has(neighborKey)) {
        continue; // 被占格不可通行（不可穿越、不可为终点）；已访问跳过
      }
      parentByKey.set(neighborKey, cellKey(current));
      if (isEndpoint(neighbor)) {
        // 回溯路径（不含起点）
        const hexes: AxialCoord[] = [];
        let cursorKey = neighborKey;
        while (cursorKey !== startKey) {
          const [q, r] = cursorKey.split(",").map(Number) as [number, number];
          hexes.push({ q, r });
          cursorKey = parentByKey.get(cursorKey)!;
        }
        hexes.reverse();
        return { inRange: false, hexes };
      }
      visited.add(neighborKey);
      queue.push(neighbor);
    }
  }
  return null; // 无可达终点
}

/**
 * resolveTargetAndRoute：按 rankTargets 顺序取第一个 computeRoute 有效的候选。
 * - 无任何存活敌方候选 → no-target；
 * - 有候选但全部不可达 → unreachable；
 * - 否则 → resolved（首个路线有效的候选目标 + 其路线）。
 * 纯函数，不修改快照。
 */
export function resolveTargetAndRoute(
  unit: UnitSnapshot,
  snapshot: StateSnapshot,
): TargetResolution {
  const candidates = rankTargets(unit, snapshot);
  if (candidates.length === 0) {
    return { kind: "no-target" };
  }
  for (const candidate of candidates) {
    const route = computeRoute(unit, snapshot, candidate.unitId);
    if (route !== null) {
      return { kind: "resolved", targetId: candidate.unitId, route };
    }
  }
  return { kind: "unreachable" };
}
