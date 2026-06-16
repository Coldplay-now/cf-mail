# 部署指南

[English](DEPLOY.md) | **简体中文**

本指南带你从一个空的 Cloudflare 账号走到自己域名的邮箱完整可用——和 [xtxt.top](https://xtxt.top) 生产环境的跑法完全一致。首次部署预算约 30 分钟。

## 0. 前置条件

| 条件 | 原因 |
|---|---|
| 域名 DNS 托管在 Cloudflare（zone 已激活） | Email Routing 和 Email Service 都是 zone 级能力 |
| Node.js ≥ 18，且已 `npx wrangler login` | 部署、建 D1/R2、设 secret |
| Workers **Paid**（$5/月）——*仅当需要发信* | 发信走 Email Service，含在 Paid 里；只收信免费版即可 |
| 域名上**没有**还要继续用的其他邮件服务商 MX | 启用 Email Routing 会替换 MX 记录 |

> **从其他服务商迁移？** 先想清楚历史邮件怎么办。Email Routing 只管*未来*的信，旧邮件留在原处。cf-mail 设计上从空库开始。

## 1. 克隆、建资源、跑 schema

```bash
git clone https://github.com/Coldplay-now/cf-mail.git && cd cf-mail
npm install

npx wrangler d1 create cf-mail
# → 把输出的 database_id 填进 wrangler.jsonc（"d1_databases"）

npx wrangler r2 bucket create cf-mail

npx wrangler d1 execute cf-mail --remote --file=schema.sql
```

编辑 `wrangler.jsonc`：

- `vars.MAIL_DOMAIN` → 你的域名，如 `"example.com"`
- `d1_databases[0].database_id` → 上面拿到的 id

## 2. 设管理口令并部署

```bash
# 生成一个足够长的随机串——它就是网页客户端和 API 的密码。
openssl rand -hex 32 | npx wrangler secret put AUTH_TOKEN
npm run deploy
```

部署输出会给出 Worker 地址（`https://cf-mail.<账号>.workers.dev`）。之后可以换更好记的自定义域名（第 6 步）。

## 3. 启用 Email Routing（收信）

控制台 → 你的 zone → **电子邮件 → Email Routing**：

1. 点击**启用 Email Routing**——它会提示添加 MX + SPF 记录，接受即可。（如果警告存在旧服务商的 MX 记录，必须删掉它们——这就是切换时刻。）
2. 进**路由规则** → **Catch-all 地址** → 动作选 **发送到 Worker** → 选 **cf-mail** → 启用 catch-all。
3. 可选（只有用到逐地址 `forward_to` 抄送时才需要）：在**目标地址**里添加并验证要抄送到的外部邮箱。转发到未验证目标会静默失败（有日志，不影响入库）。

**此刻收信已经通了。** 网页里建的地址即刻生效，其余一律 `550 5.1.1 mailbox unavailable` 拒收。

## 4. 启用 Email Service（发信）——注意那个坑

控制台 → 你的 zone → **电子邮件 → 邮件发送**（可能显示为 Email Service / Beta）：

1. 为域名启用，它会自动加所需的 DKIM 记录。
2. **⚠️ 现在立刻重新部署一次 Worker：**

```bash
npm run deploy
```

`send_email` 绑定是在**部署时**挂到服务上的。跳过这步，发信会走旧的未签名通道：邮件进收件人垃圾箱、控制台发送计数永远是 **0**——那个不动的计数就是诊断信号。

3. 检查 SPF（DNS → 记录，zone 根上的 `TXT`）。确保**只有一条** SPF，且包含 Cloudflare 的 include：

```
v=spf1 include:_spf.mx.cloudflare.net ~all
```

旧服务商的 `include:` 如果不再用来发信就删掉。两条独立的 SPF 记录 = 校验失败。

4. 推荐配 DMARC（`_dmarc` 上的 `TXT`）：

```
v=DMARC1; p=quarantine; rua=mailto:you@yourdomain.com
```

确认所有发信都走签 DKIM 的通道后再收紧到 `p=reject`——在 `reject` 之下，任何未签名渠道冒用你的域名都会被直接丢弃。

## 5. 第一个邮箱 + 冒烟测试

1. 打开 Worker 地址 → 用 `AUTH_TOKEN` 登录。
2. **Settings → Addresses** → 添加 `hello`（显示名可选）。`hello@yourdomain.com` 即刻生效。
3. **用一个无关服务商的邮箱**（Gmail、Outlook……）发测试信过来，几秒内应出现在收件箱。
   - *为什么要无关服务商？* 同服务商内部投递经常根本不出公网——"测试通过"但什么都没验证。
4. 在网页里回复。到收件方检查：应落在**收件箱**（不是垃圾箱），且信头里 DKIM 显示 `pass`（`d=yourdomain.com`）。
5. 从外部往你域名下一个不存在的地址发信——应收到引用 `550 5.1.1` 的退信。

## 6. 自定义域名（推荐）

控制台 → **Workers 和 Pages → cf-mail → 设置 → 域和路由 → 添加 → 自定义域**，如 `mail.yourdomain.com`。DNS 和 TLS 自动配好。Bearer token 从此跑在自己的域名之下，地址也好记。

## 7. 可选：Web Push 通知

```bash
npx web-push generate-vapid-keys
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT     # mailto:you@yourdomain.com
npm run deploy
```

然后在网页 **Settings → Enable browser notifications**（iOS Safari 上要先把页面加到主屏幕——那里的推送要求 PWA 上下文）。

## 8. 可选：APNs（你自己的 iOS 客户端）

如果你做原生客户端，Worker 可以**直连**推送——Workers 的出站 `fetch` 能协商 APNs 要求的 HTTP/2（生产环境实证，不需要中转）。

1. 在 Apple 开发者后台建一把**专用 APNs 密钥**（.p8）。App Store Connect 的 API 密钥**不能用**——APNs 会回 `403 InvalidProviderToken`。
2. 设 secrets：

```bash
npx wrangler secret put APNS_TEAM_ID      # 如 AB12CD34EF
npx wrangler secret put APNS_TOPIC       # App 的 bundle id
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_PRIVATE_KEY  # 粘贴 .p8 文件内容
npm run deploy
```

3. App 注册设备 token：

```
POST /api/push   {"endpoint": "apns:<device-token-hex>", "label": "iPhone"}
```

回 `400`/`410` 的失效端点会被自动清理。

## 9. Agent 邮箱

agent 邮箱（`kind='agent'`）是给自治 agent 的一个有界、可观测的收件箱——**双向默认拒绝**、不进人类文件夹、用按邮箱绑定的令牌消费。完整模型见 [AGENT_MAIL_PROTOCOL.zh-CN.md](AGENT_MAIL_PROTOCOL.zh-CN.md)。

**已经在跑旧版本？** 按顺序各应用一次迁移（全新安装从 `schema.sql` 直接带上）：

```bash
npx wrangler d1 execute cf-mail --remote --file=migrations/0001_agent_mailbox.sql
npx wrangler d1 execute cf-mail --remote --file=migrations/0002_agent_rules.sql
```

然后建一个 agent 邮箱（这些管理调用用全局 `AUTH_TOKEN` 授权）：

```bash
BASE=https://mail.yourdomain.com; H="Authorization: Bearer $AUTH_TOKEN"

# 1. 建 agent 邮箱
curl -X POST $BASE/api/addresses -H "$H" -H 'content-type: application/json' \
  -d '{"address":"agent","kind":"agent","agent_purpose":"我的助手",
       "agent_webhook_url":"https://my-agent.example.com/hook"}'   # webhook 可选

# 2. 加白名单——加之前默认全拒（id = addresses.id）
curl -X POST $BASE/api/addresses/<id>/allow -H "$H" -H 'content-type: application/json' \
  -d '{"direction":"in","pattern":"@yourcompany.com"}'
curl -X POST $BASE/api/addresses/<id>/allow -H "$H" -H 'content-type: application/json' \
  -d '{"direction":"out","pattern":"you@yourcompany.com"}'

# 3. 铸按邮箱绑定的 agent 令牌（只打印一次，哈希存储）
curl -X POST $BASE/api/addresses/<id>/agent-token -H "$H"     # → {"token":"cfmail_…"}
```

agent 用**它自己的**令牌（不是全局令牌）：

```bash
AH="Authorization: Bearer cfmail_…"
curl $BASE/api/agent/agent/manifest -H "$AH"            # 自描述工具面
curl "$BASE/api/agent/agent/inbox?state=open" -H "$AH"  # 拉未处理邮件
curl -X POST $BASE/api/agent/agent/ack  -H "$AH" -d '{"id":"…","result":"done"}'
curl -X POST $BASE/api/agent/agent/send -H "$AH" -d '{"to":"you@yourcompany.com","subject":"…","text":"…"}'
curl "$BASE/api/agent/agent/events" -H "$AH"            # 带 reason code 的追踪日志
```

注意：
- 发往非白名单收件人会在邮件离开前被拒（`403`）；agent 发信会铸一个 7 天回信凭证让对方回信被放行。
- `AGENT_WEBHOOK_SECRET`（`wrangler secret`）按 [Standard Webhooks](https://www.standardwebhooks.com) 给每邮箱 webhook 投递签名；不设则不签——生产请设。
- agent 邮件从不推送到你的设备、也不进收件箱/已发文件夹；通过 `events` 观测（`ack {result:"escalated"}` 会把信回升给你并推送）。
- **软规则**（`agent_rules`，可选）：owner 声明的*建议性*指引，在 manifest 透出——用 `PATCH /api/addresses/<id>` `{"agent_rules":"第一条\n第二条"}` 或后台 Agent 面板设置。**不强制**（硬边界是白名单），只塑造表现良好的 agent 怎么做。
- 入站已加固：投递在 SMTP accept 之后跑（`ctx.waitUntil`）、重投按 Message-ID 去重、附件单封上限 10 MiB。

## 10. 日常运维

| 任务 | 做法 |
|---|---|
| 轮换管理口令 | `openssl rand -hex 32 \| npx wrangler secret put AUTH_TOKEN`（各端重新登录） |
| 看日志/报错 | 控制台 → Workers → cf-mail → **Logs**（`wrangler.jsonc` 已开 observability） |
| 备份 | D1 自带 30 天任意时间点恢复（`wrangler d1 time-travel`）；冷备用 `wrangler d1 export cf-mail --remote --output backup.sql` 定期导出 |
| 更新 cf-mail | `git pull && npm install && npm run deploy`（schema 变更会以新 `.sql` 文件发布——先应用再部署） |
| 下线 | 先关 catch-all 规则（邮件开始退回），再删 Worker；D1/R2 里的存档在你删除前一直都在 |
| 给 `/api/*` 限流 | Bearer 令牌是唯一闸门。在 `/api/*` 上加一条 Cloudflare **Rate Limiting** 规则（如单 IP >20 次/10s 拦截），把猜令牌/爬取在边缘挡住 |

> 安全响应头（CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`X-Frame-Options`）由 worker 对每个响应设置；邮件预览 iframe 是 `sandbox` 的（无脚本、无同源）。无需额外配置。

## 11. 故障排查

| 症状 | 原因 | 解法 |
|---|---|---|
| 发的信进垃圾箱，控制台发送计数一直是 0 | Email Service 是在上次部署*之后*开通的——绑定还在旧通道 | 再 `npm run deploy` 一次 |
| `POST /api/send` 返回 501 | 完全没有 `SEND_EMAIL` 绑定 | 启用 Email Service 后重新部署 |
| 测试"通过"但 DNS 其实没配对 | 用了和旧邮箱同服务商的账号测试 | 换无关服务商的邮箱测 |
| 转发抄送收不到 | `forward_to` 目标没在 Email Routing 里验证 | 到目标地址里完成验证 |
| API 调用返回 Cloudflare 1010 | 默认库 User-Agent 被拦 | 带自定义 `User-Agent` 头 |
| 收件方全部 DMARC 失败拒收 | `p=reject` 之下还有第二条未签名发信渠道 | 所有发信统一走 Email Service，或迁移期先放宽到 `p=quarantine` |
| iOS Safari 推送无声无息 | Web Push 需要主屏幕 PWA 上下文 | 加到主屏幕后再订阅 |
| APNs 返回 `403 InvalidProviderToken` | 用了 App Store Connect 的密钥 | 建专用 APNs 密钥 |
| 部署出问题后来信延迟 | Worker 抛错，发件方 MTA 按 SMTP 在重试 | 修好 Worker，排队的邮件下次重试自然到达 |
| agent 邮件被退/收件箱一直空 | 发件人不在该 agent 的入站白名单（默认拒绝） | 加一条 `direction:"in"` 白名单；在 `events` 里查 `rejected/not_allowlisted` |
| agent `send` 返回 403 | 收件人不在出站白名单、也不是被回信对象 | 加一条 `direction:"out"` 白名单 |
| agent 接口返回 401 | 令牌错，或升级后 `no such column: kind`/`agent_rules` | 用 `agent-token` 给的邮箱令牌；应用 `migrations/0001`、`0002` |
