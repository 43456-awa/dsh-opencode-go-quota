#!/usr/bin/env node
/**
 * 一键更新 SenseNova Token（从浏览器 localStorage 抓 JWT → 写入 plans.json）
 *
 * 用法：
 *   1. 浏览器（Chrome）登录 https://platform.sensenova.cn/console
 *   2. 确保 CDP 代理已连接（web-access skill 的 check-deps）
 *   3. 运行：node scripts/update-sensenova-token.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROXY = "http://localhost:3456";
const PLANS_PATH = join(homedir(), ".dsh", "opencode-go-quota", "plans.json");

async function main() {
  // 1. 检查 CDP 代理
  let health;
  try {
    const r = await fetch(`${PROXY}/health`);
    health = await r.text();
  } catch {
    console.error("✗ CDP 代理未运行。请先启动（web-access 的 check-deps.mjs --browser chrome）");
    process.exit(1);
  }
  console.log("✓ CDP 代理:", health);

  // 2. 找 SenseNova 页面
  const targets = await (await fetch(`${PROXY}/targets`)).json();
  const page = targets.find((t) => t.type === "page" && t.url.includes("sensenova.cn"));
  if (!page) {
    console.error("✗ 没找到已登录的 SenseNova 页面，请先在浏览器打开 https://platform.sensenova.cn/console 并登录");
    process.exit(1);
  }
  console.log("✓ 找到页面:", page.url.slice(0, 80));

  // 3. 从 localStorage 拿 access_token
  const res = await fetch(`${PROXY}/eval?target=${page.targetId}`, {
    method: "POST",
    body: `localStorage.getItem('access_token')`
  });
  const { value: token } = await res.json();
  if (!token) {
    console.error("✗ localStorage 里没有 access_token（未登录？）");
    process.exit(1);
  }
  console.log(`✓ JWT 已获取（长度 ${token.length}）`);

  // 4. 更新 plans.json 里 sensenova 套餐的 token
  if (!existsSync(PLANS_PATH)) {
    console.error(`✗ 找不到 ${PLANS_PATH}`);
    process.exit(1);
  }
  const plans = JSON.parse(readFileSync(PLANS_PATH, "utf8"));
  if (!plans["sensenova"]) {
    console.error("✗ plans.json 里没有 sensenova 套餐");
    process.exit(1);
  }
  plans["sensenova"].token = token;
  writeFileSync(PLANS_PATH, JSON.stringify(plans, null, 2), "utf8");
  console.log("✓ 已更新 sensenova 套餐 token");
  console.log("  刷新 DSH 页面即可生效（无需重启）");
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
