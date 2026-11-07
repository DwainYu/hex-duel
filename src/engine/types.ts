// 数据 schema 类型（规格 docs/specs/playable-core.md §数据 schema、§引擎 API、§异常情况）。
// 本文件仅类型与常量；校验逻辑在 validate.ts，事件类型在 events.ts。
// 版本契约（schemaVersion / catalogVersion / rulesVersion）见 src/data/README.md。
import type { OffsetCoord } from "./coordinates.ts";

export type Side = "blue" | "red";

export interface ScenarioUnit {
  unitId: string;
  unitDefId: string;
  side: Side;
  /** 逻辑 offset 坐标，1 基（col 1–7, row 1–8）。 */
  position: OffsetCoord;
}

export interface Scenario {
  schemaVersion: string;
  scenarioId: string;
  /** 场景所依据的目录版本；与传入目录不一致 = 导入错误（E2）。 */
  catalogVersion: string;
  units: ScenarioUnit[];
}

export interface UnitDefinition {
  unitDefId: string;
  name: string;
  /** 仅预留，MVP 逻辑不消费（规格 §数据 schema）。 */
  role?: string;
  /** 生命值，正数。 */
  hp: number;
  /** 攻击力，非负数。 */
  ad: number;
  /** 每秒攻击次数（数据与展示属性）。 */
  attackSpeed: number;
  /** 攻击射程（hex 距离），非负数。 */
  range: number;
}

export interface UnitCatalog {
  catalogVersion: string;
  units: UnitDefinition[];
}

/** 引擎消费的规则参数：三个正整数（规格 §数据 schema）。 */
export interface Rules {
  ticksPerSecond: number;
  moveIntervalTicks: number;
  timeoutTicks: number;
}

/**
 * rules.json 文件层结构：引擎 Rules + rulesVersion + APPROXIMATED 简化规则登记。
 * rulesVersion 置于规则配置文件层，镜像 UnitCatalog.catalogVersion 的模式（T1 版本契约）。
 */
export interface RulesFile extends Rules {
  rulesVersion: string;
  approximated: {
    note: string;
    ref: string;
    items: { id: string; summary: string }[];
  };
}

export interface SimulationInput {
  scenario: Scenario;
  catalog: UnitCatalog;
  rules: Rules;
}

/** 场景 JSON 结构版本（当前唯一受支持值）。 */
export const SUPPORTED_SCHEMA_VERSION = "1";

/** 九个输入校验错误码（规格 §异常情况 表序 E1–E9）。 */
export type ValidationErrorCode =
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "CATALOG_VERSION_MISMATCH"
  | "DUPLICATE_UNIT_ID"
  | "UNKNOWN_UNIT_DEF"
  | "POSITION_OCCUPIED"
  | "POSITION_OUT_OF_BOARD"
  | "EMPTY_SIDE"
  | "INVALID_SIDE"
  | "INVALID_STATS";

export interface ValidationError {
  code: ValidationErrorCode;
  /** 中文错误消息（编辑器直接展示原文）。 */
  message: string;
  /** 从输入根（scenario / catalog / rules）起点的点分路径，如 scenario.units[0].position。 */
  path: string;
}
