// 测试夹具体系（T1 奠基，规格 §Testing Decisions）：
// - 夹具输入场景 JSON 集中单一来源存放于 tests/fixtures/scenarios/，后续 T2/T5/T6 复用同一体系，禁止各自复制场景数据；
// - 默认输入使用 src/data/ 下真实 catalog.json / rules.json（完整 SimulationInput 三元组固定复现）；
// - E9 类目录/规则非法输入不复制真实配置，用 builder 从默认对象派生，保持单一来源。
import { readFileSync } from "node:fs";

import type { Rules, RulesFile, UnitCatalog, UnitDefinition } from "../../src/engine/types.ts";

const fixturesDir = new URL(".", import.meta.url);

/** 读取 scenarios/ 下的夹具场景 JSON（原样返回，供非法输入测试）。 */
export function loadScenarioFixture(name: string): unknown {
  const file = new URL(`./scenarios/${name}.json`, fixturesDir);
  return JSON.parse(readFileSync(file, "utf-8")) as unknown;
}

/** 真实棋子目录（单一来源：src/data/catalog.json）。 */
export function defaultCatalog(): UnitCatalog {
  const file = new URL("../../src/data/catalog.json", fixturesDir);
  return JSON.parse(readFileSync(file, "utf-8")) as UnitCatalog;
}

/** 真实规则（单一来源：src/data/rules.json；剥离文件层元数据，仅引擎三参数）。 */
export function defaultRules(): Rules {
  const file = new URL("../../src/data/rules.json", fixturesDir);
  const fileConfig = JSON.parse(readFileSync(file, "utf-8")) as RulesFile;
  return {
    ticksPerSecond: fileConfig.ticksPerSecond,
    moveIntervalTicks: fileConfig.moveIntervalTicks,
    timeoutTicks: fileConfig.timeoutTicks,
  };
}

/** 从默认目录派生：把指定棋子定义的数值字段替换为非法值（E9 夹具）。 */
export function catalogWithStats(
  unitDefId: string,
  stats: Partial<Pick<UnitDefinition, "hp" | "ad" | "attackSpeed" | "range">>,
): UnitCatalog {
  const catalog = defaultCatalog();
  const units = catalog.units.map((unit) =>
    unit.unitDefId === unitDefId ? { ...unit, ...stats } : unit,
  );
  if (units.every((unit) => unit.unitDefId !== unitDefId)) {
    throw new Error(`catalogWithStats：目录中不存在 unitDefId=${unitDefId}`);
  }
  return { ...catalog, units };
}

/** 从默认规则派生：替换指定规则参数（E9 夹具）。 */
export function rulesWith(overrides: Partial<Rules>): Rules {
  return { ...defaultRules(), ...overrides };
}
