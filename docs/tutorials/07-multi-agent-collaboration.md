# 07. 多 Agent 协作：从独奏到交响

> 从零到一实现一个 AI Agent 框架 · 第七篇

---

## 1. 独奏的边界

一个 Agent 能做的事有天花板。

假设你要做一个**实时金融监控系统**：

```
工作流：
  1. 监控 5 个市场的实时价格（隔几秒检查一次）
  2. 发现异动时分析社交媒体情绪
  3. 情绪异常时生成警报报告
  4. 如果确认是重大事件，通知相关人员

单 Agent 的问题：
  - 监控需要持续轮询 → 阻塞其他工作
  - 分析情绪需要调 NLP 模型 → 很慢
  - 生成报告 + 监控同时做 → 上下文混淆
  - 一个 Agent 的思维链里塞了太多角色
```

不是不能做，是**做不好**。

就像一个人又要盯盘、又要写分析、又要接电话——三头六臂也忙不过来。

**多 Agent 协作**就是让不同的 Agent 各司其职，通过通信协议协同工作。

---

## 2. 从零开始：Agent 之间怎么通信？

两个 Agent 要通信，最少需要什么？

### 2.1 最小通信模型

```
Agent A                        Agent B
  │                               │
  │── 1. 发消息 "帮我查 MSFT" ──► │
  │                               │── 2. 查数据
  │◄── 3. 回复 "价格是 $420" ──── │
  │                               │
```

需要三个东西：

1. **身份**：Agent A 怎么知道 Agent B 存在？
2. **消息**：消息长什么样？发到哪里？
3. **收件箱**：Agent B 怎么知道有人找它？

### 2.2 身份：Partner

每个 Agent 注册为一个 **Partner**：

```json
{
  "id": "partner_abc123",
  "name": "data-agent",
  "description": "专业数据采集",
  "capabilities": ["web-scraping", "api-call"]
}
```

`partner_list` 可以查看所有可用的 Partner。

### 2.3 消息

```
Agent A 发：
  to: partner_abc123
  from: partner_def456
  message: "帮我查 MSFT 当前股价"

Agent B 收：
  from: partner_def456
  message: "帮我查 MSFT 当前股价"
  timestamp: 2025-01-15T10:30:00Z
```

### 2.4 收件箱

每条消息放在接收方的收件箱里。Agent B 下次 `partner_read_inbox()` 就能看到。

就这么简单？对。

---

## 3. 工具集

Axon 通过六个工具暴露多 Agent 能力（默认隐藏，需要 `tool_search` 激活）。

### 3.1 partner_create

注册自己为一个 Partner。

```typescript
async function handlePartnerCreate({ name, description, capabilities }) {
  const id = generatePartnerId();
  const partner = { id, name, description, capabilities };

  saveToRegistry(partner);
  return `Partner 创建成功。你的 ID: ${id}`;
}
```

每个 Partner 有一个唯一 ID（"钱包地址"），其他 Agent 通过这个 ID 找到你。

### 3.2 partner_list

看谁在线。

```typescript
async function handlePartnerList() {
  const partners = loadAllPartners();
  return partners.map(p =>
    `- ${p.name} (${p.id}): ${p.description}`
  ).join('\n');
}
```

输出：

```
- data-agent (partner_abc): 数据采集
- sentiment-agent (partner_def): 情绪分析
- report-agent (partner_ghi): 报告生成
```

### 3.3 partner_send

给特定的 Partner 发消息。

```typescript
async function handlePartnerSend({ partnerId, message }) {
  // 验证对方存在
  if (!registry.has(partnerId)) {
    return `错误：Partner ${partnerId} 不存在`;
  }

  // 放入对方收件箱
  const inboxEntry = {
    from: myId,
    message,
    timestamp: new Date().toISOString()
  };
  appendToInbox(partnerId, inboxEntry);

  return `消息已发送给 ${partnerId}`;
}
```

### 3.4 partner_read_inbox

读自己的收件箱。

```typescript
async function handlePartnerReadInbox() {
  const inbox = loadInbox(myId);
  return inbox.map(entry =>
    `[${entry.timestamp}] 来自 ${entry.from}: ${entry.message}`
  ).join('\n');
}
```

### 3.5 partner_broadcast

群发——给所有 Partner 发消息。

```typescript
async function handlePartnerBroadcast({ message }) {
  const partners = loadAllPartners().filter(p => p.id !== myId);
  for (const partner of partners) {
    appendToInbox(partner.id, { from: myId, message });
  }
  return `已广播给 ${partners.length} 个 Partner`;
}
```

适合"谁有空谁接"的任务发布模式。

### 3.6 partner_remove

解除协作关系。

---

## 4. 三种协作模式

### 4.1 点对点（1:1）

最简单的模式。A 直接找 B。

```
A 发现需要数据
→ partner_list() → 看到 data-agent
→ partner_send("data-agent", "查 META 财报数据")
→ data-agent 收到，查询，回复
→ A 收到数据，继续工作
```

适合：明确知道谁能干这个活。

### 4.2 广播模式（1:N）

A 不知道谁能干，或者谁都能干。

```
A 有一个任务
→ partner_broadcast("我需要一个 Python 脚本抓取网页")
→
  Agent B: "我可以，我会 requests + BeautifulSoup"
  Agent C: "我也可以，我擅长异步抓取"
  Agent D: 没回应（在忙别的）
→
A 评估 B 和 C 的能力，选中 B
→ partner_send("B", "好，你来写")
```

适合：任务分配、竞标模式。

### 4.3 流水线模式（A → B → C）

链式协作，每个 Agent 完成自己那部分后传给下一个。

```
Agent A (数据采集):
  拉取 5 家公司财报 → 传给 B

Agent B (分析):
  收到 A 的数据 → 做财务分析 → 传给 C

Agent C (报告生成):
  收到 B 的分析 → 生成最终报告

数据传输：
  A ──partner_send("B", result)──► B
  B ──partner_send("C", result)──► C
```

适合：数据管道、多阶段处理。

### 三种模式的对比

```
模式       │ 复杂度 │ 谁做决策       │ 典型场景
──────────┼────────┼───────────────┼──────────────
点对点     │ 低     │ 发送方决定     │ 明确分工
广播       │ 中     │ 接收方自荐     │ 任务发布
流水线     │ 高     │ 事先约定好     │ 数据处理管道
```

---

## 5. Spawn：动态创建子 Agent

除了"找现成的"，Axon 还能 **spawn**（动态创建）子 Agent。

```typescript
async function handlePartnerSpawn({ name, capabilities, task }) {
  // 创建一个临时的 Agent 实例
  const childAgent = spawnAgent({
    name,
    capabilities,
    task: `你的任务是：${task}`,
  });

  // 等它完成
  const result = await childAgent.waitForCompletion();

  // 子 Agent 销毁
  return result;
}
```

### 什么时候用 Spawn？

```
你现在正在写代码分析报告：
  → 突然需要查一下某个 API 的用法
  → spawn 一个 "research-agent"
  → 它去查文档，你继续写报告
  → 研究完了，结果传回来，子 Agent 销毁
```

Spawn 和 Partner 的区别：

```
Spawn（临时工）:
  生命周期 = 一个任务
  用完即焚
  不需要注册

Partner（同事）:
  生命周期 = 长期
  持续可用
  需要注册
```

---

## 6. MCP：底层的通信协议

Axon 的多 Agent 通信基于 **MCP（Model Context Protocol）**。

### MCP 的核心

MCP 定义了三个东西：

```typescript
// 1. 消息格式
interface MCPMessage {
  from: string;
  to: string;
  type: 'request' | 'response' | 'broadcast';
  payload: string;
  timestamp: string;
}

// 2. 传输层
// 通过文件系统（本地）或 HTTP（远程）

// 3. 发现机制
// partner_list 相当于服务发现
```

### 本地 vs 远程

```
本地模式（同一台机器）:
  收件箱 = 文件系统
  .axon/mcp/inbox/{partnerId}/messages.json

远程模式（多台机器）:
  收件箱 = HTTP API 或 WebSocket
  https://mcp.axon.dev/inbox/{partnerId}
```

Axon 默认走本地文件系统。远程模式需要额外配置。

### MCP 的哲学

> **去中心化：没有中央调度器，没有编排中心。**

每个 Agent 都是独立的。它们通过 MCP 互相发现、发送消息。没有"主 Agent"来分配任务——谁来分配任务本身也是协作的一部分。

---

## 7. 动手实验：多 Agent 协作

### 实验一：两个 Agent 聊天

开两个终端：

```
终端 1（Agent A）:
  → partner_create("agent-a", ...)
  → 记住自己的 ID

终端 2（Agent B）:
  → partner_create("agent-b", ...)
  → partner_list() → 看到 A
  → partner_send("agent-a", "你好！")

终端 1:
  → partner_read_inbox() → 看到 B 的消息
  → 回复
```

### 实验二：广播模式

```
用户：广播给所有人："谁有 2024 Q4 的半导体行业数据？"
```

看有没有其他终端上的 Agent 响应。

### 实验三：Spawn

```
用户：帮我 spawn 一个 "weather-agent"
      任务：查一下北京今天的天气
```

看子 Agent 能不能独立完成。

### 动手改代码

打开 `src/mcp/` 目录，试试：

1. **加消息确认**：收到消息后自动发送 "已读回执"
2. **加超时**：partner_send 等待回复最多 30 秒
3. **加话题标签**：广播时带 `#topic`，Agent 可以按话题过滤收件箱

---

**上一篇**：[记忆系统：让 Agent 记住你](./06-memory-system.md)

> 实践篇预告：会用 Axon 搭建一个完整的金融分析 Agent，把 01-07 所有知识点串起来。
