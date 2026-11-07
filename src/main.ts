// T1 占位入口：仅保证 Vite 工程可构建、可预览、可冒烟验证。
// 页面 UI（棋盘编辑器等）按规格在 T3（MVP-1）实现，本文件不得提前加入界面内容。
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (app) {
  app.textContent = "HEX DUEL";
}
