# HEX DUEL（六角对位）

轻量化站位策略游戏：玩家观察敌方阵容与站位，调整己方阵容与站位，由确定性引擎推演开战初期对位过程。项目定位与阶段策略见 `AGENTS.md` 与 `docs/adr/`。

当前进度：T1（工程脚手架 + Schema/校验 + 坐标几何）。规格唯一事实来源：`docs/specs/playable-core.md`。

## 环境要求

- **Node >= 22.12.0**（精确下限，已写入 `package.json` `engines.node`）。
  - 22.6.0 起支持 `--experimental-strip-types`（Node 原生 TS type stripping），测试依赖该能力直接运行 `.ts` 测试文件；
  - 22.12.0 是 22 LTS 线上同时满足 Vite 7（要求 `^20.19.0 || >=22.12.0`）的最低版本；
  - 本仓库开发验证环境为 Node v24（type stripping 默认开启，旗标兼容）。
- npm（随 Node 附带）。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm test` | 运行全部测试（`node --test` 直接运行 TS 测试，原生 type stripping） |
| `npm run typecheck` | TypeScript 类型检查（`tsc --noEmit`） |
| `npm run build` | 生产构建到 `dist/` |
| `npm run preview` | 本地预览构建产物 |
| `npm run smoke` | 冒烟测试：构建 → 启动 preview → 首页 HTTP 200 → index.html 引用的本地 JS/CSS 资源逐一 200 |

## 目录结构

```
src/engine/      纯 TypeScript 引擎（无浏览器依赖；类型 + 坐标几何 + 输入校验）
src/data/        外置 JSON 配置（棋子目录、规则）与版本契约说明
src/main.ts      Vite 页面入口（T1 为占位，UI 在 T3 实现）
tests/           node --test 测试与夹具（场景 JSON 单一来源在 tests/fixtures/）
scripts/         冒烟测试等 Node 脚本
```

## 工程约定

- 引擎源码限定可擦除 TS 语法（不使用 enum / namespace / 构造函数参数属性），保证引擎模块可被 Node 直接 import。
- 测试接缝与测试决策见 `docs/specs/playable-core.md` §Testing Decisions；协作约定见 `AGENTS.md`。
