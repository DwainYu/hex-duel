// Smoke Test（规格 §Testing Decisions，node 脚本、无浏览器框架）四步：
// ① vite build 成功；② 启动 vite preview；③ 首页 HTTP 200；
// ④ 解析 index.html 引用的本地 JS/CSS 资源并逐一请求，均返回 200。
// 任一步失败即非零退出。
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// vite 的 exports 不暴露 ./bin/vite.js，从主入口（…/vite/dist/node/index.js）推导 CLI 脚本路径
const viteMain = require.resolve("vite");
const viteBin = path.join(viteMain, "..", "..", "..", "bin", "vite.js");
if (!existsSync(viteBin)) {
  console.error(`✖ 未找到 vite CLI：${viteBin}`);
  process.exit(1);
}
const SERVER_START_TIMEOUT_MS = 30_000;

function fail(step, detail) {
  console.error(`✖ Smoke 第 ${step} 步失败：${detail}`);
  process.exit(1);
}

// ---- ① 构建 ----
console.log("① vite build …");
const build = spawnSync(process.execPath, [viteBin, "build"], { cwd: repoRoot, encoding: "utf-8" });
if (build.status !== 0) {
  console.error(build.stdout || "");
  console.error(build.stderr || "");
  fail("①", "vite build 非零退出");
}
console.log("① vite build 成功");

// ---- ② 启动 vite preview（随机端口）----
console.log("② 启动 vite preview …");
const preview = spawn(process.execPath, [viteBin, "preview", "--port", "0", "--strictPort"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
preview.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
preview.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});
preview.on("error", (error) => fail("②", `preview 进程启动失败：${error.message}`));

function stopPreview() {
  preview.kill();
}

function waitForServerUrl() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      // vite 输出带 ANSI 颜色码（如 http://localhost:\x1b[1m7132\x1b[22m/），先剥离再匹配
      const plainOutput = serverOutput.replace(/\x1b\[[0-9;]*m/g, "");
      const match = plainOutput.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/);
      if (match) {
        clearInterval(timer);
        resolve(match[0]);
        return;
      }
      if (Date.now() - startedAt > SERVER_START_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`等待 preview 启动超时（${SERVER_START_TIMEOUT_MS}ms）。输出：\n${serverOutput}`));
      }
    }, 200);
    preview.on("exit", (code) => {
      clearInterval(timer);
      reject(new Error(`preview 进程提前退出（code=${code}）。输出：\n${serverOutput}`));
    });
  });
}

try {
  const baseUrl = await waitForServerUrl();
  console.log(`② preview 已启动：${baseUrl}`);

  // ---- ③ 首页 HTTP 200 ----
  const homeResponse = await fetch(baseUrl);
  if (homeResponse.status !== 200) {
    fail("③", `首页状态码 ${homeResponse.status}（期望 200）`);
  }
  const homeHtml = await homeResponse.text();
  console.log("③ 首页 HTTP 200");

  // ---- ④ index.html 引用的本地 JS/CSS 资源逐一请求 200 ----
  const refs = [...homeHtml.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const localRefs = [...new Set(refs.filter((ref) => !/^(?:[a-z]+:)?\/\//i.test(ref) && !ref.startsWith("data:")))].filter(
    (ref) => /\.(?:js|mjs|css)(?:$|\?)/i.test(ref),
  );
  if (localRefs.length === 0) {
    fail("④", `未从 index.html 解析到本地 JS/CSS 资源引用（解析到 ${refs.length} 个引用）`);
  }
  for (const ref of localRefs) {
    const assetUrl = new URL(ref, baseUrl).href;
    const assetResponse = await fetch(assetUrl);
    if (assetResponse.status !== 200) {
      fail("④", `资源 ${ref} 状态码 ${assetResponse.status}（期望 200）`);
    }
    console.log(`④ 资源 200：${ref}`);
  }
  console.log(`✔ Smoke 全部通过（共 ${localRefs.length} 个本地 JS/CSS 资源）`);
} finally {
  stopPreview();
}
