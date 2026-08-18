/**
 * DSH Plugin: OpenCode Go Quota Monitor
 * Host-side (server) plugin
 *
 * 自定义套餐额度监控。用户自己添加/管理套餐：
 *   - 套餐名、API URL、Token、认证方式、窗口定义（JSON dot-path 取值）
 * 所有套餐数据存储在 ~/.dsh/opencode-go-quota/plans.json
 *
 * GET  /api/opencode-go-quota              → fetch quota (?plan=xxx)
 * POST /api/opencode-go-quota/refresh      → force refresh (?plan=xxx)
 * GET  /api/opencode-go-quota/plans        → list all plans
 * POST /api/opencode-go-quota/plans        → add a plan (body: {name, apiUrl, token, authType, windows})
 * PUT  /api/opencode-go-quota/plans/:id    → update a plan
 * DELETE /api/opencode-go-quota/plans/:id  → delete a plan
 * POST /api/opencode-go-quota/test-plan    → test a plan config (dry-run fetch)
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

export const name = "opencode-go-quota";
export const inject = ["webServer", "tools"];

// ============== PLANS STORAGE ==============
function plansDir() {
  const d = join(resolveDshHome(), "opencode-go-quota");
  try { mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function plansPath() { return join(plansDir(), "plans.json"); }
function activePlanPath() { return join(plansDir(), "active.txt"); }

function readPlans() {
  try { return JSON.parse(readFileSync(plansPath(), "utf8")); } catch { return {}; }
}
function writePlans(plans) {
  try { writeFileSync(plansPath(), JSON.stringify(plans, null, 2), "utf8"); } catch {}
}
function readActive() {
  try { return readFileSync(activePlanPath(), "utf8").trim() || "opencode-go"; } catch { return "opencode-go"; }
}
function writeActive(planId) {
  try { writeFileSync(activePlanPath(), planId, "utf8"); } catch {}
}

// ============== TOKEN RESOLVER ==============
/** Candidate OpenCode auth.json paths (Windows-first, matches opencode upstream). */
function authJsonCandidates() {
  const home = homedir();
  const out = [];
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) out.push(join(xdg, "opencode", "auth.json"));
  out.push(join(home, ".local", "share", "opencode", "auth.json"));
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, "opencode", "auth.json"));
  if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, "opencode", "auth.json"));
  return out;
}

/** Candidate opencode.json / opencode.jsonc config paths. */
function configJsonCandidates() {
  const home = homedir();
  const out = [];
  const cfg = process.env.OPENCODE_CONFIG_DIR?.trim() ?? process.env.XDG_CONFIG_HOME?.trim();
  const base = cfg ? join(cfg, "opencode") : join(home, ".config", "opencode");
  out.push(join(base, "opencode.json"));
  out.push(join(base, "opencode.jsonc"));
  if (process.env.APPDATA) {
    out.push(join(process.env.APPDATA, "opencode", "opencode.json"));
    out.push(join(process.env.APPDATA, "opencode", "opencode.jsonc"));
  }
  return out;
}

/** Extract a usable API key from an auth.json entry (string or {key}). */
function apiKeyFromEntry(entry) {
  if (entry === null || entry === void 0) return null;
  if (typeof entry === "string") return entry.trim() || null;
  if (typeof entry === "object") {
    const k = entry.key ?? entry.apiKey ?? entry.token;
    if (typeof k === "string" && k !== "") return k;
    const tokens = entry.tokens;
    if (tokens && typeof tokens === "object") {
      const t = tokens.accessToken ?? tokens.access_token;
      if (typeof t === "string" && t !== "") return t;
    }
  }
  return null;
}

/** 从传统来源（env/文件/auth.json）查找 token，不依赖 plan 存储的 token 字段。 */
function resolveTokenFor(planId) {
  if (planId === "opencode-go") {
    const env = process.env.OPENCODE_API_KEY?.trim();
    if (env) return { token: env, source: "env:OPENCODE_API_KEY" };
    try {
      const p = join(resolveDshHome(), "opencode-go.token");
      if (existsSync(p)) { const t = readFileSync(p, "utf8").trim(); if (t) return { token: t, source: p }; }
    } catch {}
    for (const p of authJsonCandidates()) {
      try {
        if (!existsSync(p)) continue;
        const auth = JSON.parse(readFileSync(p, "utf8"));
        const entry = auth["opencode-go"] ?? auth["opencode"];
        const key = apiKeyFromEntry(entry);
        if (key) return { token: key, source: p };
      } catch {}
    }
    for (const p of configJsonCandidates()) {
      try {
        if (!existsSync(p)) continue;
        const raw = readFileSync(p, "utf8");
        const json = p.endsWith(".jsonc") ? JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")) : JSON.parse(raw);
        const key = apiKeyFromEntry(json?.provider?.opencode ?? json?.provider?.opencode?.key);
        if (key) return { token: key, source: p };
      } catch {}
    }
  }
  // 通用来源
  const envKey = `QUOTA_TOKEN_${planId.toUpperCase().replace(/-/g, "_")}`;
  const envVal = process.env[envKey]?.trim();
  if (envVal) return { token: envVal, source: `env:${envKey}` };
  try {
    const p = join(resolveDshHome(), "plans", `${planId}.token`);
    if (existsSync(p)) { const t = readFileSync(p, "utf8").trim(); if (t) return { token: t, source: p }; }
  } catch {}
  return null;
}

// 内置默认套餐（用户可删除/修改）
function defaultPlans() {
  return {
    "opencode-go": {
      id: "opencode-go", name: "OpenCode Go",
      apiUrl: "https://opencode.ai/zen/go/v1/usage",
      token: "", authType: "bearer",
      windows: [
        { name: "滚动(5h)", percentPath: "usage.rolling.percent", resetsAtPath: "usage.rolling.resetsAt", invertPercent: true },
        { name: "周",      percentPath: "usage.weekly.percent",   resetsAtPath: "usage.weekly.resetsAt",   invertPercent: true },
        { name: "月",      percentPath: "usage.monthly.percent",  resetsAtPath: "usage.monthly.resetsAt",  invertPercent: true }
      ]
    }
  };
}

function ensurePlans() {
  const p = plansPath();
  if (!existsSync(p)) writePlans(defaultPlans());
  return p;
}

// ============== DOT-PATH RESOLVER ==============
/**
 * 按点路径取值，支持：
 * - 键名本身含点号（如 "glm-5.2"）：贪心拼接后续段再试
 * - 数组索引：如 "balance_infos[0].total_balance"
 * 例如 "model_remaining_percent.glm-5.2" 会尝试 "glm-5" → "glm-5.2"。
 */
function resolvePath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split(".");
  let o = obj;
  const tryKey = (k) => {
    if (!(o && typeof o === "object")) return undefined;
    const idxMatch = /^(.*)\[(\d+)\]$/.exec(k);
    if (idxMatch) {
      const base = idxMatch[1];
      if (!(base in o)) return undefined;
      const arr = o[base];
      const idx = Number(idxMatch[2]);
      return Array.isArray(arr) && idx < arr.length ? arr[idx] : undefined;
    }
    return k in o ? o[k] : undefined;
  };
  for (let i = 0; i < parts.length; i++) {
    let key = parts[i];
    let j = i;
    let val = tryKey(key);
    while (val === undefined && j + 1 < parts.length) {
      j++;
      key = key + "." + parts[j];
      val = tryKey(key);
    }
    if (val === undefined) return undefined;
    o = val;
    i = j;
  }
  return o;
}

// ============== QUOTA FETCHER ==============
async function fetchQuota(planId, forceRefresh, cache) {
  const CACHE_TTL = 5 * 60 * 1000;
  const cacheKey = `quota:${planId}`;
  const cached = cache.get(cacheKey);
  if (!forceRefresh && cached && (Date.now() - cached.timestamp) < CACHE_TTL) return cached.data;

  ensurePlans();
  const plans = readPlans();
  const plan = plans[planId];
  if (!plan) return { plan: planId, status: "api-error", windows: null, lastUpdated: new Date().toISOString(), error: `未找到套餐: ${planId}` };

  // 解析 token：先试 plan 存储的，再试环境变量/文件等传统来源
  let token = "";
  if (plan.token) {
    if (plan.token.startsWith("env:")) {
      token = process.env[plan.token.slice(4)] || "";
    } else {
      token = plan.token;
    }
  }
  if (!token) {
    const resolved = resolveTokenFor(planId);
    if (resolved) token = resolved.token;
  }
  if (!token) return { plan: plan.name, status: "no-token", windows: null, lastUpdated: new Date().toISOString(), error: `未配置"${plan.name}"的 token` };

  let data;
  try {
    const headers = { Accept: "application/json" };
    if (plan.authType === "bearer") headers["Authorization"] = `Bearer ${token}`;
    else if (plan.authType === "header" && plan.authHeaderName) headers[plan.authHeaderName] = token;
    else if (plan.authType === "cookie") headers["Cookie"] = `${plan.authCookieName || "auth"}=${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try { response = await fetch(plan.apiUrl, { method: "GET", headers, signal: controller.signal }); }
    finally { clearTimeout(timer); }

    if (!response.ok) {
      let text = ""; try { text = await response.text(); } catch {}
      return { plan: plan.name, status: "api-error", windows: null, lastUpdated: new Date().toISOString(), error: `${plan.name} API error ${response.status}: ${String(text).slice(0, 200)}` };
    }

    const payload = await response.json();
    const windows = {};
    let ok = true;

    for (const w of (plan.windows || [])) {
      if (w.type === "balance") {
        // 通用余量窗口（cc-switch 风格）：提取 remaining/used/total 数字 + 单位
        // 兼容字符串数字（如 DeepSeek 返回 "0.41"）
        const toNum = (v) => {
          if (typeof v === "number") return v;
          if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
          return undefined;
        };
        const remaining = toNum(resolvePath(payload, w.balancePath));
        if (remaining === undefined) { ok = false; break; }
        const total = toNum(w.totalPath ? resolvePath(payload, w.totalPath) : undefined);
        const used = toNum(w.usedPath ? resolvePath(payload, w.usedPath) : undefined);
        windows[w.name] = {
          kind: "balance",
          remaining,
          total: total !== undefined ? total : undefined,
          used: used !== undefined ? used : undefined,
          unit: w.unit || ""
        };
      } else {
        // 百分比窗口（现有逻辑）
        const rawPercent = resolvePath(payload, w.percentPath);
        if (typeof rawPercent !== "number") { ok = false; break; }
        // resetsAtPath 可选：取不到时返回空字符串，客户端显示 "--"
        const rawResetsAt = w.resetsAtPath ? resolvePath(payload, w.resetsAtPath) : undefined;
        const pct = w.invertPercent ? Math.max(0, Math.min(100, 100 - rawPercent)) : Math.max(0, Math.min(100, rawPercent));
        windows[w.name] = { kind: "percent", percentRemaining: pct, resetsAt: typeof rawResetsAt === "string" ? rawResetsAt : "" };
      }
    }

    if (!ok || Object.keys(windows).length === 0) {
      data = { plan: plan.name, status: "api-error", windows: null, lastUpdated: new Date().toISOString(), error: `${plan.name} API 返回格式异常，请检查窗口路径配置` };
    } else {
      data = { plan: plan.name, status: "active", windows, lastUpdated: new Date().toISOString() };
    }
  } catch (error) {
    data = { plan: plan.name, status: "api-error", windows: null, lastUpdated: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
  }

  cache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

// ============== HTTP HELPERS ==============
function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", c => d += c); req.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("invalid JSON")); } });
  });
}
function parseUrl(req) {
  return new URL(req.url ?? "/", "http://x");
}

// ============== PLUGIN APPLY ==============
export function apply(ctx) {
  const cache = new Map();

  // GET /api/opencode-go-quota?plan=xxx
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota",
    handler: async (req, res) => {
      if (req.method !== "GET") { json(res, 405, {}); return; }
      try {
        const plan = parseUrl(req).searchParams.get("plan") || readActive();
        json(res, 200, { success: true, data: await fetchQuota(plan, false, cache), timestamp: Date.now() });
      } catch (error) { json(res, 500, { success: false, error: String(error) }); }
    }
  }));

  // POST /api/opencode-go-quota/refresh?plan=xxx
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota/refresh",
    handler: async (req, res) => {
      if (req.method !== "POST") { json(res, 405, {}); return; }
      try {
        const plan = parseUrl(req).searchParams.get("plan") || readActive();
        json(res, 200, { success: true, data: await fetchQuota(plan, true, cache), timestamp: Date.now() });
      } catch (error) { json(res, 500, { success: false, error: String(error) }); }
    }
  }));

  // /api/opencode-go-quota/plans — GET 列表 / POST 添加（同一 route，内部按 method 分发）
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota/plans",
    handler: async (req, res) => {
      try {
        if (req.method === "GET") {
          ensurePlans();
          const plans = readPlans();
          const active = readActive();
          const list = Object.entries(plans).map(([id, p]) => ({
            id, name: p.name, apiUrl: p.apiUrl, authType: p.authType,
            windows: (p.windows || []).map(w => ({
              name: w.name, type: w.type || "percent",
              percentPath: w.percentPath, resetsAtPath: w.resetsAtPath, invertPercent: !!w.invertPercent,
              balancePath: w.balancePath, totalPath: w.totalPath, usedPath: w.usedPath, unit: w.unit || ""
            })),
            hasToken: !!resolveTokenFor(id), active: id === active
          }));
          json(res, 200, { success: true, data: { plans: list, active } });
          return;
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          if (!body.name) { json(res, 400, { success: false, error: "name required" }); return; }
          if (!body.apiUrl) { json(res, 400, { success: false, error: "apiUrl required" }); return; }
          ensurePlans();
          const plans = readPlans();
          const id = body.id || `plan-${randomUUID().slice(0, 8)}`;
          plans[id] = {
            id, name: body.name, apiUrl: body.apiUrl,
            token: body.token || "", authType: body.authType || "bearer",
            authHeaderName: body.authHeaderName || "",
            authCookieName: body.authCookieName || "",
            windows: body.windows || [{ name: "用量", type: "percent", percentPath: "percent", resetsAtPath: "resetsAt", invertPercent: false }]
          };
          writePlans(plans);
          json(res, 200, { success: true, data: { id } });
          return;
        }
        json(res, 405, { success: false, error: "method not allowed (GET/POST)" });
      } catch (error) { json(res, 400, { success: false, error: String(error) }); }
    }
  }));

  // /api/opencode-go-quota/plans/:id — PUT 更新 / DELETE 删除（同一 route，内部按 method 分发）
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix", path: "/api/opencode-go-quota/plans/",
    handler: async (req, res) => {
      try {
        const url = parseUrl(req);
        const id = url.pathname.replace("/api/opencode-go-quota/plans/", "");
        if (!id) { json(res, 400, { success: false, error: "id required" }); return; }
        ensurePlans();
        const plans = readPlans();
        if (!plans[id]) { json(res, 404, { success: false, error: `plan ${id} not found` }); return; }
        if (req.method === "PUT") {
          const body = await readBody(req);
          plans[id] = { ...plans[id], ...body, id };
          writePlans(plans);
          json(res, 200, { success: true, data: { id } });
          return;
        }
        if (req.method === "DELETE") {
          delete plans[id];
          writePlans(plans);
          json(res, 200, { success: true, data: { id } });
          return;
        }
        json(res, 405, { success: false, error: "method not allowed (PUT/DELETE)" });
      } catch (error) { json(res, 400, { success: false, error: String(error) }); }
    }
  }));

  // POST /api/opencode-go-quota/test-plan — dry-run test
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota/test-plan",
    handler: async (req, res) => {
      if (req.method !== "POST") { json(res, 405, {}); return; }
      try {
        const body = await readBody(req);
        if (!body.apiUrl) { json(res, 400, { success: false, error: "apiUrl required" }); return; }
        const headers = { Accept: "application/json" };
        if (body.authType === "bearer" && body.token) headers["Authorization"] = `Bearer ${body.token}`;
        else if (body.authType === "header" && body.authHeaderName && body.token) headers[body.authHeaderName] = body.token;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        let response;
        try { response = await fetch(body.apiUrl, { method: "GET", headers, signal: controller.signal }); }
        finally { clearTimeout(timer); }

        let raw = null;
        try { raw = await response.json(); } catch { try { raw = await response.text(); } catch {} }
        json(res, 200, { success: response.ok, data: { status: response.status, raw: raw ? JSON.stringify(raw).slice(0, 3000) : "(empty)" } });
      } catch (error) { json(res, 400, { success: false, error: String(error) }); }
    }
  }));

  // POST /api/opencode-go-quota/set-plan — set active plan
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota/set-plan",
    handler: async (req, res) => {
      if (req.method !== "POST") { json(res, 405, {}); return; }
      try {
        const body = await readBody(req);
        const planId = body?.plan;
        if (!planId) { json(res, 400, { success: false, error: "plan required" }); return; }
        writeActive(planId);
        json(res, 200, { success: true, data: { plan: planId } });
      } catch (error) { json(res, 400, { success: false, error: String(error) }); }
    }
  }));

  // Tool
  const tools = ctx.get("tools");
  if (tools !== void 0) tools.register(defineTool({
    name: "check-opencode-quota",
    description: "Check current plan quota usage",
    parameters: { plan: { type: "string", description: "套餐 id（可选，默认当前选中的套餐）" } },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) { return JSON.stringify({ success: true, data: await fetchQuota(args?.plan || readActive(), false, cache) }); }
  }));

  ctx.logger.info("OpenCode Go Quota Monitor loaded (custom plans)");
}

export default { name, inject, apply };