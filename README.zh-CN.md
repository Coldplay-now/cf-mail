# cf-mail

[English](README.md) | **简体中文**

给自己域名用的自托管邮箱，**完整跑在 Cloudflare 上**——收信、发信、存储、网页客户端、手机推送。不需要 VPS、不碰 Postfix、不用伺候 IP 信誉。一个 Worker、一个 D1 数据库、一个 R2 桶。

> 本项目在 **[xtxt.top](https://xtxt.top)** 生产环境运行，承担该域名的全部邮件收发。完整实战记录：[把邮箱整个搬进 Cloudflare](https://xtxt.top/articles/self-hosted-email-on-cloudflare-workers)。

![cf-mail inbox](docs/screenshots/inbox.png)

<table><tr>
<td width="33%"><a href="docs/screenshots/detail.png"><img src="docs/screenshots/detail.png" alt="Mail detail"></a></td>
<td width="33%"><a href="docs/screenshots/compose.png"><img src="docs/screenshots/compose.png" alt="Compose"></a></td>
<td width="33%"><a href="docs/screenshots/settings.png"><img src="docs/screenshots/settings.png" alt="Settings"></a></td>
</tr></table>

```
收信   MX → Cloudflare Email Routing（免费）
         └─ catch-all → 本 Worker
              ├─ 未知/停用地址 → SMTP 550 拒收
              ├─ postal-mime 解析 → 附件进 R2，正文/元数据进 D1
              ├─ 黑名单发件人 → 存为垃圾，不转发不通知
              └─ 可选：抄送一份到外部邮箱

发信   网页 / API → Worker 的 send_email 绑定（Email Service，自动签 DKIM）

读信   同一个 Worker 直接服务的网页客户端
         收件箱 / 已发送 / 已归档 / 垃圾 · 搜索 · 会话 ·
         联系人自动聚合 · 黑名单 · 附件

推送   新邮件 → Web Push（浏览器/PWA）与/或 APNs（你自己的 iOS App）
       —— 都是可选项，配了 secret 才启用
```

这套架构的核心价值：**邮件变成你自己数据库里的普通数据。** 会话分组是一条查询，搜索是一条 `LIKE`，黑名单是张表，"团队成员邮箱"是一行记录加一个转发字段。所有在托管邮箱里要"等官方出功能"的事，变成一次小小的 commit。

## 特性

- **邮箱管理就是 CRUD**——加一行记录即开通地址，置为停用即在 SMTP 层 `550` 拒收。群发垃圾死在门口，管地址永远不用碰 Cloudflare 控制台。
- **免费送 plus-addressing**——`you+newsletter@` 自动投递到 `you@`，原始地址保留在记录上，谁泄露了你的邮箱一查便知。
- **内置网页客户端**——文件夹、搜索、会话视图、附件、写信/回复（带规范的 `In-Reply-To`/`References` 线索头）、联系人自动聚合、一键拉黑。深色模式、移动端适配、前端零依赖。
- **双通道推送**——浏览器/PWA 走 Web Push（VAPID）；自己的 iOS 客户端走 APNs，且是 **Worker 直连**——Workers 的出站 `fetch` 能协商 APNs 要求的 HTTP/2，生产环境实证可行，不需要任何中转。
- **诚实的失败语义**——收信过程中 Worker 抛异常时，发件方邮件服务器按 SMTP 规范自动重试。邮件只会延迟，不会丢。
- **脚本友好的 API**——CI 或 AI Agent 一条 `curl` 就能发通知邮件。
- **Agent 邮箱**——`kind='agent'` 的邮箱是给自治 agent 的一个有界、可观测的收件箱：双向默认拒绝、按地址绑定的令牌、`received → delivered → handled` 的 ack 队列、逐封信的 trust 块、带 reason code 的事件日志——通过 `GET/POST /api/agent/<box>/{manifest,inbox,ack,send,events}` 消费。新信投递到每邮箱 webhook（按 [Standard Webhooks](https://www.standardwebhooks.com) 签名），拉取 API 作兜底。见下方 **[Agent mail](#agent-mail--给-ai-agent-设计一个邮箱)** 与 **[协议规范](docs/AGENT_MAIL_PROTOCOL.zh-CN.md)**。（也提供更简单的全局 webhook `AGENT_WEBHOOK_URL`，对每封人类邮件触发。）

## Agent mail —— 给 AI agent 设计一个邮箱

一旦你开始跑 agent，邮件就不再是人对人的媒介，而变成另一种东西：**agent 与外部世界之间一个异步、持久、人人都能投递的缓冲池**。它是这世上唯一一个所有人、所有服务都已经在说的协议——所以一个有地址的 agent，不需要任何对接就能被任何人找到。cf-mail 的设计目标，是让一个 agent 能**安全地**拥有一个邮箱。它建立在三条公理上（完整模型见 **[Agent Mail Protocol](docs/AGENT_MAIL_PROTOCOL.zh-CN.md)**）：

- **邮箱是数据缓冲区，不是命令通道。** 邮件内容是数据，永不是 prompt。**接收**（写入缓冲区）、**读取**（agent 取出来、带着信任元数据）、**行动**（agent 自己的、可被管控的判断）是三个独立步骤——缓冲区绝不自动执行：收到一封信 ≠ 喂给模型，喂给模型 ≠ 照它做。
- **收发双方明确且有界。** 一个专用 agent 只与一组已知、白名单内的对象往来——而且是**双向**、默认拒收。这个边界不是限制，而是让 agent 可信到能无人值守运行的前提。
- **邮件本身永远不是命令。** 消息的任何属性——DKIM 通过、已知发件人、甚至"看起来像拥有者发的"——都不能把它的内容变成指令。信任信号决定**读得多警惕**，绝不决定**听不听**；任何有后果的动作都要一个不在邮件正文里的带外授权。

**为什么重要。** 邮件一次性把**致命三件套**（Simon Willison：接触私有数据、暴露于不可信内容、能对外通信）全塞给 agent——这正是天真的"agent 邮箱"危险的原因（参见 EchoLeak / CVE-2025-32711：一封零点击邮件把微软 Copilot 引导去外泄内部文件）。cf-mail 从两条腿上砍断三件套：可信 `meta` / 不可信内容的分离，把内容关进笼子、让它当不了指令；出站白名单封住爆炸半径，即便 agent 被劫持，"把密钥发给 attacker@evil.com" 也会因为对方不在白名单而失败。背景阅读 —— **致命的三要素**：[中文](https://xtxt.top/articles/lethal-trifecta) · [English](https://xtxt.top/articles/lethal-trifecta-en)。

**今天已交付：** 安全内核已在本仓库实现。`kind='agent'` 的邮箱**双向默认拒绝**——新建的 agent 邮箱在你加白名单（`mail_allow`：精确地址或 `@domain`）之前，既不收也不发。入站在 SMTP 阶段就拦（存储前 `550`）；出站在公共发信路径里、**在 Email Service 绑定触发之前**就拒绝，所以"把密钥发给 attacker@evil.com"根本出不去。agent 每次发信会铸造一个限时**回信凭证**，让对方的回信被放行而不必永久放宽白名单。每封被放行的信都带一个 **trust 块**（§6：`dkimPass`/`spfPass`/`knownContact`/`allowlisted`/`firstContact`/`isReplyToAgent` → `trustLevel`），以 `agent_state`（`received → delivered → handled`）缓冲、不进任何人类文件夹、不触发设备推送，每个关键步骤都写入带 reason code 的**事件日志**。agent 通过**按地址绑定的令牌**（`POST /addresses/:id/agent-token`，只显示一次、哈希存储）消费：

| 端点 | 作用 |
|---|---|
| `GET /api/agent/<box>/manifest` | 自描述工具面 + 白名单（§11.1） |
| `GET /api/agent/<box>/inbox?state=open` | 拉取未处理邮件，`meta`/`untrusted` 形状（§4.1） |
| `POST /api/agent/<box>/ack` | `{id, result: done\|escalated\|rejected}`，`escalated` 会回升给人 |
| `POST /api/agent/<box>/send` | 以本邮箱发信（白名单强制、幂等） |
| `GET /api/agent/<box>/events` | 带 reason code 的追踪日志，可按 `correlationId` 过滤 |

每邮箱 webhook 投递（`addresses.agent_webhook_url`）按 **[Standard Webhooks](https://www.standardwebhooks.com)** 签名（`webhook-id`/`webhook-timestamp`/`webhook-signature`）——它只是"有新信了"的提示，拉取 API 才是始终可用的兜底。owner 声明的**软规则**（`addresses.agent_rules`，一行一条）会在 manifest 里作为**建议**透出——不强制，唯一的硬边界是白名单（§11.2）。纯决策函数（`matchAllow`/`inboundAdmit`/`outboundAllowed`/`deriveTrust`）放在 [`src/agent.ts`](src/agent.ts)，无数据库即可单测。**仍延后**（见 [AGENT_MAIL_PROTOCOL.zh-CN.md](docs/AGENT_MAIL_PROTOCOL.zh-CN.md)）：结构化的升级路由配置、以及 §7 的 `Reply-To` 加号寻址关联（Email Service 发信绑定不暴露 `Reply-To`、也不返回 `Message-ID`，关联只能基于凭证/引用）。该协议也作为第二个实现跑在 [xtxt.top](https://xtxt.top) 上。配置步骤：**[docs/DEPLOY.md → Agent mailboxes](docs/DEPLOY.md#agent-mailboxes)**。

## 快速开始

```bash
git clone https://github.com/Coldplay-now/cf-mail.git && cd cf-mail
npm install
npx wrangler d1 create cf-mail            # 把 database_id 填进 wrangler.jsonc
npx wrangler r2 bucket create cf-mail
npx wrangler d1 execute cf-mail --remote --file=schema.sql
npx wrangler secret put AUTH_TOKEN        # 任意长随机串——这就是网页登录口令
npm run deploy
```

然后到控制台：启用 **Email Routing**（catch-all → *Send to Worker: cf-mail*）、启用 **Email Service**，以及那个所有人都会踩的坑——**再部署一次**，`send_email` 绑定才会真正挂上。打开 Worker 地址，用 token 登录，到 Settings 里建第一个地址。

👉 **完整的分步部署指南——DNS 记录、控制台每一屏、推送配置、验证测试、故障排查——见 [docs/DEPLOY.zh-CN.md](docs/DEPLOY.zh-CN.md)。**

## API

`/api/*` 下所有端点都要带 `Authorization: Bearer <AUTH_TOKEN>`：

| 端点 | 说明 |
|---|---|
| `GET /api/mails?folder=inbox\|sent\|archived\|spam&page=&q=` | 分页列表 + 计数 |
| `GET /api/mails/:id` | 全文 + 会话，自动标已读 |
| `PATCH /api/mails/:id` | `{read?, archived?, spam?}` |
| `DELETE /api/mails/:id` | 删除（连同 R2 附件） |
| `POST /api/send` | JSON `{from, to, cc?, subject, text, inReplyToId?}`, or multipart with `attachments` file parts (≤5 MiB) |
| `GET /api/attachments?key=` | 附件流式下载 |
| `GET/POST /api/addresses`、`PATCH/DELETE /api/addresses/:id` | 邮箱地址 CRUD |
| `GET/POST /api/contacts`、`DELETE /api/contacts/:address` | 联系人 + 黑名单 |
| `GET /api/push/key`、`POST/DELETE /api/push` | 推送订阅 |
| `GET/POST /api/addresses/:id/allow`、`DELETE …/allow/:allowId` | agent 收/发白名单 |
| `POST /api/addresses/:id/agent-token` | 铸造按邮箱绑定的 agent 令牌（只显示一次） |
| `GET/POST /api/agent/<box>/{manifest,inbox,ack,send,events}` | agent 面（按邮箱令牌） |

`/api/agent/*` 用**按邮箱**令牌鉴权（或用全局令牌作管理员覆盖）；其余端点用全局 `AUTH_TOKEN`。完整配置见 **[docs/DEPLOY.md → Agent mailboxes](docs/DEPLOY.md#agent-mailboxes)**。**全局 webhook**（可选，仅人类邮件）：设置 `AGENT_WEBHOOK_URL`（+ `AGENT_WEBHOOK_SECRET`），每封入站人类邮件按 **Standard Webhooks** 签名后 POST 给你；agent 邮箱用各自的每邮箱 webhook。

```bash
curl -X POST https://mail.yourdomain.com/api/send \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"from":"bot","to":"you@gmail.com","subject":"构建失败","text":"..."}'
```

## 安全说明

- 网页客户端由单个 Bearer token 守门；建议给 Worker 挂自定义域名，token 当密码对待，轮换用 `wrangler secret put AUTH_TOKEN`。
- HTML 正文在**沙箱 iframe** 里渲染（禁脚本、非同源）——原样入库、展示时关笼子。远程图片会加载（追踪像素有效），介意的话自行在上游剥离。
- 给域名配 DMARC 策略，并且只通过签 DKIM 的 Email Service 通道发信；`p=reject` 之下混用未签名通道的邮件会被直接丢弃。

## 成本与边界

- **收信：免费**（Email Routing 不限量）。个人邮件量级的 D1/R2 用量可以忽略。
- **发信：Workers Paid（$5/月）**——本文写作时含每月 3,000 封。Email Service 仍在公测：单封收件人 ≤50；**收发均支持附件**（发信单封 ≤5 MiB；收信经 R2 无限制）。
- **没有 IMAP/POP**——第三方邮件客户端接不进来，界面就是这个网页客户端（或你基于 API 自建的 UI）。对一些人是硬伤，对另一些人是特性。
- 设计上单用户。多租户权限体系不在范围内。

## 出处

从 **[xtxt.top](https://xtxt.top)** 的邮件子系统中抽取而来——2026 年 6 月起与一个 Next.js 博客并肩跑在生产环境，同一条管道、同一套 schema，被真实邮件检验过。完整的迁移实战（包括部署指南排查表里的每一个坑的来历）：[把邮箱整个搬进 Cloudflare](https://xtxt.top/articles/self-hosted-email-on-cloudflare-workers)。

## 许可证

MIT
