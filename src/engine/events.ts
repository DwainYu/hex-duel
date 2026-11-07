// 八类战斗事件类型（规格 docs/specs/playable-core.md §事件 schema，v1.0.2）。
// 本票仅类型定义；事件产出逻辑在 T6（MVP-2 战斗引擎 simulate）实现。
//
// 约定：
// - sequence：全局递增，从 1 开始，按产生顺序连续、不跳号（不变量 I8）。
// - tick：整数 tick；BattleStarted 为 tick 0，决策事件从 tick 1 起。
// - 位置字段（from / to / position / hexes）使用引擎内部 axial 坐标
//   （GLOSSARY「格」：引擎内以 axial 坐标 (q, r) 表示；对外展示由 UI 转换）。
import type { AxialCoord } from "./coordinates.ts";
import type { Rules, Side } from "./types.ts";

/** 推演开始（初始状态，无决策）。 */
export interface BattleStartedEvent {
  type: "BattleStarted";
  sequence: number;
  tick: 0;
  scenarioId: string;
  /** 实际使用的完整规则（MVP 全局唯一受支持配置，见 src/data/README.md 版本契约）。 */
  rulesSnapshot: Rules;
}

/** 初始分配与每次重选。 */
export interface TargetAssignedEvent {
  type: "TargetAssigned";
  sequence: number;
  tick: number;
  unitId: string;
  targetId: string;
  reason: "initial" | "retarget";
}

/** 原目标失效且无有效新目标；播放器移除该单位目标连线。 */
export interface TargetClearedEvent {
  type: "TargetCleared";
  sequence: number;
  tick: number;
  unitId: string;
}

/** 每次成功移动一格。 */
export interface UnitMovedEvent {
  type: "UnitMoved";
  sequence: number;
  tick: number;
  unitId: string;
  from: AxialCoord;
  to: AxialCoord;
}

/** 单次普攻；不含 HP 字段——统一伤害由 HpChanged 记录。 */
export interface AttackEvent {
  type: "Attack";
  sequence: number;
  tick: number;
  attackerId: string;
  targetId: string;
  damage: number;
}

/** 同一 tick 内某目标收到的汇总伤害（每目标每 tick 至多一条，不变量 I9）。 */
export interface HpChangedEvent {
  type: "HpChanged";
  sequence: number;
  tick: number;
  unitId: string;
  hpBefore: number;
  totalDamage: number;
  hpAfter: number;
}

/** 死亡（位置随结算释放，下一 tick 起可被占用）。 */
export interface UnitDiedEvent {
  type: "UnitDied";
  sequence: number;
  tick: number;
  unitId: string;
  position: AxialCoord;
}

/** 推演结束。 */
export interface BattleEndedEvent {
  type: "BattleEnded";
  sequence: number;
  tick: number;
  result: Side | "draw";
  reason: "wipeout" | "timeout";
}

export type BattleEvent =
  | BattleStartedEvent
  | TargetAssignedEvent
  | TargetClearedEvent
  | UnitMovedEvent
  | AttackEvent
  | HpChangedEvent
  | UnitDiedEvent
  | BattleEndedEvent;
