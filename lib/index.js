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
function resolvePath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((o, key) => (o && typeof o === "object" ? o[key] : undefined), obj);
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
      const rawPercent = resolvePath(payload, w.percentPath);
      const rawResetsAt = resolvePath(payload, w.resetsAtPath);
      if (typeof rawPercent !== "number" || typeof rawResetsAt !== "string") { ok = false; break; }
      const pct = w.invertPercent ? Math.max(0, Math.min(100, 100 - rawPercent)) : Math.max(0, Math.min(100, rawPercent));
      windows[w.name] = { percentRemaining: pct, resetsAt: rawResetsAt };
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

  // GET /api/opencode-go-quota/plans — list all plans
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota/plans",
    handler: async (req, res) => {
      if (req.method !== "GET") { json(res, 405, {}); return; }
      ensurePlans();
      const plans = readPlans();
      const active = readActive();
      // 返回时去掉 token 值（客户端只想知道是否已配置）
      const list = Object.entries(plans).map(([id, p]) => ({
        id, name: p.name, apiUrl: p.apiUrl, authType: p.authType,
        windows: (p.windows || []).map(w => ({ name: w.name, percentPath: w.percentPath, resetsAtPath: w.resetsAtPath, invertPercent: !!w.invertPercent })),
        hasToken: !!resolveTokenFor(id), active: id === active
      }));
      json(res, 200, { success: true, data: { plans: list, active } });
    }
  }));

  // POST /api/opencode-go-quota/plans — add a plan
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota/plans",
    handler: async (req, res) => {
      if (req.method !== "POST") { json(res, 405, {}); return; }
      try {
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
          windows: body.windows || [{ name: "用量", percentPath: "percent", resetsAtPath: "resetsAt", invertPercent: false }]
        };
        writePlans(plans);
        json(res, 200, { success: true, data: { id } });
      } catch (error) { json(res, 400, { success: false, error: String(error) }); }
    }
  }));

  // PUT /api/opencode-go-quota/plans/:id — update a plan
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix", path: "/api/opencode-go-quota/plans/",
    handler: async (req, res) => {
      if (req.method !== "PUT") { json(res, 405, {}); return; }
      try {
        const url = parseUrl(req);
        const id = url.pathname.replace("/api/opencode-go-quota/plans/", "");
        if (!id) { json(res, 400, { success: false, error: "id required" }); return; }
        const body = await readBody(req);
        ensurePlans();
        const plans = readPlans();
        if (!plans[id]) { json(res, 404, { success: false, error: `plan ${id} not found` }); return; }
        plans[id] = { ...plans[id], ...body, id };
        writePlans(plans);
        json(res, 200, { success: true, data: { id } });
      } catch (error) { json(res, 400, { success: false, error: String(error) }); }
    }
  }));

  // DELETE /api/opencode-go-quota/plans/:id
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix", path: "/api/opencode-go-quota/plans/",
    handler: async (req, res) => {
      if (req.method !== "DELETE") { json(res, 405, {}); return; }
      try {
        const url = parseUrl(req);
        const id = url.pathname.replace("/api/opencode-go-quota/plans/", "");
        if (!id) { json(res, 400, { success: false, error: "id required" }); return; }
        ensurePlans();
        const plans = readPlans();
        if (!plans[id]) { json(res, 404, { success: false, error: `plan ${id} not found` }); return; }
        delete plans[id];
        writePlans(plans);
        json(res, 200, { success: true, data: { id } });
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