/**
 * DSH Plugin: OpenCode Go Quota Monitor
 * Host-side (server) plugin
 *
 * Fetches the REAL OpenCode Go quota from the official API:
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <accessToken>
 *
 * Token sources (first match wins):
 *   1. env OPENCODE_API_KEY
 *   2. ~/.dsh/opencode-go.token (one line, raw token)
 *   3. OpenCode auth.json (opencode-go / opencode key, api-key or oauth)
 *   4. opencode.json / opencode.jsonc provider key "opencode"
 *
 * Routes registered through the dsh `webServer` service (node:http handler
 * shape), tools registered through `ctx.get("tools").register(defineTool(...))`.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "opencode-go-quota";

export const inject = ["webServer", "tools"];

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const WINDOWS = ["rolling", "weekly", "monthly"];

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

/** Resolve the OpenCode Go bearer token from all configured sources. */
function resolveToken() {
  // 1. env
  const env = process.env.OPENCODE_API_KEY?.trim();
  if (env) return { token: env, source: "env:OPENCODE_API_KEY" };

  // 2. ~/.dsh/opencode-go.token
  try {
    const p = join(resolveDshHome(), "opencode-go.token");
    if (existsSync(p)) {
      const t = readFileSync(p, "utf8").trim();
      if (t) return { token: t, source: p };
    }
  } catch {}

  // 3. auth.json (opencode-go / opencode)
  for (const p of authJsonCandidates()) {
    try {
      if (!existsSync(p)) continue;
      const auth = JSON.parse(readFileSync(p, "utf8"));
      const entry = auth["opencode-go"] ?? auth["opencode"];
      const key = apiKeyFromEntry(entry);
      if (key) return { token: key, source: p };
    } catch {}
  }

  // 4. opencode.json / opencode.jsonc provider key "opencode"
  for (const p of configJsonCandidates()) {
    try {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      const json = p.endsWith(".jsonc")
        ? JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
        : JSON.parse(raw);
      const key = apiKeyFromEntry(json?.provider?.opencode ?? json?.provider?.opencode?.key);
      if (key) return { token: key, source: p };
    } catch {}
  }

  return null;
}

/**
 * Service to fetch OpenCode Go quota data
 */
class OpenCodeGoQuotaService {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new Map();
    this.refreshInterval = 5 * 60 * 1000; // 5 minutes
  }

  async fetchQuota(forceRefresh = false) {
    const cacheKey = "current";
    const cached = this.cache.get(cacheKey);

    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < this.refreshInterval) {
      return cached.data;
    }

    const resolved = resolveToken();
    if (!resolved) {
      const data = {
        plan: "OpenCode Go",
        status: "no-token",
        windows: null,
        lastUpdated: new Date().toISOString(),
        error: "未配置 OpenCode Go token：export OPENCODE_API_KEY 或将 token 写入 ~/.dsh/opencode-go.token"
      };
      this.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    }

    let data;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await fetch(USAGE_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${resolved.token}`,
            Accept: "application/json"
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        let text = "";
        try { text = await response.text(); } catch {}
        data = {
          plan: "OpenCode Go",
          status: "api-error",
          windows: null,
          lastUpdated: new Date().toISOString(),
          error: `OpenCode Go API error ${response.status}: ${String(text).slice(0, 200)}`
        };
      } else {
        const payload = await response.json();
        const usage = payload?.usage;
        const windows = {};
        let ok = usage !== null && typeof usage === "object";
        if (ok) {
          for (const w of WINDOWS) {
            const win = usage[w];
            if (win && typeof win === "object" && win.status === "ok" &&
                typeof win.percent === "number" && typeof win.resetsAt === "string") {
              windows[w] = {
                percentRemaining: Math.max(0, Math.min(100, 100 - win.percent)),
                resetsAt: win.resetsAt
              };
            } else {
              ok = false;
              break;
            }
          }
        }
        if (!ok) {
          data = {
            plan: "OpenCode Go",
            status: "api-error",
            windows: null,
            lastUpdated: new Date().toISOString(),
            error: "OpenCode Go API 返回格式异常（可能是 token 无效或套餐不匹配）"
          };
        } else {
          data = {
            plan: "OpenCode Go",
            status: "active",
            windows,
            lastUpdated: new Date().toISOString()
          };
        }
      }
    } catch (error) {
      data = {
        plan: "OpenCode Go",
        status: "api-error",
        windows: null,
        lastUpdated: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
    }

    this.cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  }
}

/** Write a JSON response (node:http handler helper). */
function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/**
 * Main plugin apply function
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context
 */
export function apply(ctx) {
  const quotaService = new OpenCodeGoQuotaService(ctx);

  // GET /api/opencode-go-quota
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/opencode-go-quota",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        json(res, 405, { success: false, error: "method not allowed (GET only)" });
        return;
      }
      try {
        json(res, 200, { success: true, data: await quotaService.fetchQuota(), timestamp: Date.now() });
      } catch (error) {
        json(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }));

  // POST /api/opencode-go-quota/refresh
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/opencode-go-quota/refresh",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        json(res, 405, { success: false, error: "method not allowed (POST only)" });
        return;
      }
      try {
        json(res, 200, { success: true, data: await quotaService.fetchQuota(true), timestamp: Date.now() });
      } catch (error) {
        json(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }));

  // Register tool for quota check
  const tools = ctx.get("tools");
  if (tools === void 0) return;
  tools.register(defineTool({
    name: "check-opencode-quota",
    description: "Check current OpenCode Go plan quota usage",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const quota = await quotaService.fetchQuota();
      return JSON.stringify({ success: true, data: quota });
    }
  }));

  ctx.logger.info("OpenCode Go Quota Monitor plugin loaded");
}

export default { name, inject, apply };
