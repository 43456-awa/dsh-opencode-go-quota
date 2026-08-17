# dsh-opencode-go-quota

DSH (DeepSeek Harness) Web GUI 插件：实时显示 **OpenCode Go** 套餐额度。

- 🟢 模型名左边的小圆圈，颜色实时反映额度剩余（绿 ≥60% / 黄 30-60% / 红 <30% / 灰 无数据）
- 🔴 点击圆圈弹出详情：滚动(5小时) / 周 / 月 三个窗口的剩余百分比 + 重置时间
- ⏱️ 60 秒自动轮询真实额度，数据来自 OpenCode 官方 API

## 效果

- **平时**：输入栏模型选择器左边一个 12px 小圆圈（颜色 = 额度状态）
- **点击**：弹出详情面板，显示三个时间窗口的剩余量与重置倒计时

## 安装

```bash
# 1. 把插件目录放到 profile 树内（无空格路径），然后：
dsh plugin --profile web add "C:/path/to/dsh-opencode-go-quota"

# 2. 配置 token（任选其一）：
#    a) 环境变量
set OPENCODE_API_KEY=sk-xxx
#    b) 或写入 token 文件（一行）
echo sk-xxx > %USERPROFILE%\.dsh\opencode-go.token
#    c) 或使用 OpenCode CLI 的 auth.json（opencode-go / opencode 键）

# 3. 重启 DSH
```

## 数据来源

真实额度来自 OpenCode 官方接口：

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <token>
```

响应（示例）：

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 4,  "resetsAt": "2026-08-17T21:03:34.387Z" },
    "weekly":  { "status": "ok", "percent": 27, "resetsAt": "2026-08-24T00:00:00.387Z" },
    "monthly": { "status": "ok", "percent": 54, "resetsAt": "2026-09-10T03:17:12.387Z" }
  }
}
```

`percent` 为**已用百分比**，插件换算为剩余量并决定圆圈颜色。

### Token 来源（按优先级）

1. 环境变量 `OPENCODE_API_KEY`
2. `~/.dsh/opencode-go.token`（一行原始 token）
3. OpenCode `auth.json`（`opencode-go` / `opencode` 键，api-key 或 oauth token）
4. `opencode.json` / `opencode.jsonc` 的 provider key `opencode`

> 在 https://opencode.ai → API 密钥 页面创建 `sk-` 开头的 Key 即可。

## 结构

```
├── package.json        # DSH 插件声明（dsh.bundle.patch / dsh.client.platform）
├── cordis.patch.yml    # bundle 层插入声明
└── lib/
    ├── index.js        # 宿主半区：读 token → 调官方 API → /api/opencode-go-quota
    └── client.js       # 浏览器半区：圆圈 + 详情面板（conversation.input.right 插槽）
```

## 开发要点

- 宿主用 `ctx.webServer.register({ kind: "exact", path, handler })` 注册路由
- 客户端用 `window.__ModuleLoader__.load({ id, factory })` + `ctx.slots.inject("conversation.input.right", ...)`
- 客户端改动刷新页面即生效；宿主改动需重启 DSH
- `exports` 必须包含 `./package.json`（DSH 的 resolveMeta 依赖它解析包元数据）

## License

MIT
