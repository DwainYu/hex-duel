# 数据配置：版本契约简注（T1）

本目录存放外置 JSON 配置。JSON 不支持注释，版本契约以本文件为准；规格唯一事实来源：`docs/specs/playable-core.md`（§数据 schema、§异常情况）。

## 三个版本号

| 版本号 | 所在文件 | 含义 | 消费方式 |
|---|---|---|---|
| `schemaVersion` | 场景 JSON | **场景 JSON 结构版本**（当前 `"1"`，常量 `SUPPORTED_SCHEMA_VERSION`） | 导入校验 E1：缺失或不受支持即拒绝 |
| `catalogVersion` | `catalog.json` + 场景 JSON | **棋子目录版本**（规格既有） | 场景必须携带与其所用目录一致的 `catalogVersion`；不一致 = 导入错误 E2 |
| `rulesVersion` | `rules.json`（文件层） | **战斗规则版本**（镜像 `catalogVersion` 模式） | 引擎消费的 `Rules` 仅三个正整数参数，`rulesVersion` 为配置侧元数据 |

## 规则版本契约（MVP 全局唯一受支持配置）

- 场景 JSON **不携带** rulesVersion；导入场景一律按当前受支持规则配置（`rules.json`）运行。
- 实际使用的完整规则由 `BattleStarted.rulesSnapshot` 记录（T6 产出）。
- 测试夹具以完整 `SimulationInput`（场景 + 目录 + 规则）固定复现三元组（见 `tests/fixtures/`）。
- 未来若支持多套规则版本，需场景 schema 迁移记录 rulesVersion——经规格变更流程处理，本轮不做。

## APPROXIMATED 登记

A1–A9 简化规则（APPROXIMATED：确定性近似，非真实 TFT 机制）的**完整定义唯一事实来源**为规格登记表：`docs/specs/playable-core.md` §APPROXIMATED 简化规则登记（可替换点）。`rules.json` 仅承载 `approximatedRulesRef` 追溯指针，不复制登记内容，避免双源漂移（主控审查裁定，2026-11-07）。
