// 状态快照（T2 奠基，T6 复用并扩展）：目标/路线管线与战斗引擎共用的最小状态表示。
// 规格依据：docs/specs/playable-core.md §引擎 API（编辑器预览与战斗引擎必须共用目标选择
// 与路径函数）、§Tick 决策与结算顺序（所有存活棋子基于同一份 tick 开始状态快照决策）。
//
// 约定：
// - 快照内的位置一律为引擎 axial 坐标 (q, r)（GLOSSARY「格」；场景 JSON 对外继续 offset）；
// - 快照只读：管线函数不得修改快照内容；T6 每 tick 构造新快照而非原地变更；
// - units 按 unitId 升序（compareUnitIds）存放，保证任何遍历顺序确定。
import { offsetToAxial, type AxialCoord } from "./coordinates.ts";
import type { SimulationInput, Side } from "./types.ts";

/** unitId 的稳定比较：字符串逐码元（code unit）升序。
 *  规格中"同距按 unitId 稳定排序 / 同类事件按 unitId 稳定排序 / actionOrder 按 unitId"
 *  统一使用本比较器（T6 事件排序复用）。注意：≥10 个单位时 "u10" 排在 "u2" 之前，
 *  这是字符串序的确定结果（规格未定义数值感知排序，不得擅自引入格式假设）。 */
export function compareUnitIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 快照中的单个棋子状态（T2 最小集；T6 按需扩展 hp / 攻击与移动就绪 tick 等字段）。 */
export interface UnitSnapshot {
  unitId: string;
  unitDefId: string;
  side: Side;
  /** 引擎 axial 坐标 (q, r)；场景 offset 坐标由 buildInitialSnapshot 转换。 */
  position: AxialCoord;
  /** 攻击射程（自目录解析，hex 距离口径：目标在本格 range 内即可攻击）。 */
  range: number;
  /** 存活标记：初始快照恒为 true；T6 死亡结算置 false（其占格语义由 T6 管理）。 */
  alive: boolean;
}

/** 一次决策共用的状态快照（预览 = tick 0 初始快照；战斗 = 每 tick 开始快照）。 */
export interface StateSnapshot {
  /** 全部棋子（含已死亡，死亡者由 alive 标记）；按 unitId 升序存放。 */
  units: UnitSnapshot[];
}

/**
 * 由已通过校验的 SimulationInput 构建 tick 0 初始快照（previewInitial 与 T6 simulate 共用）。
 * 前置条件：输入已通过 validateSimulationInput（unitDefId 必在目录、坐标在棋盘内且互不重叠）；
 * 为防绕过校验直接调用，缺定义时以 TypeError 显式拒绝（形状断言通道，与 T1 约定一致）。
 */
export function buildInitialSnapshot(input: SimulationInput): StateSnapshot {
  const rangeByDefId = new Map(input.catalog.units.map((def) => [def.unitDefId, def.range]));
  const units: UnitSnapshot[] = input.scenario.units.map((scenarioUnit) => {
    const range = rangeByDefId.get(scenarioUnit.unitDefId);
    if (range === undefined) {
      throw new TypeError(
        `输入结构非法（scenario.units）：unitDefId ${scenarioUnit.unitDefId} 不在传入目录（须先通过 validateSimulationInput）`,
      );
    }
    return {
      unitId: scenarioUnit.unitId,
      unitDefId: scenarioUnit.unitDefId,
      side: scenarioUnit.side,
      position: offsetToAxial(scenarioUnit.position.col, scenarioUnit.position.row),
      range,
      alive: true,
    };
  });
  units.sort((a, b) => compareUnitIds(a.unitId, b.unitId));
  return { units };
}
