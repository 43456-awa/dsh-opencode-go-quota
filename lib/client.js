// dsh-opencode-go-quota — browser half.
//
// 自定义套餐额度监控（模型名左边的小圆圈）：
// - 圆圈颜色 = 额度剩余状态：绿（≥60%）/ 黄（30-60%）/ 红（<30%）/ 灰（无数据）
// - 点击圆圈弹出详情面板
// - 齿轮按钮 → 管理套餐（添加/编辑/删除/测试）
// - 每个套餐可自定义：API URL、Token、认证方式、窗口路径
// - 60s 自动刷新 + 手动刷新；选择持久化

window.__ModuleLoader__.load({
	id: "dsh-opencode-go-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		const { useState, useEffect, useCallback, useRef } = react;
		const h = react.createElement;

		const API_PATH = "/api/opencode-go-quota";
		const REFRESH_INTERVAL_MS = 60 * 1000;
		const LS_PLAN_KEY = "dsh-opencode-go-quota:plan";

		// ---- 工具 ------------------------------------------------
		function fmtClock(d) { const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
		function fmtShort(d) { const p = (n) => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
		function stateColor(rate) {
			if (rate === null) return "var(--dsw-alias-label-tertiary, #6b7280)";
			if (rate >= 0.6) return "var(--dsw-alias-state-success-primary, #10b981)";
			if (rate >= 0.3) return "var(--dsw-alias-state-warning-primary, #f59e0b)";
			return "var(--dsw-alias-state-danger-primary, #ef4444)";
		}
		const btn = { flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, border: 0, borderRadius: 5, padding: 0, background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: 12 };
		const input = { width: "100%", boxSizing: "border-box", padding: "4px 6px", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 5, background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-primary)", fontSize: 11, fontFamily: "inherit", outline: "none" };
		const label = { fontSize: 10, color: "var(--dsw-alias-label-secondary)", marginBottom: 2, display: "block" };

		// ---- 面板容器 --------------------------------------------
		const panelStyle = {
			position: "absolute", right: 0, bottom: "calc(100% + 8px)", zIndex: 60,
			width: 300, boxSizing: "border-box", display: "flex", flexDirection: "column",
			borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)", boxShadow: "0 8px 32px rgba(0, 0, 0, 0.2)",
			color: "var(--dsw-alias-label-primary)", fontSize: 12, lineHeight: "18px", padding: "8px 10px", maxHeight: "65vh"
		};
		const headerStyle = { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid var(--dsw-alias-border-l1)", flex: "none" };

		// ---- 主容器（管理三种视图：quota / plans / editor）---------
		function QuotaDot(props) {
			const [view, setView] = useState("quota"); // quota | plans | editor
			const [editPlan, setEditPlan] = useState(null); // null = add new
			const [quotaData, setQuotaData] = useState(null);
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState(null);
			const [lastRefresh, setLastRefresh] = useState(null);
			const [plans, setPlans] = useState(null);
			const [activePlan, setActivePlan] = useState(() => { try { return localStorage.getItem(LS_PLAN_KEY) || "opencode-go"; } catch { return "opencode-go"; } });
			const activePlanRef = useRef(activePlan);
			useEffect(() => { activePlanRef.current = activePlan; }, [activePlan]);

			// 加载套餐列表
			const loadPlans = useCallback(async () => {
				try {
					const r = await fetch(`${API_PATH}/plans`);
					const j = await r.json();
					if (j.success && j.data) {
						setPlans(j.data.plans);
						if (j.data.active && j.data.active !== activePlanRef.current) {
							setActivePlan(j.data.active);
							try { localStorage.setItem(LS_PLAN_KEY, j.data.active); } catch {}
						}
					}
				} catch {}
			}, []);

			// 加载额度
			const fetchQuota = useCallback(async (planId, force) => {
				try {
					setLoading(true); setError(null);
					const id = planId || activePlanRef.current;
					const r = await fetch(`${API_PATH}${force ? "/refresh" : ""}?plan=${id}`, { method: force ? "POST" : "GET", headers: { "Content-Type": "application/json" } });
					const j = await r.json();
					if (j.success) { setQuotaData(j.data); setLastRefresh(new Date(j.timestamp)); }
					else setError(j.error || "获取额度失败");
				} catch (e) { setError(e.message || "网络错误"); }
				finally { setLoading(false); }
			}, []);

			useEffect(() => { loadPlans(); fetchQuota(activePlan, false); }, [activePlan, loadPlans, fetchQuota]);
			useEffect(() => { const i = setInterval(() => fetchQuota(activePlanRef.current, false), REFRESH_INTERVAL_MS); return () => clearInterval(i); }, [fetchQuota]);

			const selectPlan = (id) => {
				setActivePlan(id);
				try { localStorage.setItem(LS_PLAN_KEY, id); } catch {}
				fetch(`${API_PATH}/set-plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: id }) }).catch(() => {});
				fetchQuota(id, true);
			};

			// 圆圈颜色
			let minRate = null;
			let tip = "加载中…";
			if (quotaData && quotaData.status === "active" && quotaData.windows) {
				const rates = Object.values(quotaData.windows).filter(w => w && typeof w.percentRemaining === "number").map(w => w.percentRemaining / 100);
				if (rates.length > 0) { minRate = Math.min(...rates); tip = `额度：最低剩余 ${Math.round(minRate * 100)}%`; }
			} else if (quotaData?.error) tip = quotaData.error;
			else if (error) tip = error;

			return h("div", { "data-plugin": "dsh-opencode-go-quota", style: { position: "relative", display: "inline-flex", alignItems: "center", flex: "none" } },
				h("button", {
					type: "button", title: tip, "aria-label": "套餐额度", "aria-expanded": view !== "quota",
					onClick: () => setView("quota"),
					style: { width: 12, height: 12, borderRadius: "50%", border: "1px solid color-mix(in srgb, var(--dsw-alias-bg-overlay) 60%, transparent)", background: stateColor(minRate), padding: 0, cursor: "pointer", boxShadow: "0 0 4px color-mix(in srgb, " + stateColor(minRate) + " 60%, transparent)", flex: "none" }
				}),
				view === "quota" ? h(QuotaView, { quotaData, loading, error, lastRefresh, plans, activePlan, onRefresh: () => fetchQuota(activePlanRef.current, true), onSelectPlan: selectPlan, onOpenPlans: () => setView("plans") }) : null,
				view === "plans" ? h(PlansView, { plans, activePlan, onSelectPlan: selectPlan, onAdd: () => { setEditPlan(null); setView("editor"); }, onEdit: (p) => { setEditPlan(p); setView("editor"); }, onBack: () => setView("quota"), onRefresh: loadPlans }) : null,
				view === "editor" ? h(PlanEditor, { plan: editPlan, onSaved: () => { loadPlans(); setView("plans"); }, onCancel: () => setView("plans") }) : null
			);
		}

		// ---- 额度视图 --------------------------------------------
		function QuotaView(props) {
			const { quotaData, loading, error, lastRefresh, plans, activePlan, onRefresh, onSelectPlan, onOpenPlans } = props;

			const Bar = (label, pct, resetTime) => {
				const color = stateColor(pct / 100);
				let rt = "--"; try { const d = new Date(resetTime); if (!Number.isNaN(d.getTime())) rt = fmtShort(d); } catch {}
				return h("div", { style: { marginBottom: 10 } },
					h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 } },
						h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, label),
						h("span", { style: { fontSize: 11, fontWeight: 600, color } }, `剩余 ${Math.round(pct)}%`)),
					h("div", { style: { width: "100%", height: 6, background: "var(--dsw-alias-interactive-bg-hover)", borderRadius: 3 } },
						h("div", { style: { height: 6, borderRadius: 3, background: color, width: `${pct}%`, transition: "width 0.5s ease" } })),
					h("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 2 } },
						h("span", { style: { fontSize: 9, color: "var(--dsw-alias-label-tertiary)" } }, `已用 ${Math.round(100 - pct)}%`),
						h("span", { style: { fontSize: 9, color: "var(--dsw-alias-label-tertiary)" } }, `重置 ${rt}`)));
			};

			const activePlanName = plans ? (plans.find(p => p.id === activePlan)?.name || activePlan) : activePlan;

			return h("div", { style: panelStyle },
				h("div", { style: headerStyle },
					h("span", { style: { fontWeight: 600, fontSize: 12, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (quotaData?.plan || activePlanName) + " 额度"),
					h("span", { style: { fontSize: 9, color: "var(--dsw-alias-label-tertiary)", cursor: "pointer" }, onClick: onOpenPlans }, "▼"),
					h("button", { type: "button", title: "管理套餐", style: btn, onClick: onOpenPlans }, "⚙"),
					h("button", { type: "button", title: "刷新", disabled: loading, style: btn, onClick: onRefresh }, loading ? "⟳" : "↻")),
				loading && !quotaData ? h("div", { style: { padding: "10px 0", textAlign: "center", color: "var(--dsw-alias-label-secondary)" } }, "加载中…") :
				error && !quotaData ? h("div", { style: { padding: "8px 0", textAlign: "center" } },
					h("div", { style: { color: "var(--dsw-alias-state-danger-primary, #ef4444)", marginBottom: 6, fontSize: 11 } }, `⚠ ${error}`),
					h("button", { type: "button", style: { border: 0, borderRadius: 5, padding: "2px 10px", cursor: "pointer", fontSize: 11, background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-primary)" }, onClick: onRefresh }, "重试")) :
				quotaData?.status === "active" && quotaData.windows ? h("div", null, Object.entries(quotaData.windows).map(([k, w]) => Bar(k, w.percentRemaining, w.resetsAt))) :
				quotaData?.error ? h("div", { style: { padding: "8px 0", textAlign: "center" } },
					h("div", { style: { color: "var(--dsw-alias-state-warning-primary, #f59e0b)", marginBottom: 6, fontSize: 11, wordBreak: "break-all" } }, `⚠ ${quotaData.error}`),
					h("button", { type: "button", style: { border: 0, borderRadius: 5, padding: "2px 10px", cursor: "pointer", fontSize: 11, background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-primary)" }, onClick: onRefresh }, "重试")) : null,
				h("div", { style: { display: "flex", justifyContent: "space-between", paddingTop: 6, borderTop: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-tertiary)", fontSize: 9 } },
					h("span", null, lastRefresh ? `更新于 ${fmtClock(lastRefresh)}` : "—"),
					h("span", null, "60s 自动刷新")));
		}

		// ---- 套餐管理视图 ----------------------------------------
		function PlansView(props) {
			const { plans, activePlan, onSelectPlan, onAdd, onEdit, onBack, onRefresh } = props;

			// 删除套餐
			const delPlan = async (id, e) => {
				e.stopPropagation();
				if (!confirm("确定删除此套餐？")) return;
				try {
					await fetch(`${API_PATH}/plans/${id}`, { method: "DELETE" });
					onRefresh();
				} catch {}
			};

			return h("div", { style: { ...panelStyle, overflowY: "auto" } },
				h("div", { style: headerStyle },
					h("span", { style: { fontWeight: 600, fontSize: 12, flex: 1 } }, "套餐管理"),
					h("button", { type: "button", title: "返回", style: btn, onClick: onBack }, "←")),
				plans && plans.length > 0 ? plans.map(p => h("div", {
					key: p.id, style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6, cursor: "pointer", marginBottom: 4, background: p.id === activePlan ? "var(--dsw-alias-interactive-bg-hover)" : "transparent" },
					onClick: () => { onSelectPlan(p.id); onBack(); }
				},
					h("div", { style: { width: 8, height: 8, borderRadius: "50%", flex: "none", background: p.hasToken ? "var(--dsw-alias-state-success-primary, #10b981)" : "var(--dsw-alias-label-tertiary, #6b7280)" } }),
					h("div", { style: { flex: 1, minWidth: 0 } },
						h("div", { style: { fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.name),
						h("div", { style: { fontSize: 9, color: "var(--dsw-alias-label-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.apiUrl)),
					p.id === activePlan ? h("span", { style: { fontSize: 9, color: "var(--dsw-alias-label-tertiary)" } }, "✓") : null,
					h("button", { type: "button", title: "编辑", style: { ...btn, fontSize: 10 }, onMouseDown: (e) => { e.stopPropagation(); e.preventDefault(); onEdit(p); } }, "✎"),
					h("button", { type: "button", title: "删除", style: { ...btn, fontSize: 10, color: "var(--dsw-alias-state-danger-primary, #ef4444)" }, onClick: (e) => delPlan(p.id, e) }, "✕")
				)) : h("div", { style: { padding: "10px 0", textAlign: "center", color: "var(--dsw-alias-label-secondary)", fontSize: 11 } }, "暂无套餐，点击下方添加"),
				h("div", { style: { padding: "6px 0" } },
					h("button", { type: "button", style: { width: "100%", padding: "6px", border: "1px dashed var(--dsw-alias-border-l1)", borderRadius: 6, background: "transparent", color: "var(--dsw-alias-label-primary)", cursor: "pointer", fontSize: 11 }, onClick: onAdd }, "+ 添加套餐")));
		}

		// ---- 套餐编辑视图 ----------------------------------------
		function PlanEditor(props) {
			const { plan, onSaved, onCancel } = props;
			const isNew = !plan;
			const [name, setName] = useState(plan?.name || "");
			const [apiUrl, setApiUrl] = useState(plan?.apiUrl || "");
			const [token, setToken] = useState("");
			const [authType, setAuthType] = useState(plan?.authType || "bearer");
			const [windows, setWindows] = useState(plan?.windows || [{ name: "用量", percentPath: "percent", resetsAtPath: "resetsAt", invertPercent: false }]);
			const [testResult, setTestResult] = useState(null);
			const [testing, setTesting] = useState(false);
			const [saving, setSaving] = useState(false);

			const addWin = () => setWindows([...windows, { name: "", percentPath: "", resetsAtPath: "", invertPercent: false }]);
			const updWin = (i, f, v) => { const w = [...windows]; w[i] = { ...w[i], [f]: v }; setWindows(w); };
			const delWin = (i) => { if (windows.length > 1) setWindows(windows.filter((_, idx) => idx !== i)); };

			// 测试
			const testPlan = async () => {
				setTesting(true); setTestResult(null);
				try {
					const r = await fetch(`${API_PATH}/test-plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiUrl, authType, token, authHeaderName: "", authCookieName: "" }) });
					const j = await r.json();
					setTestResult(j);
				} catch (e) { setTestResult({ success: false, data: { status: 0, raw: e.message } }); }
				finally { setTesting(false); }
			};

			// 保存
			const save = async () => {
				if (!name || !apiUrl) return;
				setSaving(true);
				try {
					const body = { name, apiUrl, token, authType, windows: windows.filter(w => w.name && w.percentPath) };
					const r = await fetch(`${API_PATH}/plans${plan?.id ? `/${plan.id}` : ""}`, { method: plan?.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
					const j = await r.json();
					if (j.success) onSaved();
				} catch {}
				finally { setSaving(false); }
			};

			return h("div", { style: { ...panelStyle, overflowY: "auto" } },
				h("div", { style: headerStyle },
					h("span", { style: { fontWeight: 600, fontSize: 12, flex: 1 } }, isNew ? "添加套餐" : "编辑套餐"),
					h("button", { type: "button", title: "取消", style: btn, onClick: onCancel }, "←")),
				// 基本信息
				h("div", { style: { marginBottom: 8 } }, h("label", { style: label }, "套餐名称"), h("input", { style: input, value: name, onChange: e => setName(e.target.value), placeholder: "如：我的套餐" })),
				h("div", { style: { marginBottom: 8 } }, h("label", { style: label }, "API URL"), h("input", { style: input, value: apiUrl, onChange: e => setApiUrl(e.target.value), placeholder: "https://example.com/api/usage" })),
				h("div", { style: { marginBottom: 8 } }, h("label", { style: label }, "Token"), h("input", { style: { ...input, fontFamily: "monospace" }, value: token, onChange: e => setToken(e.target.value), placeholder: "输入 token 或 env:变量名" })),
				h("div", { style: { marginBottom: 8 } }, h("label", { style: label }, "认证方式"),
					h("select", { style: { ...input, width: "auto" }, value: authType, onChange: e => setAuthType(e.target.value) },
						h("option", { value: "bearer" }, "Bearer Token"),
						h("option", { value: "header" }, "自定义 Header"),
						h("option", { value: "cookie" }, "Cookie"),
						h("option", { value: "none" }, "无认证"))),
				// 窗口定义
				h("div", { style: { marginBottom: 6, fontSize: 10, color: "var(--dsw-alias-label-secondary)" } }, "窗口定义（JSON dot-path 取值）"),
				windows.map((w, i) => h("div", { key: i, style: { marginBottom: 6, padding: "4px 6px", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 5 } },
					h("div", { style: { display: "flex", gap: 4, marginBottom: 3 } },
						h("input", { style: { ...input, flex: 1 }, value: w.name, onChange: e => updWin(i, "name", e.target.value), placeholder: "名称（如：5小时）" }),
						h("button", { type: "button", style: { ...btn, fontSize: 10, color: "var(--dsw-alias-state-danger-primary, #ef4444)" }, onClick: () => delWin(i) }, "✕")),
					h("div", { style: { display: "flex", gap: 4, marginBottom: 3 } },
						h("div", { style: { flex: 1 } }, h("input", { style: { ...input, fontSize: 10 }, value: w.percentPath, onChange: e => updWin(i, "percentPath", e.target.value), placeholder: "百分比路径" })),
						h("div", { style: { flex: 1 } }, h("input", { style: { ...input, fontSize: 10 }, value: w.resetsAtPath, onChange: e => updWin(i, "resetsAtPath", e.target.value), placeholder: "重置时间路径" }))),
					h("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--dsw-alias-label-secondary)", cursor: "pointer" } },
						h("input", { type: "checkbox", checked: !!w.invertPercent, onChange: e => updWin(i, "invertPercent", e.target.checked) }),
						"API 返回的是已用百分比（需反转）"))
				)),
				h("button", { type: "button", style: { padding: "2px 8px", border: "1px dashed var(--dsw-alias-border-l1)", borderRadius: 5, background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: 10, marginBottom: 8 }, onClick: addWin }, "+ 添加窗口"),
				// 测试按钮
				h("div", { style: { display: "flex", gap: 6, marginBottom: 8 } },
					h("button", { type: "button", disabled: testing || !apiUrl, style: { flex: 1, padding: "5px", border: 0, borderRadius: 6, background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-primary)", cursor: "pointer", fontSize: 11 }, onClick: testPlan }, testing ? "测试中…" : "测试 API"),
					h("button", { type: "button", disabled: saving || !name || !apiUrl, style: { flex: 1, padding: "5px", border: 0, borderRadius: 6, background: "var(--dsw-specific-blue-bg, #4f8cff)", color: "white", cursor: "pointer", fontSize: 11 }, onClick: save }, saving ? "保存中…" : "保存")),
				(function() {
					if (!testResult) return null;
					var st = testResult.success ? "✓ 连接成功" : "✗ " + (testResult.data ? testResult.data.status : "失败");
					var rt = testResult.data && testResult.data.raw ? h("pre", { style: { fontSize: 9, margin: "2px 0", whiteSpace: "pre-wrap", color: "var(--dsw-alias-label-secondary)" } }, testResult.data.raw.slice(0, 500)) : null;
					return h("div", { style: { fontSize: 10, padding: "4px 6px", borderRadius: 5, background: "var(--dsw-alias-interactive-bg-hover)", wordBreak: "break-all", maxHeight: 120, overflowY: "auto" } },
						h("div", { style: { color: testResult.success ? "var(--dsw-alias-state-success-primary, #10b981)" : "var(--dsw-alias-state-danger-primary, #ef4444)" } }, st),
						rt);
				})()
		}

		// ---- plugin body -----------------------------------------
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right", id: "dsh-opencode-go-quota", order: -10, label: "额度"
			}, QuotaDot));
		}
		exports.apply = apply; exports.inject = inject;
		return module.exports;
	}
});