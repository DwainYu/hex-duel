// F16（规格 §Testing Decisions / §异常情况）：非法场景错误路径 E1–E9 全覆盖。
// 测试接缝：validateSimulationInput 纯函数 —— SimulationInput 进、ValidationError[] 出（规格主接缝的输入侧）。
// 预期错误码为独立事实来源：规格 §异常情况 错误明细表的九个触发条件。
//
// 双通道语义（主控审查裁定，2026-11-07）：
// - 九码语义校验 → ValidationError[]（本文件 F16 部分）；
// - 结构完整性 → TypeError（形状断言，规格九码无对应错误码，见 T1 修订交付报告映射建议）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSimulationInput } from "../src/engine/validate.ts";
import type { SimulationInput, ValidationError } from "../src/engine/types.ts";
import {
  catalogWithStats,
  defaultCatalog,
  defaultRules,
  loadScenarioFixture,
  rulesWith,
} from "./fixtures/loaders.ts";

/** 规格定义的全部九个错误码（独立事实来源，按 §异常情况 表序）。 */
const ALL_ERROR_CODES = [
  "SCHEMA_VERSION_UNSUPPORTED",
  "CATALOG_VERSION_MISMATCH",
  "DUPLICATE_UNIT_ID",
  "UNKNOWN_UNIT_DEF",
  "POSITION_OCCUPIED",
  "POSITION_OUT_OF_BOARD",
  "EMPTY_SIDE",
  "INVALID_SIDE",
  "INVALID_STATS",
] as const;

function inputFor(scenarioName: string): SimulationInput {
  return {
    scenario: loadScenarioFixture(scenarioName) as SimulationInput["scenario"],
    catalog: defaultCatalog(),
    rules: defaultRules(),
  };
}

function codesOf(errors: ValidationError[]): string[] {
  return errors.map((error) => error.code);
}

describe("F16：非法场景错误路径 E1–E9", () => {
  // 每个夹具都设计为恰好触发一个错误码（断言精确相等）；
  // 聚合行为由下方"多错误聚合"用例单独锁定。
  const f16Cases: { fixture: string; expectedCode: (typeof ALL_ERROR_CODES)[number] }[] = [
    { fixture: "f16-e1-missing-schema-version", expectedCode: "SCHEMA_VERSION_UNSUPPORTED" },
    { fixture: "f16-e1-unsupported-schema-version", expectedCode: "SCHEMA_VERSION_UNSUPPORTED" },
    { fixture: "f16-e2-catalog-version-mismatch", expectedCode: "CATALOG_VERSION_MISMATCH" },
    { fixture: "f16-e3-duplicate-unit-id", expectedCode: "DUPLICATE_UNIT_ID" },
    { fixture: "f16-e4-unknown-unit-def", expectedCode: "UNKNOWN_UNIT_DEF" },
    { fixture: "f16-e5-position-occupied", expectedCode: "POSITION_OCCUPIED" },
    { fixture: "f16-e6-position-out-of-board", expectedCode: "POSITION_OUT_OF_BOARD" },
    { fixture: "f16-e7-empty-side", expectedCode: "EMPTY_SIDE" },
    { fixture: "f16-e8-invalid-side", expectedCode: "INVALID_SIDE" },
  ];

  it("九个错误码全部被夹具覆盖", () => {
    const covered = new Set(f16Cases.map((c) => c.expectedCode));
    // E9 不走场景夹具：目录/规则非法输入由下方两组参数化用例覆盖
    covered.add("INVALID_STATS");
    for (const code of ALL_ERROR_CODES) {
      assert.ok(covered.has(code), `错误码 ${code} 缺少 F16 夹具`);
    }
  });

  for (const { fixture, expectedCode } of f16Cases) {
    it(`${fixture} → ${expectedCode}（单一错误）`, () => {
      const errors = validateSimulationInput(inputFor(fixture));
      assert.deepEqual(codesOf(errors), [expectedCode]);
    });
  }

  it("E9：目录数值非法（hp / ad / attackSpeed / range 各参数化）", () => {
    const invalidStats: { hp?: number; ad?: number; attackSpeed?: number; range?: number }[] = [
      { hp: 0 },
      { hp: -100 },
      { ad: -1 },
      { attackSpeed: 0 },
      { attackSpeed: -0.5 },
      { range: -1 },
    ];
    for (const stats of invalidStats) {
      const input = inputFor("valid-minimal");
      input.catalog = catalogWithStats("sentinel-shieldguard", stats);
      const errors = validateSimulationInput(input);
      assert.deepEqual(
        codesOf(errors),
        ["INVALID_STATS"],
        `目录 stats=${JSON.stringify(stats)} 应触发 INVALID_STATS，实际：${JSON.stringify(errors)}`,
      );
    }
  });

  it("E9：规则参数必须为正整数（ticksPerSecond / moveIntervalTicks / timeoutTicks 各参数化）", () => {
    const invalidRules: Partial<SimulationInput["rules"]>[] = [
      { ticksPerSecond: 0 },
      { ticksPerSecond: -10 },
      { ticksPerSecond: 10.5 },
      { moveIntervalTicks: -1 },
      { moveIntervalTicks: 0 },
      { timeoutTicks: 0 },
      { timeoutTicks: 600.5 },
    ];
    for (const overrides of invalidRules) {
      const input = inputFor("valid-minimal");
      input.rules = rulesWith(overrides);
      const errors = validateSimulationInput(input);
      assert.deepEqual(
        codesOf(errors),
        ["INVALID_STATS"],
        `rules=${JSON.stringify(overrides)} 应触发 INVALID_STATS，实际：${JSON.stringify(errors)}`,
      );
    }
  });
});

describe("校验：错误结构与聚合", () => {
  it("合法场景（valid-minimal）返回空错误数组", () => {
    assert.deepEqual(validateSimulationInput(inputFor("valid-minimal")), []);
  });

  it("全部错误携带 code / 非空中文 message / 非空 path，且 code 属于九码集合", () => {
    const allErrors: ValidationError[] = [
      "f16-e1-missing-schema-version",
      "f16-e1-unsupported-schema-version",
      "f16-e2-catalog-version-mismatch",
      "f16-e3-duplicate-unit-id",
      "f16-e4-unknown-unit-def",
      "f16-e5-position-occupied",
      "f16-e6-position-out-of-board",
      "f16-e7-empty-side",
      "f16-e8-invalid-side",
    ].flatMap((fixture) => validateSimulationInput(inputFor(fixture)));
    // E9 目录/规则错误单独补充
    const e9Input = inputFor("valid-minimal");
    e9Input.catalog = catalogWithStats("sentinel-shieldguard", { hp: 0 });
    allErrors.push(...validateSimulationInput(e9Input));
    const e9RulesInput = inputFor("valid-minimal");
    e9RulesInput.rules = rulesWith({ moveIntervalTicks: 0 });
    allErrors.push(...validateSimulationInput(e9RulesInput));

    assert.ok(allErrors.length >= 11);
    for (const error of allErrors) {
      assert.ok(
        (ALL_ERROR_CODES as readonly string[]).includes(error.code),
        `未知错误码：${error.code}`,
      );
      assert.ok(error.message.length > 0, "message 不得为空");
      assert.match(error.message, /[\u4e00-\u9fa5]/, `message 应为中文：${error.message}`);
      assert.ok(error.path.length > 0, "path 不得为空");
      assert.match(error.path, /^(scenario|catalog|rules)\./, `path 应从输入根开始：${error.path}`);
    }
  });

  it("多错误聚合：unitId 重复与未知棋子定义同时报告", () => {
    const input = inputFor("valid-minimal");
    const units = input.scenario.units;
    if (!units[0] || !units[1]) throw new Error("夹具缺少预置棋子");
    units[1].unitId = units[0].unitId;
    units[1].unitDefId = "ghost-def";
    const errors = validateSimulationInput(input);
    assert.deepEqual(codesOf(errors).sort(), ["DUPLICATE_UNIT_ID", "UNKNOWN_UNIT_DEF"]);
  });

  it("错误 path 指向具体字段（抽查 E1/E2/E6）", () => {
    assert.deepEqual(
      validateSimulationInput(inputFor("f16-e1-missing-schema-version"))[0]?.path,
      "scenario.schemaVersion",
    );
    assert.deepEqual(
      validateSimulationInput(inputFor("f16-e2-catalog-version-mismatch"))[0]?.path,
      "scenario.catalogVersion",
    );
    assert.deepEqual(
      validateSimulationInput(inputFor("f16-e6-position-out-of-board"))[0]?.path,
      "scenario.units[0].position",
    );
  });
});

describe("形状断言：结构残缺输入以 TypeError 拒绝（不经 ValidationError 通道）", () => {
  // 结构完整性在规格九码中没有对应错误码；映射建议见 T1 修订交付报告，
  // 规格新增错误码（或扩展现有定义）之前，结构残缺一律走异常通道。
  const shapeCases: { name: string; mutate: (input: SimulationInput) => void }[] = [
    {
      name: "场景文件缺 units（夹具 structure-missing-units.json，模拟手改/损坏的导入文件）",
      mutate: (input) => {
        input.scenario = loadScenarioFixture("structure-missing-units") as SimulationInput["scenario"];
      },
    },
    {
      name: "scenario 缺 scenarioId",
      mutate: (input) => {
        delete (input.scenario as unknown as Record<string, unknown>).scenarioId;
      },
    },
    {
      name: "scenario 缺 catalogVersion",
      mutate: (input) => {
        delete (input.scenario as unknown as Record<string, unknown>).catalogVersion;
      },
    },
    {
      name: "unit 缺 unitId",
      mutate: (input) => {
        delete (input.scenario.units[0] as unknown as Record<string, unknown>).unitId;
      },
    },
    {
      name: "unit 缺 position",
      mutate: (input) => {
        delete (input.scenario.units[0] as unknown as Record<string, unknown>).position;
      },
    },
    {
      name: "unit position.col 非数值",
      mutate: (input) => {
        (input.scenario.units[0]!.position as unknown as Record<string, unknown>).col = "2";
      },
    },
    {
      name: "input 缺 catalog（内部配置残缺）",
      mutate: (input) => {
        delete (input as unknown as Record<string, unknown>).catalog;
      },
    },
    {
      name: "input 缺 rules（内部配置残缺）",
      mutate: (input) => {
        delete (input as unknown as Record<string, unknown>).rules;
      },
    },
    {
      name: "catalog 缺 catalogVersion（内部配置残缺）",
      mutate: (input) => {
        delete (input.catalog as unknown as Record<string, unknown>).catalogVersion;
      },
    },
    {
      name: "catalog.units 非数组（内部配置残缺）",
      mutate: (input) => {
        (input.catalog as unknown as Record<string, unknown>).units = {};
      },
    },
    {
      name: "目录 unitDefId 重复（内部配置残缺）",
      mutate: (input) => {
        input.catalog.units.push({ ...input.catalog.units[0]! });
      },
    },
    {
      name: "目录 def 缺 name（内部配置残缺）",
      mutate: (input) => {
        delete (input.catalog.units[0] as unknown as Record<string, unknown>).name;
      },
    },
  ];

  for (const { name, mutate } of shapeCases) {
    it(name, () => {
      const input = inputFor("valid-minimal");
      mutate(input);
      assert.throws(() => validateSimulationInput(input), TypeError);
    });
  }
});
