# Agent Mail Protocol（AMP）智能体邮件协议

**状态：** v0.1（定稿） · English: [AGENT_MAIL_PROTOCOL.md](AGENT_MAIL_PROTOCOL.md) · **底座：** Cloudflare（Email Routing + Workers + D1 + R2），参考实现见 [cf-mail](../README.md)

> v0.1 敲定五项核心决策（§2.1 有界通信、§3 存储即队列 + ack、§6 信任边界、§7 关联、§10 最小权限令牌）。剩下的开放项（§13）只是实现细节，不再是设计岔路。

AMP 是**邮件系统**与**拥有一个邮箱的自治智能体（agent）**之间的契约。它规定来信如何抵达 agent、agent 如何确认与处理、请求与回信如何关联，以及最重要的——如何把信任边界表达清楚，让 agent 能安全地消费不可信邮件。

它是协议，不是产品。cf-mail 是其中一种实现；任何遵循 AMP 的系统都能托管 agent 邮箱。

## 设计公理

下面的一切都从三条公理推导而来。它们不是功能，而是让 agent 邮件**区别于**人类邮件的第一性原理。若后文某条规则与公理冲突，错的是那条规则。

- **A1 —— 邮箱是数据缓冲区，不是命令通道。邮件内容是数据，永不是 prompt。** agent 邮箱是人（或服务）与 agent 之间一个异步、持久的缓冲区——一个**存放**消息的地方，而不是一根**运行**它的导线。三个动作彼此独立、永不混为一谈：**接收**（系统把消息写进缓冲区——自动）、**读取**（agent 把它取出来、带着信任元数据——由 agent 决定）、**行动**（agent 决定做什么、或什么都不做——永远是一次独立、可被管控的判断）。缓冲区**绝不**自动执行：收到一封信不等于把它喂给模型，把它喂给模型也不等于照它做。→ §3（存储即队列）、§5（状态机）、§6。
- **A2 —— 收发双方明确且有界。** 一个专用 agent 只与一组已知、可枚举、可审计的对象往来——而且是**双向**的。谁能写给它、它能写给谁，都是预定义、默认拒收。这个边界不是限制，而是让 agent 可信到能无人值守运行的前提。→ §2.1（有界通信）、§8（出站）、§10（权限）。
- **A3 —— 邮件本身永远不是命令。** 消息的任何属性——DKIM 通过、已知发件人、甚至「看起来像拥有者发的」——都不能把它的内容变成指令。信任信号决定**读不读、读时多警惕**，绝不决定**听不听**。任何有后果的动作都要求一个不在邮件正文里的带外授权。→ §6（铁律）、§11.2（用户 rules）。

A1 说**邮件是什么**；A2 说**它在谁与谁之间**；A3 说**它永远不能变成什么**。本文余下的部分，都是服务于这三条的机制。

## 0. 为什么需要它

邮件起初是人对人的，对程序而言它退化成了一个单向出口（发通知）。一旦你开始跑 agent，邮件就变成了另一种东西：**agent 与外部世界之间一个异步、持久、人人都能投递的缓冲池**。它是这世上唯一一个所有人、所有服务都已经在说的协议——所以一个有地址的 agent，不需要任何对接就能被任何人找到。

但人能分辨「这封信在跟我说话」和「这封信在命令我」，agent 不能——除非协议把信任边界**摆到结构上**。这是 AMP 的核心职责。其余的，是队列机制。

**非目标：** agent 之间的 RPC、实时/低延迟交换、顺序保证、替代真正的消息总线。AMP 是缓冲池，不是总线。

## 1. 术语

- **human 邮箱** — 人在 UI 里读。状态 = 已读/未读、归档、垃圾、草稿。操作靠手动。
- **agent 邮箱** — agent 通过 webhook + API 消费。状态 = 任务生命周期（见下）。操作是程序化的。
- **投递（Delivery）** — 给 agent 的一个「有新邮件」提示。
- **确认（Ack）** — agent 声明它已消费（处理）某封信。
- **关联（Correlation）** — 把一封回信对回到引发它的那封外发信。
- **升级（Escalation）** — 把一封信从 agent 交给人。
- **信任块（Trust block）** — 系统断言的元数据，供 agent 判断一封信的内容该信多少。

## 2. 两类邮箱

邮箱有一个 `kind`：`human`（默认）或 `agent`。这个类型从头到尾改变行为：

| 维度 | `human` | `agent` |
|---|---|---|
| 谁在读 | 人，在 UI 里 | agent，通过 webhook/API |
| **通信对象** | 谁都能发、谁都能收（过滤垃圾） | **双向有界：发件人和收件人都走白名单，默认拒收** |
| 来信时 | 推人的设备、进人的收件箱 | 触发该邮箱的 webhook；**不**推设备、不混进人的收件箱 |
| 状态模型 | 已读/未读 · 归档 · 垃圾 · 草稿 | `received → delivered → handled / failed`（任务队列视角，不是「读没读」） |
| 操作 | 回复/转发/归档/删除/拉黑（手动） | 配 webhook · ack · 重投 · 升级（程序化） |
| 通知 | 来信 → 通知人 | 来信 → webhook；只有失败/升级时才通知人 |
| 令牌 | 完整 `mail:send` | 绑定到这一个邮箱（仅以本地址发信 + 仅读本邮箱） |

存在网线上的邮件是一样的；是**目标邮箱的类型**决定了接下来发生什么。

### 2.1 有界通信 —— 双向白名单（默认拒收）

*（由 A2 推导：收发双方明确且有界，双向、默认拒收。）*

human 邮箱是个公共地址：谁都能发、谁都能收，事后过滤垃圾。**agent 邮箱恰恰相反，而且是双向的。** 一个专用 agent 存在的意义，是带着已知的、少数几个对象去做一件事——这个边界不是限制，而是要点本身。正是它让一个 agent 可信到能无人值守地运行。所以 agent 邮箱同时约束**谁能写给它**和**它能写给谁**，两者都由邮件系统强制、都默认拒收。

**入站准入。** 一封信被接受，仅当发件人被许可；其余在**入库之前、收信那一刻**就被拒，违规邮件根本进不了队列、到不了 agent。发件人被许可，当且仅当满足其一：

1. **静态白名单** — 在邮箱配置的允许集里：精确地址（`alice@example.com`）或整个域（`@partner.com`）。
2. **动态准入（回信凭证）** — 是 agent 自己发出去那封的有效回信：带着 agent 铸的、仍在有效期的 `correlationId`（即 §7 的 `Reply-To` plus 地址），或其 `In-Reply-To`/`References` 命中已发件。发信这个动作会签发一张**限时、单对象**的凭证，让回信进得来，而不必永久放宽名单。

被拒发件人收到 SMTP `550`（与 cf-mail 对未知地址的现有行为一致）；什么都不存。

**出站管控。** agent 只能发给被许可的收件人——每个 `to`/`cc`/`bcc` 在信**离开之前**、于发送 API 处校验。收件人被许可，当且仅当满足其一：

1. **静态白名单** — 在邮箱配置的外发允许集里（地址或域）。
2. **动态准入（回信凭证）** — 这封是对某封入站邮件的回信（`inReplyToId`），且回给那封信的发件人。agent 永远能回复一个合法找到过它的人，哪怕对方不在静态名单里。

发给任何不被许可的收件人，**整封被 API 拒发**（不会静默剔掉某个收件人）。

**为什么出站管控和入站一样重要。** 入站管控把敌意内容挡在外面；出站管控则在「万一还是失守」时封住爆炸半径：即便一个 agent 的推理被注入内容完全劫持，它也**发不到、联系不上任意地址**——「把密钥发给 attacker@evil.com」会因为该收件人从未被加入白名单而失败。两者合起来是纵深防御：§6 让邮件**变不成**指令；§2.1 保证即便它变成了，agent 也只能触达它预定义的那个世界。

**入站与出站白名单可以不同。** 一个监控类 agent 可能从很多 `service@…` 收信，却只向一个人汇报；这是两个不同的集合。当 agent 只跟单一对象往来时，它们合并成一条。

新建的 agent 邮箱默认**两个方向都 deny-all**。配置失误是失败关闭，绝不敞开。所有这些是**协议级保证**，由邮件系统强制执行（入站在 SMTP 边界、出站在发送 API），绝不交给 agent 自己裁量。

## 3. 核心模型：推送是提示，存储才是队列

*（由 A1 推导：邮箱是缓冲区。接收只是写入存储，不运行任何东西。）*

三层，永远不要混为一谈：

1. **存储（D1）是持久队列，是真相之源。** 每封来信在任何后续动作之前先落库。
2. **webhook 只是投递提示**（「有新东西了」）。它是 best-effort、**至少一次**。
3. **ack 才是消费。** 一封信在 agent ack 之前一直处于打开状态。

实现必须遵守的推论：

- **按 `id` 幂等。** webhook 对同一封信可能触发不止一次（重试、竞态）。agent 必须按 `id` 去重。
- **不保证顺序。** agent 不得假设邮件按发出/收到顺序到达。
- **拉取永远可用。** webhook 丢了也不丢信——agent 能 `GET` 未处理的信补齐。webhook 是对轮询的优化，绝非唯一通路。

## 4. 入站投递（邮件 → agent）

### 4.1 webhook 载荷（schema v1）

载荷把**系统断言的元数据**（`meta`，可信）与**发件人控制的内容**（`untrusted`，不可信）分开。这个分离是刻意做成结构性的——见 §6。

```json
{
  "schemaVersion": 1,
  "event": "mail.received",
  "id": "9f2c…",
  "mailbox": "agent",
  "meta": {
    "from": "alice@example.com",
    "fromName": "Alice",
    "to": "agent@example.com",
    "cc": "",
    "receivedAt": "2026-06-13T15:40:00Z",
    "messageId": "<…@example.com>",
    "inReplyTo": "<…@example.com>",
    "correlationId": "task123",
    "trust": {
      "dkimPass": true,
      "spfPass": true,
      "knownContact": true,
      "firstContact": false,
      "isReplyToAgent": true
    }
  },
  "untrusted": {
    "subject": "Re: deploy approval",
    "body": "go ahead",
    "attachments": [
      { "filename": "log.txt", "mimeType": "text/plain", "size": 1843, "key": "mail/9f2c…/1-log.txt" }
    ]
  }
}
```

`untrusted.body` 是纯文本（HTML 已剥离）；需要全文/附件时 agent 再调 API 取。附件字节从不内联——`key` 经附件接口取。

### 4.2 签名 —— 遵循 Standard Webhooks

webhook 签名遵循 [Standard Webhooks](https://www.standardwebhooks.com/) 规范，而非自创方案，这样现成的验证库（JS/Python/Go/Rust…）即可使用，且天然防重放：

```
webhook-id:        <唯一消息 id>
webhook-timestamp: <unix 秒>
webhook-signature: v1,<base64 HMAC-SHA256( "{id}.{timestamp}.{rawBody}", secret )>
```

接收端必须：(a) 对**原始** body 验 HMAC；(b) 若 `webhook-timestamp` 超出容差窗口（如 ±5 分钟）则拒绝，以防重放；(c) 把 `webhook-id` 当幂等键（§3）。只签 body——cf-mail 现状（`X-CF-Mail-Signature: sha256=…`）——更弱（可重放、无 id）；迁移到 Standard Webhooks 见附录 B。

### 4.3 投递语义

至少一次、无序、按 `id` 幂等。webhook 处理要快、接受即返回 2xx；真正的活儿异步去做。

### 4.4 重试、死信、升级

- 非 2xx 或超时 → 退避重试，至多 `maxAttempts` 次。
- 超过 `maxAttempts`，该信标为 `failed` 并**升级给人**（通知配置好的 human 邮箱/设备），让一个掉线的 agent 永远不会悄悄丢信。
- 重试不阻塞入库，也不阻塞其他信。

### 4.5 拉取 API（补齐 / 兜底）

```
GET /api/agent/<mailbox>/inbox?state=open&since=<cursor>
```

以同样的载荷形状返回未处理（未 ack）的信，带游标供增量轮询。这是 webhook 之下的安全网。

### 4.6 传输层

AMP 在协议层定义的是**事件及其语义**（`mail.received`、载荷、信任分离、幂等）。规范传输是**签名 webhook**（§4.2）+ 作为永远可用兜底的**拉取 API**（§4.5）。这一对就是协议层的全部表面。

至于某个具体 agent 偏好怎么**消费**这个事件——保持一条 WebSocket 长连，或把邮箱暴露成 MCP 工具——属于**应用层绑定，不在 v0.1 范围内**。真有需要时再另行规定；它们会原样复用同一套载荷、ack、幂等和信任规则。协议不依赖它们。

## 5. 确认与状态机

```
received ──webhook──▶ delivered ──ack──▶ handled
   │                     │                  ├─ done（已处理）
   │                     │                  ├─ escalated（转交给人）
   │                     │                  └─ rejected（有意忽略）
   │                     └─ 超时未 ack ──▶ 重投（有上限）─▶ failed
   └─ webhook 失败 maxAttempts 次 ───────────────────────▶ failed ──▶ 升级
```

确认：

```
POST /api/agent/<mailbox>/ack
{ "id": "9f2c…", "result": "done" | "escalated" | "rejected", "note": "…可选…" }
```

- 超时 `T` 仍未 ack 的信会被重投（有次数上限）；这正是 agent 必须幂等的原因。
- agent 的状态与人的「已读/归档」**相互独立**，所以人和 agent 能共享同一份存储的可见性而互不踩踏。（对 `agent` 邮箱本身没有人类读者，但当邮件被升级进 human 邮箱时，这个分离就有意义。）

## 6. 信任与安全（agent 专属的核心）

*（由 A1 与 A3 推导：邮件是被缓冲的数据，且本身永远不是命令。这一节就是把这两条公理落成可强制的结构。）*

**威胁模型：致命三件套（lethal trifecta）。** Simon Willison 在 2025 年 6 月提出：当三样东西同时存在时，agent 就可被攻破——*接触私有数据*、*暴露于不可信内容*、*能对外通信*。邮件一次性把三样都塞给 agent，这正是天真的「agent 邮箱」之所以危险——EchoLeak（CVE-2025-32711）就是一封邮件把微软 Copilot 一步步引导去外泄内部文件，零点击。AMP 的设计**从三条腿中砍掉两条**：§6 把不可信内容关进笼子、让它当不了指令，§2.1 的外发白名单封住对外通信、让被劫持的 agent 无处可发。（文献里的共识防御正是这个——**用 allowlist，不用 blocklist**，并约束外泄通道。）

人读信时会自动施加判断。agent 会把读到的一切当作推理的输入——所以邮件正文按定义就是 **prompt injection 通道**。AMP 把这条边界做成结构性的，而非靠告诫：

1. **`meta` 是系统断言的，可信**（谁/何时、DKIM/SPF 结果、是否已知联系人、关联）。它由邮件系统算出，不受发件人控制。
2. **`untrusted` 是发件人控制的，是数据，永不为指令。** 主题、正文、附件都在这里。名字就是契约。
3. **铁律：邮件内容绝不能触发高权操作。** 任何有后果的事（花钱、删除、代发、改配置）都要求一个带外授权——一个发件人白名单**加上**一个单独验证的信号——而不是邮件正文里的一句话。

**接收 ≠ 读取 ≠ 行动（A1 的分离）。** 这是三个相互独立的步骤，安全的实现必须让它们保持独立：**接收**把消息写进缓冲区（自动，不涉及任何推理）；**读取**是 agent 选择把某封信作为输入取进来，并带上它的 `meta.trust`；**行动**是 agent 决定做什么、或什么都不做，且**永远**是一次可被用户 rules（§11.2）拦截的独立判断。缓冲区绝不自动执行：一封信到达不会去喂模型，一封信被读到也不授权任何动作。下面的信任信号调节的是**读取**，绝不授权**行动**。

实现应在 `meta.trust` 里暴露的信任信号：

- `dkimPass`、`spfPass` — 发件域是否通过认证。
- `knownContact` — 发件人是否为已保存（未拉黑）的联系人。
- `firstContact` — 该地址是否第一次写给这个邮箱。
- `isReplyToAgent` — 是否为对 agent 自己发出的信的回复（高可信，因为线程由 agent 发起）。

随着可信度下降，agent 应**降级处理**：来自已知联系人、DKIM 通过、且是对自己请求的回复，最可信；首次来信、DKIM 失败、未知发件人的，当纯不可信数据看，绝不当指令。

## 7. 关联（请求 / 回信）

为把一封回信对回引发它的请求，AMP 以 **`Reply-To` plus 地址**为主线：

- agent 发信时**可**铸一个关联 id，并设 `Reply-To: <mailbox>+<corrId>@<domain>`。
- 人或服务回信时自然回到那个地址。收信层把 plus 地址折回基础邮箱，解析出 `<corrId>`，作为 `meta.correlationId` 透出。

之所以不用自定义头（人的客户端常把它丢掉），也不用裸 `References` 线索（转发/另起会断）：`Reply-To` 地址**穿透人这一环**，因为它*就是*回信要去的地方。

即使没有 `correlationId`，当 `inReplyTo`/`references` 命中 agent 发过的信时，`meta.isReplyToAgent` 也会被置位。

## 8. 出站（agent → 世界）

```
POST /api/agent/<mailbox>/send
{ "to": "alice@example.com", "subject": "deploy approval",
  "text": "回复 'go ahead' 即批准。", "correlationId": "task123",
  "idempotencyKey": "send-task123-1", "attachments": [...] }
```

- `from` 固定为 agent 自己的邮箱；系统签 DKIM。
- **每个收件人（`to`/`cc`/`bcc`）在信离开前对照外发白名单（§2.1）校验。** 有一个不被许可，整封拒发——这是 agent 有界通信保证的出站那一半。
- `idempotencyKey` 去重重试，让一个不稳的 agent 永不重复发送。
- `correlationId`（可选，默认开）按 §7 设置 `Reply-To` plus 地址。
- 附件（合计 ≤5 MiB）兼作结构化数据通道——agent 可以附一份 JSON 文档来交换数据。

## 9. 人 ↔ agent 交接

两个方向都是一等公民：

- **人 → agent（委派）：** 人把一封信转发到 agent 地址，就是「交给你办」。它作为普通入站到达；转发者的 `meta.knownContact` 为真。
- **agent → 人（升级）：** agent 以 `result: "escalated"` 确认，把这封信连同 agent 的上下文备注重路由进配置好的 human 邮箱并通知人——「你的 agent 需要你」。

## 10. 身份与权限

一个 agent = 一个邮箱 = 一个 webhook + 一把**按地址绑定的令牌**。该令牌只能以自己的地址发信、只能读自己的邮箱——一把泄露的 agent 令牌读不到别的邮箱、不能以别的地址发信、也不能铸新令牌。最小权限是默认，不是选项。

## 11. 把邮箱当工具用

上面的网线协议讲的是邮件怎么传。这一节讲 agent 怎么把邮箱**当成它推理用的工具**——三件协议层不覆盖、却决定邮箱在实战中是否好用、是否安全的事。

### 11.1 自描述的工具表面

把邮箱交给 agent 时，每个操作都**必须**带显式、有效的描述：做什么、何时用、参数，以及——关键——内建的约束是什么。*「send：投递一封信；收件人限于本邮箱白名单；有不被许可的收件人则整次调用失败」* 比 *「发一封邮件」* 是更好的工具描述，因为它在事前**塑造** agent 的行为，而不是事后才让它失败。

邮箱**应当**暴露一份 manifest，让 agent 读懂自己的边界：

```
GET /api/agent/<mailbox>/manifest
{
  "address": "agent@example.com",
  "purpose": "给所有者做部署审批与状态摘要",
  "operations": [ { "name": "send", "description": "…", "constraints": ["收件人走白名单", "附件 ≤5MiB"] }, … ],
  "outboundAllowed": ["owner@example.com"],          // 名单私有时给个脱敏提示
  "scopes": ["mail:send@self", "mail:read@self"],
  "rules": [ … 见 11.2 … ],
  "limits": { "perMessageRecipients": 50, "monthlyQuota": 3000 }
}
```

两条原则，都要，谁也不替代谁：工具**声明约束**（让守规矩的 agent 根本不去尝试会被拒的事），系统**照样强制**（让不守规矩或被劫持的 agent 跨不过去）。

### 11.2 用户 rules（拥有者的策略）

邮箱拥有者声明规则，管 agent 怎么用它。规则分两类，区分很关键：

- **硬规则——系统强制，绝不信任 agent。** 收件人白名单（§2.1）、scope（§10）、额度。在边界处校验；agent 根本无法违反。
- **软规则——声明的策略，期望 agent 遵循。** 如「转发前先摘要」「回陌生人之前先问我」「服务回执自动处理、人来信一律升级」、语气、静默时段。属行为层；通过 manifest / agent 的上下文透出，塑造它的判断。

两者写在一处——拥有者编辑的「每邮箱策略」——manifest 把它们透给 agent。安全相关的那部分**同时**编译进硬强制。一条软规则若被证明事关安全，应逐步提升为硬规则。

### 11.3 agent 友好的可观测性

人的邮件可观测回答「我读了没」。agent 的可观测必须回答「agent（和系统）**做了什么、为什么**」——给 agent 自己、给盯着的人、给监管它的另一个 agent。它必须**结构化、高效**，不是拿来肉眼看的 UI。

邮箱暴露一条只追加的**事件日志**，可按游标 / 过滤 / 关联查询：

```
GET /api/agent/<mailbox>/events?since=<cursor>&correlationId=<id>
```

每个有后果的时刻都是一条带 **reason code** 的结构化事件：

- `received` · `rejected{reason: not_allowlisted | blocked | mailbox_inactive}`
- `delivered` · `delivery_failed{attempt, reason}`
- `handled{result: done | escalated | rejected}`
- `sent` · `send_refused{reason: recipient_not_allowed | over_quota | bad_request}`
- `escalated{to}`

两个性质让它对 agent 友好。**reason code 闭环**：当硬规则挡掉一件事（拒发、拒收），agent 和用户拿到的是机器可读的「为什么」，而非沉默。**关联标签**：一次查询就能拉出整个任务的邮件活动。效率是一等要求：紧凑 JSON、游标、服务端过滤，让监管回路能廉价地轮询这条轨迹。同一批事件渲染出来，就是人看的「我的 agent 在干嘛」。

## 12. 版本

每个载荷带 `schemaVersion`。同一大版本内**只做加法**演进；消费方忽略未知字段。邮件系统和 agent 各自独立迭代，所以网线格式必须能容忍双向的版本错位。

## 13. 开放问题（v0.1）

1. **未 ack 超时的重投** — 有上限的自动重投（要求 agent 幂等，AMP 本就强制）vs 仅靠拉取恢复。倾向自动重投。
2. **信任粒度** — 暴露四个布尔让 agent 自己组合 vs 再预计算一个 `trustLevel: trusted|known|unknown`。倾向「两者都给：布尔 + 一个派生的便捷等级」。
3. **升级路由** — 每个 agent 一个固定的 human 邮箱 vs 一套策略（不同任务类型走不同升级目标）。
4. **拒收方式**（§2.1）— SMTP `550` 退信（信息明确，但暴露地址存在）vs 静默丢弃（更隐蔽，但合法却未列名的发件人得不到信号）。倾向 `550`（与 cf-mail 现状一致），按邮箱可选静默丢弃。
5. **动态回信凭证的有效期与范围**（§2.1）— 一封外发把回信门开多久、一封外发只准被发对象回信还是同线程任何人都能回。倾向短有效期（天级）+ 单对象。

**v0.1 已敲定**（确认）：§7 Reply-To plus 关联；§6 `meta`/`untrusted` 信任分离 + 「内容是数据、永不为指令」铁律；§3 推送提示 + 持久存储队列 + ack + agent 端幂等；§10 按地址最小权限令牌；**§2.1 agent 邮箱双向有界、默认拒收——发件人与收件人都走白名单**。

## 附录 A — 典型流程

**通知（发完即走）：** agent `send` → 完。不需要关联。

**审批闭环（人在环上）：** agent 带 `correlationId` 和 `Reply-To: bot+task@` 发信 → 人回「go ahead」→ 入站 webhook 带 `meta.correlationId=task`、`meta.isReplyToAgent=true` → agent 匹配、执行、ack `done`。

**入站服务事件：** 某服务把回执/告警发到 agent 地址 → webhook 带 `meta.knownContact`（若该服务已保存）→ agent 把 `untrusted.body` 当数据解析、绝不当命令 → ack `done`。

## 附录 B — cf-mail 实现现状

| AMP 特性 | cf-mail 现状 |
|---|---|
| 持久存储即队列（D1） | ✅ |
| `meta`/`untrusted` 分离、每封信持久化完整 `trust` 块（§6） | ✅ |
| 每邮箱 `kind: human \| agent` | ✅ |
| 有界通信——入站**与**出站白名单 + 动态回信凭证、默认拒收 | ✅（入站 SMTP `550` 拦截；出站在发送绑定触发前拒绝） |
| 每邮箱 webhook + 按地址绑定令牌 | ✅（`addresses.agent_webhook_url`；`agent-token` 只显示一次、哈希存储） |
| webhook 签名 | ✅ Standard Webhooks（`webhook-id`/`webhook-timestamp`/`webhook-signature`），每邮箱 hook 与遗留全局 hook 都签 |
| ack + 状态机（`received → delivered → handled/failed`） | ✅ |
| 拉取 API（`/api/agent/<box>/inbox?state=open`） | ✅ |
| 自描述 manifest（§11.1） | ✅（`/api/agent/<box>/manifest`） |
| 升级（`agent → 人`） | ✅（`ack {result:"escalated"}` → 回升成人收件箱一行 + 设备推送；结构化路由配置待做） |
| agent 可观测——事件日志 + reason code（§11.3） | ✅（`mail_event` + `/api/agent/<box>/events`） |
| 用户 rules——硬（强制）+ 软（声明）（§11.2） | ✅ 硬 = 白名单/scope；软 = owner 声明的建议性规则（`addresses.agent_rules`）在 manifest 透出 |
| cron 重投 + 死信清扫（§4.4） | ✅ `scheduled()` 每 5 分钟——重投未送达、到上限死信→升级、过期凭证清理、事件日志 GC |
| 入站加固 | ✅ 投递非阻塞（`ctx.waitUntil`）、Message-ID 去重、单封 10 MiB 附件上限 |
| 经 `Reply-To` plus 地址做关联（§7） | ⚠️ 收信折叠 plus corrId；回信靠凭证 + References 放行。受阻：发送绑定不暴露 `Reply-To` / `Message-ID` |

整套 AMP 核心都已在本仓库落地；唯一还挂 ⚠️ 的 `Reply-To` 关联是平台限制、不是设计缺口。纯决策函数在 [`src/agent.ts`](../src/agent.ts)，有单测（[`test/agent.test.ts`](../test/agent.test.ts)）。

**第二个实现。** [xtblog](https://xtxt.top)（作者的站点，同样跑在 Cloudflare 上，但用 Drizzle/D1）已于 2026-06 落地几乎整套协议。v0.1 核心：`kind:agent` 邮箱、双向有界通信 + 动态回信凭证（默认拒收，入站在 SMTP 边界、出站在发送 API 强制）、每邮箱按地址绑定的令牌、每封信持久化的完整信任块、`received→delivered→handled/failed` ack 状态机、拉取 API，以及带 reason code 的只追加事件日志。随后 v0.2 补上了工具层与加固：自描述 manifest（§11.1）、硬+软用户 rules（§11.2）、升级路由进人邮箱（§9）、`trustLevel`（§13.2）、每邮箱拒收方式（§13.4）、cron 驱动的重投 + 死信清扫（§4.4）、Standard Webhooks 签名（§4.2）。**唯一做不了的**是 §7 的 `Reply-To` plus 地址：Cloudflare Email Service 发送绑定既不暴露 `Reply-To`、也不回传 `Message-ID`，所以关联只能停在 References/grant 方案，直到能发 raw MIME。两个独立实现收敛到同一套网线契约——这正是把它写成协议的意义。

## 附录 C — 先行者与影响

AMP 不是凭空造的。我们看了什么、取了什么：

- **[AgentMail](https://www.agentmail.to/)**（YC S25）— 最接近的先行者：API 优先的 agent 信箱、webhook **加** websocket、threading/labels/search/drafts、MCP server、自动 DKIM/SPF/DMARC、webhook 签名。它证明了这个品类成立。它的 WebSocket/MCP 传输被我们记为未来的应用层绑定（§4.6），刻意排除在 v0.1 之外。我们在两点上分道：AgentMail 是托管 SaaS，AMP/cf-mail **自托管在你自己的 Cloudflare 上**（数据主权）；AgentMail 用 *suppression list*（黑名单），而 AMP 把**双向有界通信 / 默认拒收**做成 agent 邮箱的定义性属性（§2.1）——对专用 agent 是更硬的姿态。
- **致命三件套**（Simon Willison, 2025）+ **OWASP LLM Top 10**（prompt injection 排第一）+ **EchoLeak / CVE-2025-32711** — §6 与 §2.1 要对付的威胁模型；「用 allowlist 不用 blocklist」直接取自这批工作。
- **[Standard Webhooks](https://www.standardwebhooks.com/)** — webhook 签名整套照搬（§4.2）：id + 时间戳 + body 的 HMAC、防重放、现成验证库。
- **Google A2A**（agent 对 agent）— 相邻而不重叠：A2A 是 agent 之间怎么对话，AMP 是 agent 经邮件怎么跟*外部世界*对话。互补。
- **LangChain Agent Inbox** — 一种人审 agent 动作的 human-in-the-loop UX；启发了 AMP 的人↔agent 交接/升级（§9），不过 AMP 的「收件箱」是真邮件，不是动作队列。
