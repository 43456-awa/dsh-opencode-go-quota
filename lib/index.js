/**
 * DSH Plugin: OpenCode Go Quota Monitor
 * Host-side (server) plugin
 *
 * Multi-plan quota monitor: supports OpenCode Go, OpenAI, Cursor, GitHub Copilot, etc.
 * Each plan has its own API endpoint, auth method, and token sources.
 *
 * GET  /api/opencode-go-quota           → fetch quota (default plan or ?plan=xxx)
 * POST /api/opencode-go-quota/refresh   → force refresh (?plan=xxx)
 * GET  /api/opencode-go-quota/plans     → list available plans
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "opencode-go-quota";
export const inject = ["webServer", "tools"];

// ============== PLAN DEFINITIONS ==============
// Each plan has: id, name, providerPattern (regex for auto-detect), usageURL,
// authType, tokenSources, windows (time windows), configTip (for UI)
const PLANS = {
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    providerPattern: "deepseek|opencode",
    windows: ["rolling", "weekly", "monthly"],
    windowLabels: { rolling: "滚动(5h)", weekly: "周", monthly: "月" },
    usageURL: "https://opencode.ai/zen/go/v1/usage",
    authType: "bearer",
    parseResponse(payload) {
      const usage = payload?.usage;
      if (!usage || typeof usage !== "object") return null;
      const windows = {};
      for (const w of ["rolling", "weekly", "monthly"]) {
        const win = usage[w];
        if (!win || typeof win !== "object" || win.status !== "ok" ||
            typeof win.percent !== "number" || typeof win.resetsAt !== "string") return null;
        windows[w] = {
          percentRemaining: Math.max(0, Math.min(100, 100 - win.percent)),
          resetsAt: win.resetsAt
        };
      }
      return windows;
    },
    tokenSources: ["env:OPENCODE_API_KEY", "dsh-token-file", "opencode-auth", "opencode-config"],
    configTip: "在 opencode.ai → API 密钥 创建 sk- 开头的 Key"
  },
  "openai": {
    id: "openai",
    name: "OpenAI (Plus/Pro)",
    providerPattern: "openai|gpt",
    windows: ["monthly"],
    windowLabels: { monthly: "月额度" },
    usageURL: "https://api.openai.com/v1/dashboard/billing/usage",
    authType: "bearer",
    parseResponse(payload) {
      // OpenAI billing API returns { total_usage: number (cents), ... }
      if (typeof payload?.total_usage !== "number") return null;
      const total = payload.total_usage / 100; // cents → dollars
      const limit = payload.hard_limit_usd || 120; // Plus default $120
      return {
        monthly: {
          percentRemaining: Math.max(0, Math.min(100, 100 - (total / limit * 100))),
          resetsAt: payload.billing_period_end || new Date(Date.now() + 30 * 86400000).toISOString()
        }
      };
    },
    tokenSources: ["env:OPENAI_API_KEY"],
    configTip: "设置环境变量 OPENAI_API_KEY"
  },
  "cursor": {
    id: "cursor",
    name: "Cursor",
    providerPattern: "cursor",
    windows: ["monthly"],
    windowLabels: { monthly: "月额度" },
    usageURL: "https://www.cursor.com/api/usage",
    authType: "bearer",
    parseResponse(payload) {
      if (typeof payload?.remaining !== "number") return null;
      const total = payload.total || 500;
      return {
        monthly: {
          percentRemaining: Math.max(0, Math.min(100, payload.remaining / total * 100)),
          resetsAt: payload.resetsAt || new Date(Date.now() + 30 * 86400000).toISOString()
        }
      };
    },
    tokenSources: ["env:CURSOR_API_KEY"],
    configTip: "设置环境变量 CURSOR_API_KEY"
  },
  "github-copilot": {
    id: "github-copilot",
    name: "GitHub Copilot",
    providerPattern: "copilot",
    windows: ["monthly"],
    windowLabels: { monthly: "月额度" },
    usageURL: "https://api.github.com/copilot/usage",
    authType: "bearer",
    parseResponse(payload) {
      if (typeof payload?.total_seats !== "number") return null;
      const used = payload?.total_active_users || 0;
      return {
        monthly: {
          percentRemaining: Math.max(0, Math.min(100, 100 - (used / payload.total_seats * 100))),
          resetsAt: payload.next_billing_date || new Date(Date.now() + 30 * 86400000).toISOString()
        }
      };
    },
    tokenSources: ["env:GITHUB_TOKEN"],
    configTip: "设置环境变量 GITHUB_TOKEN（需 copilot 权限）"
  }
};

// ============== TOKEN RESOLUTION ==============
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
function configJsonCandidates() {
  const home = homedir();
  const out = [];
  const cfg = process.env.OPENCODE_CONFIG_DIR?.trim() ?? process.env.XDG_CONFIG_HOME?.trim();
  const base = cfg ? join(cfg, "opencode") : join(home, ".config", "opencode");
  out.push(join(base, "opencode.json")); out.push(join(base, "opencode.jsonc"));
  if (process.env.APPDATA) {
    out.push(join(process.env.APPDATA, "opencode", "opencode.json"));
    out.push(join(process.env.APPDATA, "opencode", "opencode.jsonc"));
  }
  return out;
}
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

/** Resolve token for a specific plan. */
function resolveTokenFor(planId) {
  const plan = PLANS[planId];
  if (!plan) return null;
  for (const src of plan.tokenSources) {
    if (src.startsWith("env:")) {
      const v = process.env[src.slice(4)]?.trim();
      if (v) return { token: v, source: src };
    }
    if (src === "dsh-token-file") {
      try {
        const p = join(resolveDshHome(), `${planId}.token`);
        if (existsSync(p)) { const t = readFileSync(p, "utf8").trim(); if (t) return { token: t, source: p }; }
      } catch {}
    }
    if (src === "opencode-auth") {
      for (const p of authJsonCandidates()) {
        try {
          if (!existsSync(p)) continue;
          const auth = JSON.parse(readFileSync(p, "utf8"));
          const entry = auth["opencode-go"] ?? auth["opencode"];
          const key = apiKeyFromEntry(entry);
          if (key) return { token: key, source: p };
        } catch {}
      }
    }
    if (src === "opencode-config") {
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
  }
  return null;
}

// ============== ACTIVE PLAN PERSISTENCE ==============
function activePlanPath() { return join(resolveDshHome(), "opencode-go-quota-active.txt"); }
function readActivePlan() {
  try { if (existsSync(activePlanPath())) return readFileSync(activePlanPath(), "utf8").trim() || "opencode-go"; } catch {}
  return "opencode-go";
}
function writeActivePlan(planId) {
  try { mkdirSync(resolveDshHome(), { recursive: true }); } catch {}
  try { writeFileSync(activePlanPath(), planId, "utf8"); } catch {}
}

// ============== QUOTA FETCHER ==============
function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// ============== PLUGIN APPLY ==============
export function apply(ctx) {
  const cache = new Map();
  const CACHE_TTL = 5 * 60 * 1000;

  /** Fetch quota for a plan (or default/active plan). */
  async function fetchQuota(planId, forceRefresh) {
    const id = planId || "opencode-go";
    const cacheKey = `quota:${id}`;
    const cached = cache.get(cacheKey);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < CACHE_TTL) return cached.data;

    const plan = PLANS[id];
    if (!plan) return { plan: id, status: "api-error", windows: null, lastUpdated: new Date().toISOString(), error: `未知套餐: ${id}` };

    const resolved = resolveTokenFor(id);
    if (!resolved) return { plan: plan.name, status: "no-token", windows: null, lastUpdated: new Date().toISOString(), error: `未配置 ${plan.name} 的 token：${plan.configTip}` };

    let data;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let response;
      try { response = await fetch(plan.usageURL, { method: "GET", headers: { Authorization: `${plan.authType === "bearer" ? "Bearer" : "Bearer"} ${resolved.token}`, Accept: "application/json" }, signal: controller.signal }); }
      finally { clearTimeout(timer); }

      if (!response.ok) {
        let text = ""; try { text = await response.text(); } catch {}
        data = { plan: plan.name, status: "api-error", windows: null, lastUpdated: new Date().toISOString(), error: `${plan.name} API error ${response.status}: ${String(text).slice(0, 200)}` };
      } else {
        const payload = await response.json();
        const windows = plan.parseResponse(payload);
        if (!windows) data = { plan: plan.name, status: "api-error", windows: null, lastUpdated: new Date().toISOString(), error: `${plan.name} API 返回格式异常（token 无效或计划不匹配）` };
        else data = { plan: plan.name, status: "active", windows, lastUpdated: new Date().toISOString() };
      }
    } catch (error) {
      data = { plan: plan.name, status: "api-error", windows: null, lastUpdated: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    }

    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  }

  // GET /api/opencode-go-quota?plan=xxx
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota",
    handler: async (req, res) => {
      if (req.method !== "GET") { json(res, 405, { success: false, error: "method not allowed (GET only)" }); return; }
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const plan = url.searchParams.get("plan") || readActivePlan();
        json(res, 200, { success: true, data: await fetchQuota(plan, false), timestamp: Date.now() });
      } catch (error) { json(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) }); }
    }
  }));

  // POST /api/opencode-go-quota/refresh?plan=xxx
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota/refresh",
    handler: async (req, res) => {
      if (req.method !== "POST") { json(res, 405, { success: false, error: "method not allowed (POST only)" }); return; }
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const plan = url.searchParams.get("plan") || readActivePlan();
        json(res, 200, { success: true, data: await fetchQuota(plan, true), timestamp: Date.now() });
      } catch (error) { json(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) }); }
    }
  }));

  // GET /api/opencode-go-quota/plans — list available plans + active plan
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota/plans",
    handler: async (req, res) => {
      if (req.method !== "GET") { json(res, 405, { success: false, error: "method not allowed (GET only)" }); return; }
      const active = readActivePlan();
      const list = Object.values(PLANS).map(p => ({
        id: p.id, name: p.name, windows: p.windows, windowLabels: p.windowLabels,
        hasToken: !!resolveTokenFor(p.id), configTip: p.configTip, active: p.id === active
      }));
      json(res, 200, { success: true, data: { plans: list, active } });
    }
  }));

  // POST /api/opencode-go-quota/set-plan — set active plan
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: "/api/opencode-go-quota/set-plan",
    handler: async (req, res) => {
      if (req.method !== "POST") { json(res, 405, { success: false, error: "method not allowed (POST only)" }); return; }
      try {
        const body = await new Promise((resolve, reject) => {
          let d = ""; req.on("data", c => d += c); req.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("invalid JSON")); } });
        });
        const planId = body?.plan;
        if (!planId || !PLANS[planId]) { json(res, 400, { success: false, error: `无效的套餐: ${planId}` }); return; }
        writeActivePlan(planId);
        json(res, 200, { success: true, data: { plan: planId } });
      } catch (error) { json(res, 400, { success: false, error: error instanceof Error ? error.message : String(error) }); }
    }
  }));

  // Tool for quota check
  const tools = ctx.get("tools");
  if (tools !== void 0) tools.register(defineTool({
    name: "check-opencode-quota",
    description: "Check current OpenCode Go plan quota usage",
    parameters: { plan: { type: "string", description: "套餐 id（可选，默认当前选中的套餐）" } },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const planId = args?.plan || readActivePlan();
      return JSON.stringify({ success: true, data: await fetchQuota(planId, false) });
    }
  }));

  ctx.logger.info("OpenCode Go Quota Monitor plugin loaded (multi-plan)");
}

export default { name, inject, apply };