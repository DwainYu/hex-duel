// previewInitial：推演预览公开 API（规格 docs/specs/playable-core.md §引擎 API）。
// "推演预览"与 T6 战斗引擎共用的权威数据源——目标选择与路线均复用 targeting.ts 管线
// （预览 = 实战，同源由代码结构保证）；路线争抢提示不在此处产出（不新增 PreviewResult
// 字段，由 T4 在 UI 层从 routes 派生：多枚棋子 path 态首步指向同一格）。
//
// 纯函数：无浏览器依赖、无全局状态、不修改输入；同输入两次调用输出完全一致。
// 坐标约定：route.hexes 为引擎 axial (q, r)（T1 裁定）；场景 JSON 与编辑器展示用的
// offset 坐标由 UI 层自行转换。
import type { AxialCoord } from "./coordinates.ts";
import { buildInitialSnapshot } from "./snapshot.ts";
import { resolveTargetAndRoute } from "./targeting.ts";
import type { SimulationInput } from "./types.ts";
import { requireValidSimulationInput } from "./validate.ts";

/** 路线四态（规格 §引擎 API RouteResult）。 */
export type RouteResult =
  | { kind: "no-target" }
  | { kind: "in-range" }
  | { kind: "path"; hexes: AxialCoord[] }
  | { kind: "unreachable" };

/** 单棋子的初始目标分配。 */
export interface TargetAssignment {
  unitId: string;
  /** null = 无有效候选目标（no-target）或候选全部不可达（unreachable）。 */
  targetId: string | null;
}

/** 单棋子的初始路线。 */
export interface RouteAssignment {
  unitId: string;
  /** 与 targets 同源；null 时 route 为 no-target / unreachable 态。 */
  targetId: string | null;
  route: RouteResult;
}

/** previewInitial 的输出（规格 §引擎 API；本票不新增字段）。 */
export interface PreviewResult {
  targets: TargetAssignment[];
  routes: RouteAssignment[];
  /** 被集火数量：每个被锁定目标 ← 锁定它的对方棋子数（GLOSSARY「被集火数量」）。
   *  键为目标 unitId；键安全由 Map + Object.fromEntries 保证（own data property）。 */
  focusCounts: Record<string, number>;
  /** 模拟器结算顺序：全部 unitId 升序（compareUnitIds）【APPROXIMATED A9】，
   *  不代表真实 TFT 行动优先级。 */
  actionOrder: string[];
}

/**
 * previewInitial：对已校验场景推演"开战初期"的初始目标分配、路线四态、
 * 被集火数量与模拟器结算顺序。
 * - 输入先经强制校验门（requireValidSimulationInput）：九码语义失败抛
 *   SimulationInputError（携带 ValidationError[]），结构残缺抛 TypeError（T1 双通道约定）；
 * - 使用 tick 0 初始快照（buildInitialSnapshot，与 T6 simulate 同源）；
 * - targets / routes 按 unitId 升序排列，focusCounts 计入所有被锁定目标。
 */
export function previewInitial(input: SimulationInput): PreviewResult {
  requireValidSimulationInput(input);
  const snapshot = buildInitialSnapshot(input);

  const targets: TargetAssignment[] = [];
  const routes: RouteAssignment[] = [];
  // focusCounts 必须经 Map 累加（主控裁定，2026-11-07）：unitId 仅校验非空字符串，
  // 普通对象以 `obj[key] ?? 0` 累加时，键 "__proto__" 命中原型访问器（静默丢键）、
  // "constructor" 读到继承的 Object 构造器——Object.fromEntries 以 own data property
  // 落键，任意合法 unitId 均正确计数。
  const focusMap = new Map<string, number>();

  for (const unit of snapshot.units) {
    const resolution = resolveTargetAndRoute(unit, snapshot);
    if (resolution.kind === "resolved") {
      targets.push({ unitId: unit.unitId, targetId: resolution.targetId });
      routes.push({
        unitId: unit.unitId,
        targetId: resolution.targetId,
        route: resolution.route.inRange
          ? { kind: "in-range" }
          : { kind: "path", hexes: resolution.route.hexes },
      });
      focusMap.set(resolution.targetId, (focusMap.get(resolution.targetId) ?? 0) + 1);
    } else {
      targets.push({ unitId: unit.unitId, targetId: null });
      routes.push({
        unitId: unit.unitId,
        targetId: null,
        route: resolution.kind === "unreachable" ? { kind: "unreachable" } : { kind: "no-target" },
      });
    }
  }

  const focusCounts: Record<string, number> = Object.fromEntries(focusMap);
  const actionOrder = snapshot.units.map((unit) => unit.unitId); // 快照已按 unitId 升序
  return { targets, routes, focusCounts, actionOrder };
}
