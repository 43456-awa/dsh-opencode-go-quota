// dsh-opencode-go-quota — browser half.
//
// OpenCode Go 套餐额度实时监控（模型名左边的小圆圈）：
// - 圆圈颜色 = 额度剩余状态：绿（≥60%）/ 黄（30-60%）/ 红（<30%）/ 灰（无数据）
// - 点击圆圈弹出详情面板：滚动(5小时) / 周 / 月 三个窗口的剩余百分比
// - 60s 自动刷新 + 手动刷新；面板开关为组件内状态
// - 样式只用 --dsw-* 主题 token，跟随明暗主题

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
		const REFRESH_INTERVAL_MS = 60 * 1000; // 60s 自动刷新

		// ---- 工具函数 ---------------------------------------------------
		function fmtClock(d) {
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		}
		function fmtShort(d) {
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		}

		/** 按剩余比例取状态色：绿 ≥60%，黄 30-60%，红 <30%。 */
		function stateColor(remainingRate) {
			if (remainingRate === null) return "var(--dsw-alias-label-tertiary, #6b7280)";
			if (remainingRate >= 0.6) return "var(--dsw-alias-state-success-primary, #10b981)";
			if (remainingRate >= 0.3) return "var(--dsw-alias-state-warning-primary, #f59e0b)";
			return "var(--dsw-alias-state-danger-primary, #ef4444)";
		}

		/** 窗口显示名。 */
		const WINDOW_LABELS = {
			rolling: "滚动(5小时)额度",
			weekly: "周额度",
			monthly: "月额度"
		};

		// ---- 弹出详情面板 ----------------------------------------------
		function DetailPanel(props) {
			const { quotaData, loading, error, lastRefresh, onRefresh, onClose } = props;

			const rowStyle = { marginBottom: 10 };
			const labelRow = { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 };
			const labelStyle = { fontSize: 11, color: "var(--dsw-alias-label-secondary)" };
			const valueStyle = { fontSize: 11, fontWeight: 600 };
			const barTrack = { width: "100%", height: 6, background: "var(--dsw-alias-interactive-bg-hover)", borderRadius: 3 };
			const barFill = (color, pct) => ({ height: 6, borderRadius: 3, background: color, width: `${pct}%`, transition: "width 0.5s ease" });
			const subRow = { display: "flex", justifyContent: "space-between", marginTop: 2 };
			const subText = { fontSize: 9, color: "var(--dsw-alias-label-tertiary)" };

			function Bar(key) {
				const win = quotaData.windows[key];
				if (!win) return null;
				const pct = Math.max(0, Math.min(100, win.percentRemaining));
				const color = stateColor(pct / 100);
				let resetText = "--";
				try {
					const d = new Date(win.resetsAt);
					if (!Number.isNaN(d.getTime())) resetText = fmtShort(d);
				} catch {}
				return h("div", { style: rowStyle },
					h("div", { style: labelRow },
						h("span", { style: labelStyle }, WINDOW_LABELS[key] || key),
						h("span", { style: { ...valueStyle, color } }, `剩余 ${Math.round(pct)}%`)
					),
					h("div", { style: barTrack }, h("div", { style: barFill(color, pct) })),
					h("div", { style: subRow },
						h("span", { style: subText }, `已用 ${Math.round(100 - pct)}%`),
						h("span", { style: subText }, `重置 ${resetText}`)
					)
				);
			}

			return h("div", {
				style: {
					position: "absolute",
					right: 0,
					bottom: "calc(100% + 8px)",
					zIndex: 60,
					width: 280,
					boxSizing: "border-box",
					display: "flex",
					flexDirection: "column",
					borderRadius: 10,
					border: "1px solid var(--dsw-alias-border-l2)",
					background: "var(--dsw-alias-bg-overlay)",
					boxShadow: "0 8px 32px rgba(0, 0, 0, 0.2)",
					color: "var(--dsw-alias-label-primary)",
					fontSize: 12,
					lineHeight: "18px",
					padding: "8px 10px"
				}
			},
				h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
					h("span", { style: { fontWeight: 600, fontSize: 12, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
						quotaData && quotaData.plan ? `${quotaData.plan} 额度` : "额度"
					),
					h("button", {
						type: "button",
						style: { flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, border: 0, borderRadius: 5, padding: 0, background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: 12 },
						title: "刷新",
						disabled: loading,
						onClick: onRefresh
					}, loading ? "⟳" : "↻"),
					h("button", {
						type: "button",
						style: { flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, border: 0, borderRadius: 5, padding: 0, background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: 12 },
						title: "关闭",
						onClick: onClose
					}, "✕")
				),
				loading && !quotaData
					? h("div", { style: { padding: "10px 0", textAlign: "center", color: "var(--dsw-alias-label-secondary)" } }, "加载中…")
					: error && !quotaData
						? h("div", { style: { padding: "8px 0", textAlign: "center" } },
							h("div", { style: { color: "var(--dsw-alias-state-danger-primary, #ef4444)", marginBottom: 6, fontSize: 11 } }, `⚠ ${error}`),
							h("button", {
								type: "button",
								style: { border: 0, borderRadius: 5, padding: "2px 10px", cursor: "pointer", fontSize: 11, background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-primary)" },
								onClick: onRefresh
							}, "重试")
						)
						: quotaData && quotaData.status === "active" && quotaData.windows
							? h("div", null, Bar("rolling"), Bar("weekly"), Bar("monthly"))
							: quotaData && quotaData.error
								? h("div", { style: { padding: "8px 0", textAlign: "center" } },
									h("div", { style: { color: "var(--dsw-alias-state-warning-primary, #f59e0b)", marginBottom: 6, fontSize: 11, wordBreak: "break-all" } }, `⚠ ${quotaData.error}`),
									h("button", {
										type: "button",
										style: { border: 0, borderRadius: 5, padding: "2px 10px", cursor: "pointer", fontSize: 11, background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-primary)" },
										onClick: onRefresh
									}, "重试")
								)
								: null,
				h("div", { style: { display: "flex", justifyContent: "space-between", paddingTop: 6, borderTop: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-tertiary)", fontSize: 9 } },
					h("span", null, lastRefresh ? `更新于 ${fmtClock(lastRefresh)}` : "—"),
					h("span", null, "60s 自动刷新")
				)
			);
		}

		// ---- 主组件：模型名左边的小圆圈 ----------------------------------
		function QuotaDot(props) {
			const [open, setOpen] = useState(false);
			const [quotaData, setQuotaData] = useState(null);
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState(null);
			const [lastRefresh, setLastRefresh] = useState(null);

			const fetchQuota = useCallback(async function(forceRefresh) {
				try {
					setLoading(true);
					setError(null);
					const response = await fetch(forceRefresh ? `${API_PATH}/refresh` : API_PATH, {
						method: forceRefresh ? "POST" : "GET",
						headers: { "Content-Type": "application/json" }
					});
					const result = await response.json();
					if (result.success) {
						setQuotaData(result.data);
						setLastRefresh(new Date(result.timestamp));
					} else {
						setError(result.error || "获取额度失败");
					}
				} catch (err) {
					setError(err.message || "网络错误");
				} finally {
					setLoading(false);
				}
			}, []);

			// 初始加载 + 60s 自动刷新
			useEffect(() => {
				fetchQuota(false);
				const interval = setInterval(() => { fetchQuota(false); }, REFRESH_INTERVAL_MS);
				return () => clearInterval(interval);
			}, [fetchQuota]);

			// 最低剩余比例决定颜色（任一窗口紧张就变色）
			let minRate = null;
			let tip = "额度加载中…";
			if (quotaData && quotaData.status === "active" && quotaData.windows) {
				const rates = Object.keys(quotaData.windows)
					.map((k) => quotaData.windows[k])
					.filter((w) => w && typeof w.percentRemaining === "number")
					.map((w) => w.percentRemaining / 100);
				if (rates.length > 0) {
					minRate = Math.min(...rates);
					tip = `OpenCode Go 额度：最低剩余 ${Math.round(minRate * 100)}%（点击查看详情）`;
				}
			} else if (quotaData && quotaData.error) {
				tip = `额度获取失败：${quotaData.error}`;
			} else if (error) {
				tip = `额度获取失败：${error}（点击重试）`;
			}

			const dotColor = stateColor(minRate);

			return h("div", {
				"data-plugin": "dsh-opencode-go-quota",
				style: { position: "relative", display: "inline-flex", alignItems: "center", flex: "none" }
			},
				h("button", {
					type: "button",
					title: tip,
					"aria-label": "OpenCode Go 额度",
					"aria-expanded": open,
					onClick: () => setOpen((v) => !v),
					style: {
						width: 12,
						height: 12,
						borderRadius: "50%",
						border: "1px solid color-mix(in srgb, var(--dsw-alias-bg-overlay) 60%, transparent)",
						background: dotColor,
						padding: 0,
						cursor: "pointer",
						boxShadow: "0 0 4px color-mix(in srgb, " + dotColor + " 60%, transparent)",
						flex: "none"
					}
				}),
				open ? h(DetailPanel, {
					quotaData,
					loading,
					error,
					lastRefresh,
					onRefresh: () => fetchQuota(true),
					onClose: () => setOpen(false)
				}) : null
			);
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-opencode-go-quota",
				order: -10,
				label: "额度"
			}, QuotaDot));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
