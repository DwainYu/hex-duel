// 输入校验（规格 docs/specs/playable-core.md §异常情况）：
// simulate / previewInitial 执行前强制校验 SimulationInput，失败即拒绝并返回
// 结构化错误数组 ValidationError[]（code / 中文 message / path），编辑器展示原文。
//
// 双通道设计（主控审查裁定，2026-11-07）：
// 1. 语义校验 → ValidationError[]：九个错误码 E1–E9 严格按规格触发条件的字面语义实现，
//    不吸收结构残缺、不扩大语义（E9 仅目录数值与规则参数；E1 仅 schemaVersion）。
// 2. 形状断言 → TypeError：SimulationInput 的结构完整性检查（TS 类型的运行时镜像）。
//    结构残缺在规格九码中没有对应错误码，不得擅自归类（见 T1 修订交付报告的映射建议），
//    因此以 TypeError 拒绝——内部 catalog/rules 配置残缺属于开发者域的契约破裂；
//    手写/损坏的场景文件若结构残缺，同样经此通道拒绝，导入层（T3）负责 catch 并展示。
//
// 纯函数，无浏览器依赖；错误按固定顺序聚合（确定性）。
import { isOnBoard } from "./coordinates.ts";
import {
  SUPPORTED_SCHEMA_VERSION,
  type SimulationInput,
  type ValidationError,
  type ValidationErrorCode,
} from "./types.ts";

function err(code: ValidationErrorCode, path: string, message: string): ValidationError {
  return { code, path, message };
}

/**
 * 形状断言：结构完整性不满足即抛 TypeError（不进入 ValidationError 通道）。
 * 断言函数签名（asserts condition）：调用点之后，条件表达式中的类型守卫收窄
 * （isRecord / isNonEmptyString / isFiniteNumber / Array.isArray 等）继续生效。
 */
function assertShape(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) {
    throw new TypeError(`输入结构非法（${path}）：${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 面向中文错误消息的值描述。 */
function describeValue(value: unknown): string {
  if (value === undefined) return "缺失";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? "数组" : "对象";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function validateSimulationInput(input: SimulationInput): ValidationError[] {
  const errors: ValidationError[] = [];
  const root: unknown = input;

  // ---- 形状断言：输入三对象与场景/目录结构完整性 ----
  assertShape(isRecord(root), "input", "SimulationInput 必须为对象");
  assertShape(isRecord(root.scenario), "scenario", "缺少场景对象（scenario）");
  assertShape(isRecord(root.catalog), "catalog", "缺少棋子目录对象（catalog）");
  assertShape(isRecord(root.rules), "rules", "缺少规则对象（rules）");
  const scenario: Record<string, unknown> = root.scenario;
  const catalog: Record<string, unknown> = root.catalog;
  const rules: Record<string, unknown> = root.rules;

  assertShape(
    isNonEmptyString(scenario.scenarioId),
    "scenario.scenarioId",
    "scenarioId 必须为非空字符串",
  );
  assertShape(
    isNonEmptyString(scenario.catalogVersion),
    "scenario.catalogVersion",
    "catalogVersion 必须为非空字符串",
  );
  assertShape(Array.isArray(scenario.units), "scenario.units", "units 必须为数组");

  assertShape(
    isNonEmptyString(catalog.catalogVersion),
    "catalog.catalogVersion",
    "catalogVersion 必须为非空字符串",
  );
  assertShape(Array.isArray(catalog.units), "catalog.units", "units 必须为数组");
  const catalogUnits: unknown[] = catalog.units;

  // ---- E1：schemaVersion 缺失或不受支持（规格字面）----
  if (scenario.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.push(
      err(
        "SCHEMA_VERSION_UNSUPPORTED",
        "scenario.schemaVersion",
        `schemaVersion 缺失或不受支持：期望 "${SUPPORTED_SCHEMA_VERSION}"，实际 ${describeValue(scenario.schemaVersion)}`,
      ),
    );
  }

  // ---- E2：场景 catalogVersion 与传入目录不一致（规格字面）----
  if (scenario.catalogVersion !== catalog.catalogVersion) {
    errors.push(
      err(
        "CATALOG_VERSION_MISMATCH",
        "scenario.catalogVersion",
        `场景 catalogVersion（${describeValue(scenario.catalogVersion)}）与传入目录版本（${describeValue(catalog.catalogVersion)}）不一致`,
      ),
    );
  }

  // ---- 目录结构完整性（内部配置，形状断言通道）----
  const catalogDefIds = new Set<string>();
  for (const [index, defRaw] of catalogUnits.entries()) {
    const defPath = `catalog.units[${index}]`;
    assertShape(isRecord(defRaw), defPath, "棋子定义必须为对象");
    const def: Record<string, unknown> = defRaw;
    assertShape(
      isNonEmptyString(def.unitDefId),
      `${defPath}.unitDefId`,
      "unitDefId 必须为非空字符串",
    );
    assertShape(
      !catalogDefIds.has(def.unitDefId),
      `${defPath}.unitDefId`,
      `目录 unitDefId 重复：${describeValue(def.unitDefId)}`,
    );
    catalogDefIds.add(def.unitDefId);
    assertShape(isNonEmptyString(def.name), `${defPath}.name`, "name 必须为非空字符串");
  }

  // ---- 逐棋子：形状断言 + E8 / E4 / E6 / E3 / E5 ----
  const units: unknown[] = scenario.units;
  const seenUnitIds = new Map<string, number>();
  const seenCells = new Map<string, number>();
  const validSideCounts = { blue: 0, red: 0 };

  units.forEach((unitRaw, index) => {
    const unitPath = `scenario.units[${index}]`;
    assertShape(isRecord(unitRaw), unitPath, "unit 必须为对象");
    const unit: Record<string, unknown> = unitRaw;

    assertShape(
      isNonEmptyString(unit.unitId),
      `${unitPath}.unitId`,
      "unitId 必须为非空字符串",
    );
    const firstIdIndex = seenUnitIds.get(unit.unitId);
    if (firstIdIndex === undefined) {
      seenUnitIds.set(unit.unitId, index);
    } else {
      // E3：unitId 重复
      errors.push(
        err(
          "DUPLICATE_UNIT_ID",
          `${unitPath}.unitId`,
          `unitId 重复：${describeValue(unit.unitId)}（首次出现于 scenario.units[${firstIdIndex}]）`,
        ),
      );
    }

    if (unit.side === "blue" || unit.side === "red") {
      validSideCounts[unit.side] += 1;
    } else {
      // E8：side 取值非法（含缺失）
      errors.push(
        err(
          "INVALID_SIDE",
          `${unitPath}.side`,
          `side 取值非法：${describeValue(unit.side)}（合法值 "blue" | "red"）`,
        ),
      );
    }

    assertShape(
      isNonEmptyString(unit.unitDefId),
      `${unitPath}.unitDefId`,
      "unitDefId 必须为非空字符串",
    );
    if (!catalogDefIds.has(unit.unitDefId)) {
      // E4：unitDefId 不在传入目录
      errors.push(
        err(
          "UNKNOWN_UNIT_DEF",
          `${unitPath}.unitDefId`,
          `unitDefId 不在传入目录：${describeValue(unit.unitDefId)}`,
        ),
      );
    }

    const position: unknown = unit.position;
    assertShape(isRecord(position), `${unitPath}.position`, "position 必须为对象");
    assertShape(
      isFiniteNumber(position.col) && isFiniteNumber(position.row),
      `${unitPath}.position`,
      "position 必须为含数值 col / row 的对象",
    );
    if (!isOnBoard(position.col, position.row)) {
      // E6：offset 坐标越界（含非整数格）
      errors.push(
        err(
          "POSITION_OUT_OF_BOARD",
          `${unitPath}.position`,
          `offset 坐标越界：col=${position.col}, row=${position.row}（合法范围 col 1–7, row 1–8，且为整数）`,
        ),
      );
    } else {
      const cellKey = `${position.col},${position.row}`;
      const firstCellIndex = seenCells.get(cellKey);
      if (firstCellIndex === undefined) {
        seenCells.set(cellKey, index);
      } else {
        // E5：多棋子同格
        errors.push(
          err(
            "POSITION_OCCUPIED",
            `${unitPath}.position`,
            `多个棋子同格：(${position.col}, ${position.row})（scenario.units[${firstCellIndex}] 已占用）`,
          ),
        );
      }
    }
  });

  // ---- E7：任一方棋子数为 0 ----
  if (validSideCounts.blue === 0) {
    errors.push(err("EMPTY_SIDE", "scenario.units", "蓝方（blue）棋子数为 0，双方都必须至少有 1 枚棋子"));
  }
  if (validSideCounts.red === 0) {
    errors.push(err("EMPTY_SIDE", "scenario.units", "红方（red）棋子数为 0，双方都必须至少有 1 枚棋子"));
  }

  // ---- E9：目录数值非法（规格字面：hp ≤ 0、ad < 0、attackSpeed ≤ 0、range < 0）----
  for (const [index, defRaw] of catalogUnits.entries()) {
    const defPath = `catalog.units[${index}]`;
    assertShape(isRecord(defRaw), defPath, "棋子定义必须为对象");
    const def: Record<string, unknown> = defRaw;
    if (!isFiniteNumber(def.hp) || def.hp <= 0) {
      errors.push(
        err("INVALID_STATS", `${defPath}.hp`, `目录数值非法：hp 必须 > 0，实际 ${describeValue(def.hp)}`),
      );
    }
    if (!isFiniteNumber(def.ad) || def.ad < 0) {
      errors.push(
        err("INVALID_STATS", `${defPath}.ad`, `目录数值非法：ad 必须 ≥ 0，实际 ${describeValue(def.ad)}`),
      );
    }
    if (!isFiniteNumber(def.attackSpeed) || def.attackSpeed <= 0) {
      errors.push(
        err(
          "INVALID_STATS",
          `${defPath}.attackSpeed`,
          `目录数值非法：attackSpeed 必须 > 0，实际 ${describeValue(def.attackSpeed)}`,
        ),
      );
    }
    if (!isFiniteNumber(def.range) || def.range < 0) {
      errors.push(
        err("INVALID_STATS", `${defPath}.range`, `目录数值非法：range 必须 ≥ 0，实际 ${describeValue(def.range)}`),
      );
    }
  }

  // ---- E9：规则参数非正整数（规格字面；类型错 / 缺失同属"非正整数"）----
  if (!isPositiveInteger(rules.ticksPerSecond)) {
    errors.push(
      err(
        "INVALID_STATS",
        "rules.ticksPerSecond",
        `规则参数非法：ticksPerSecond 必须为正整数，实际 ${describeValue(rules.ticksPerSecond)}`,
      ),
    );
  }
  if (!isPositiveInteger(rules.moveIntervalTicks)) {
    errors.push(
      err(
        "INVALID_STATS",
        "rules.moveIntervalTicks",
        `规则参数非法：moveIntervalTicks 必须为正整数，实际 ${describeValue(rules.moveIntervalTicks)}`,
      ),
    );
  }
  if (!isPositiveInteger(rules.timeoutTicks)) {
    errors.push(
      err(
        "INVALID_STATS",
        "rules.timeoutTicks",
        `规则参数非法：timeoutTicks 必须为正整数，实际 ${describeValue(rules.timeoutTicks)}`,
      ),
    );
  }

  return errors;
}

/**
 * SimulationInput 语义校验失败的异常通道：公共 API（previewInitial / T6 simulate）
 * 的强制校验门（规格 §异常情况："执行前强制校验，失败即拒绝"）。
 * 携带完整结构化 ValidationError[]（code / 中文 message / path），编辑器层 catch 后展示原文。
 * 通道约定与 T1 裁定一致：结构残缺走 TypeError（形状断言），九码语义失败走本异常——
 * 保持公共 API 成功签名纯净（PreviewResult / BattleEvent[]），失败形态由异常类型区分。
 */
export class SimulationInputError extends Error {
  /** 全部语义校验错误（非空）。 */
  readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    super(
      `SimulationInput 校验失败（${errors.length} 项）：${errors
        .map((error) => `${error.code}@${error.path}`)
        .join("; ")}`,
    );
    this.name = "SimulationInputError";
    this.errors = errors;
  }
}

/**
 * 强制校验门：无语义错误时静默通过，否则抛出携带 ValidationError[] 的 SimulationInputError。
 * 结构残缺仍以 TypeError 抛出（assertShape 通道），调用方应一并 catch（T3 导入层同约定）。
 */
export function requireValidSimulationInput(input: SimulationInput): void {
  const errors = validateSimulationInput(input);
  if (errors.length > 0) {
    throw new SimulationInputError(errors);
  }
}
