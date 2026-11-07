// 输入校验（规格 docs/specs/playable-core.md §异常情况）：
// simulate / previewInitial 执行前强制校验 SimulationInput，失败即拒绝并返回
// 结构化错误数组 ValidationError[]（code / 中文 message / path），编辑器展示原文。
//
// 实现说明：
// - 纯函数，无浏览器依赖；校验聚合收集全部可判定错误（确定性顺序）。
// - 九个错误码 E1–E9 按规格触发条件实现；对"结构残缺但九码未直接涵盖"的防御性分支
//   （如 scenarioId/units 缺失、目录结构非法），就近归入 E1（场景 schema 不符）或
//   E9（目录/规则非法），避免校验器在畸形输入上抛异常——此为解释性裁定，见 T1 交付报告。
// - 后续语义检查在结构无效处跳过，避免级联噪音。
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

  if (!isRecord(root) || !isRecord(root.scenario)) {
    return [
      err("SCHEMA_VERSION_UNSUPPORTED", "scenario", "输入缺少场景对象（scenario），无法按受支持 schema 解析"),
    ];
  }
  const scenario: Record<string, unknown> = root.scenario;

  // ---- E1：schemaVersion 缺失或不受支持 + 场景结构残缺归入 E1 ----
  if (scenario.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.push(
      err(
        "SCHEMA_VERSION_UNSUPPORTED",
        "scenario.schemaVersion",
        `schemaVersion 缺失或不受支持：期望 "${SUPPORTED_SCHEMA_VERSION}"，实际 ${describeValue(scenario.schemaVersion)}`,
      ),
    );
  }
  if (!isNonEmptyString(scenario.scenarioId)) {
    errors.push(
      err("SCHEMA_VERSION_UNSUPPORTED", "scenario.scenarioId", "场景结构非法：scenarioId 必须为非空字符串"),
    );
  }
  if (!isNonEmptyString(scenario.catalogVersion)) {
    errors.push(
      err("SCHEMA_VERSION_UNSUPPORTED", "scenario.catalogVersion", "场景结构非法：catalogVersion 必须为非空字符串"),
    );
  }
  const units: unknown[] = Array.isArray(scenario.units) ? scenario.units : [];
  const unitsOk = Array.isArray(scenario.units);
  if (!unitsOk) {
    errors.push(err("SCHEMA_VERSION_UNSUPPORTED", "scenario.units", "场景结构非法：units 必须为数组"));
  }

  // ---- 目录结构（E2 依赖 catalogVersion；E4 依赖目录 defs；E9 覆盖目录合法性）----
  const catalogRaw = isRecord(root.catalog) ? root.catalog : null;
  let catalogUnits: unknown[] | null = null;
  if (catalogRaw === null) {
    errors.push(err("INVALID_STATS", "catalog", "输入缺少棋子目录对象（catalog）"));
  } else {
    if (Array.isArray(catalogRaw.units)) {
      catalogUnits = catalogRaw.units;
    } else {
      errors.push(err("INVALID_STATS", "catalog.units", "目录结构非法：units 必须为数组"));
    }
    if (!isNonEmptyString(catalogRaw.catalogVersion)) {
      errors.push(
        err("INVALID_STATS", "catalog.catalogVersion", "目录结构非法：catalogVersion 必须为非空字符串"),
      );
    }
  }

  // ---- E2：场景 catalogVersion 与传入目录不一致 ----
  if (
    isNonEmptyString(scenario.catalogVersion) &&
    catalogRaw !== null &&
    isNonEmptyString(catalogRaw.catalogVersion) &&
    scenario.catalogVersion !== catalogRaw.catalogVersion
  ) {
    errors.push(
      err(
        "CATALOG_VERSION_MISMATCH",
        "scenario.catalogVersion",
        `场景 catalogVersion（${describeValue(scenario.catalogVersion)}）与传入目录版本（${describeValue(catalogRaw.catalogVersion)}）不一致`,
      ),
    );
  }

  // 目录内有效 unitDefId 集合（E4 判定依据；与目录数值合法性无关）
  const catalogDefIds = new Set<string>();
  if (catalogUnits !== null) {
    for (const def of catalogUnits) {
      if (isRecord(def) && isNonEmptyString(def.unitDefId)) {
        catalogDefIds.add(def.unitDefId);
      }
    }
  }

  // ---- 逐棋子检查 ----
  if (unitsOk) {
    const seenUnitIds = new Map<string, number>();
    const seenCells = new Map<string, number>();
    const validSideCounts = { blue: 0, red: 0 };

    units.forEach((unitRaw, index) => {
      const unitPath = `scenario.units[${index}]`;
      if (!isRecord(unitRaw)) {
        errors.push(err("SCHEMA_VERSION_UNSUPPORTED", unitPath, "场景结构非法：unit 必须为对象"));
        return;
      }

      if (!isNonEmptyString(unitRaw.unitId)) {
        errors.push(
          err("SCHEMA_VERSION_UNSUPPORTED", `${unitPath}.unitId`, "场景结构非法：unitId 必须为非空字符串"),
        );
      } else {
        const firstIndex = seenUnitIds.get(unitRaw.unitId);
        if (firstIndex !== undefined) {
          errors.push(
            err(
              "DUPLICATE_UNIT_ID",
              `${unitPath}.unitId`,
              `unitId 重复：${describeValue(unitRaw.unitId)}（首次出现于 scenario.units[${firstIndex}]）`,
            ),
          );
        } else {
          seenUnitIds.set(unitRaw.unitId, index);
        }
      }

      if (unitRaw.side === "blue" || unitRaw.side === "red") {
        validSideCounts[unitRaw.side] += 1;
      } else {
        errors.push(
          err(
            "INVALID_SIDE",
            `${unitPath}.side`,
            `side 取值非法：${describeValue(unitRaw.side)}（合法值 "blue" | "red"）`,
          ),
        );
      }

      if (!isNonEmptyString(unitRaw.unitDefId)) {
        errors.push(
          err("SCHEMA_VERSION_UNSUPPORTED", `${unitPath}.unitDefId`, "场景结构非法：unitDefId 必须为非空字符串"),
        );
      } else if (!catalogDefIds.has(unitRaw.unitDefId)) {
        errors.push(
          err(
            "UNKNOWN_UNIT_DEF",
            `${unitPath}.unitDefId`,
            `unitDefId 不在传入目录：${describeValue(unitRaw.unitDefId)}`,
          ),
        );
      }

      const position: unknown = unitRaw.position;
      if (!isRecord(position) || !isFiniteNumber(position.col) || !isFiniteNumber(position.row)) {
        errors.push(
          err(
            "SCHEMA_VERSION_UNSUPPORTED",
            `${unitPath}.position`,
            "场景结构非法：position 必须为含数值 col / row 的对象",
          ),
        );
      } else if (!isOnBoard(position.col, position.row)) {
        errors.push(
          err(
            "POSITION_OUT_OF_BOARD",
            `${unitPath}.position`,
            `offset 坐标越界：col=${position.col}, row=${position.row}（合法范围 col 1–7, row 1–8，且为整数）`,
          ),
        );
      } else {
        const cellKey = `${position.col},${position.row}`;
        const firstIndex = seenCells.get(cellKey);
        if (firstIndex !== undefined) {
          errors.push(
            err(
              "POSITION_OCCUPIED",
              `${unitPath}.position`,
              `多个棋子同格：(${position.col}, ${position.row})（scenario.units[${firstIndex}] 已占用）`,
            ),
          );
        } else {
          seenCells.set(cellKey, index);
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
  }

  // ---- E9：目录数值非法 ----
  if (catalogUnits !== null) {
    const seenDefIds = new Set<string>();
    catalogUnits.forEach((defRaw, index) => {
      const defPath = `catalog.units[${index}]`;
      if (!isRecord(defRaw)) {
        errors.push(err("INVALID_STATS", defPath, "目录结构非法：棋子定义必须为对象"));
        return;
      }
      if (isNonEmptyString(defRaw.unitDefId)) {
        if (seenDefIds.has(defRaw.unitDefId)) {
          errors.push(
            err("INVALID_STATS", `${defPath}.unitDefId`, `目录 unitDefId 重复：${describeValue(defRaw.unitDefId)}`),
          );
        }
        seenDefIds.add(defRaw.unitDefId);
      } else {
        errors.push(
          err("INVALID_STATS", `${defPath}.unitDefId`, "目录结构非法：unitDefId 必须为非空字符串"),
        );
      }
      if (!isNonEmptyString(defRaw.name)) {
        errors.push(err("INVALID_STATS", `${defPath}.name`, "目录结构非法：name 必须为非空字符串"));
      }
      if (!isFiniteNumber(defRaw.hp) || defRaw.hp <= 0) {
        errors.push(
          err("INVALID_STATS", `${defPath}.hp`, `目录数值非法：hp 必须 > 0，实际 ${describeValue(defRaw.hp)}`),
        );
      }
      if (!isFiniteNumber(defRaw.ad) || defRaw.ad < 0) {
        errors.push(
          err("INVALID_STATS", `${defPath}.ad`, `目录数值非法：ad 必须 ≥ 0，实际 ${describeValue(defRaw.ad)}`),
        );
      }
      if (!isFiniteNumber(defRaw.attackSpeed) || defRaw.attackSpeed <= 0) {
        errors.push(
          err(
            "INVALID_STATS",
            `${defPath}.attackSpeed`,
            `目录数值非法：attackSpeed 必须 > 0，实际 ${describeValue(defRaw.attackSpeed)}`,
          ),
        );
      }
      if (!isFiniteNumber(defRaw.range) || defRaw.range < 0) {
        errors.push(
          err("INVALID_STATS", `${defPath}.range`, `目录数值非法：range 必须 ≥ 0，实际 ${describeValue(defRaw.range)}`),
        );
      }
    });
  }

  // ---- E9：规则参数必须为正整数 ----
  const rulesRaw = isRecord(root.rules) ? root.rules : null;
  if (rulesRaw === null) {
    errors.push(err("INVALID_STATS", "rules", "输入缺少规则对象（rules）"));
  } else {
    if (!isPositiveInteger(rulesRaw.ticksPerSecond)) {
      errors.push(
        err(
          "INVALID_STATS",
          "rules.ticksPerSecond",
          `规则参数非法：ticksPerSecond 必须为正整数，实际 ${describeValue(rulesRaw.ticksPerSecond)}`,
        ),
      );
    }
    if (!isPositiveInteger(rulesRaw.moveIntervalTicks)) {
      errors.push(
        err(
          "INVALID_STATS",
          "rules.moveIntervalTicks",
          `规则参数非法：moveIntervalTicks 必须为正整数，实际 ${describeValue(rulesRaw.moveIntervalTicks)}`,
        ),
      );
    }
    if (!isPositiveInteger(rulesRaw.timeoutTicks)) {
      errors.push(
        err(
          "INVALID_STATS",
          "rules.timeoutTicks",
          `规则参数非法：timeoutTicks 必须为正整数，实际 ${describeValue(rulesRaw.timeoutTicks)}`,
        ),
      );
    }
  }

  return errors;
}
