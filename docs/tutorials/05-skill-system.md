# 05. Skill 系统：注入专业能力

> 从零到一实现一个 AI Agent 框架 · 第五篇

---

## 1. 为什么需要 Skill？

大模型什么都知道一点，但什么都不精。问它 DCF 怎么算，它能背出来——但真要它**实操**，就露馅了：

```
用户：用 DCF 给 Apple 估值
      ↓
LLM：DCF 是 Discounted Cash Flow 的缩写...
      步骤是：预测现金流 → 折现 → 计算终值...
      但是具体参数怎么设？WACC 取多少？增长率呢？
      它不知道。
```

因为预训练数据里只有理论，没有**实操流程**。更麻烦的是：

- 你不想每次让 Agent 做金融分析都在 prompt 里写一遍方法论
- 你不想 Agent 在做一个新领域的任务时"瞎摸索"
- 你希望 Agent 能复用经验——这次学会了，下次直接上手

**Skill 就是干这个的。**

---

## 2. Skill 到底是什么？

Skill 不是代码，不是 API——它是一份**结构化的文档**。

打开 Axon 的 `.axon/skills/` 目录：

```bash
$ ls .axon/skills/
company-valuation.md
earnings-preview.md
finance-sentiment.md
discord-reader.md
skill-creator.md
...

$ cat .axon/skills/company-valuation.md
# company-valuation

## 用途
用 DCF、相对估值、SOTP 三种方法估算公司内在价值

## 步骤
1. 获取财务数据（使用 yfinance-data skill）
2. 计算 DCF：预测 FCF → 确定 WACC → 计算终值
3. 计算相对估值：找可比公司 → 算 PE/PB 中位数 → 应用
4. 如有多个业务线，用 SOTP
5. 综合三种方法给出估值区间

## 注意事项
- 终值占比过高时要谨慎
- 增长假设要有依据，不要随便填
...
```

就一个 Markdown 文件。但意义重大。

### 对比：没有 Skill vs 有 Skill

```
没有 Skill:
Agent 收到"给 Apple 估值"
→ 凭记忆瞎猜几个数字
→ 可能忘算终值
→ 可能用错折现率
→ 结果不可靠

有 Skill:
Agent 收到"给 Apple 估值"
→ skill_list() 发现 "company-valuation"
→ skill_read("company-valuation") 加载完整方法论
→ 按步骤一步一步执行
→ 每一步都知道需要什么数据、用什么工具
→ 结果可靠、可复现
```

---

## 3. 从零开始：Skill 的最小模型

如果你自己设计 Skill 系统，最少需要什么？

### 3.1 存储：文件夹 + Markdown

```
.axon/skills/
├── company-valuation.md
├── earnings-preview.md
└── finance-sentiment.md
```

每个 `.md` 文件就是一个 Skill。文件名去掉 `.md` 就是 Skill 的名字。

就这么简单？对。因为 Skill 本质是**阅读材料**——Agent 只需要能读到它。

### 3.2 查询：两个工具就够了

```typescript
// skill_list：列出所有可用的 Skill
async function skillList(): Promise<string> {
  const files = fs.readdirSync(SKILLS_DIR);
  const names = files
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
  return names.join('\n');
}

// skill_read：加载一个 Skill 的完整内容
async function skillRead(name: string): Promise<string> {
  return fs.readFileSync(`${SKILLS_DIR}/${name}.md`, 'utf-8');
}
```

Agent 的用法：

```
Agent 内部思维链：
1. 用户说要给 Apple 估值
2. 我查一下有没有相关的 Skill → skill_list()
3. 看到 "company-valuation" → skill_read("company-valuation")
4. 哦，原来应该先拉数据、再算 DCF...
5. 按步骤执行
```

**添加一个新 Skill 就是创建一个 Markdown 文件。** 不需要改代码，不需要部署。

---

## 4. 工程演进：Skill 系统要解决哪些问题？

### 4.1 Agent 怎么知道什么场景用什么 Skill？

光有 Skill 列表不够。Agent 需要知道**什么时候用哪个**。

每个 Skill 的 `## 用途` 部分就是干这个的：

```markdown
# company-valuation

## 用途
用 DCF、相对估值、SOTP 三种方法估算公司内在价值
适用于已有财务数据的上市公司
不适合：早期初创公司、未盈利公司
```

`skill_list` 返回名称和用途描述：

```typescript
async function skillList(): Promise<string> {
  // 读取每个文件的 ## 用途 部分
  const entries = files.map(f => {
    const content = fs.readFileSync(`${SKILLS_DIR}/${f}`, 'utf-8');
    const purpose = content.match(/## 用途\n(.+)/)?.[1] || '';
    return `- ${f.replace('.md', '')}: ${purpose}`;
  });
  return entries.join('\n');
}
```

Agent 看到：

```
- company-valuation: 用 DCF、相对估值、SOTP 估算公司内在价值
- earnings-preview: 财报前瞻分析
- finance-sentiment: 社交媒体情绪分析
```

一眼就能判断哪个能用。

### 4.2 Skill 之间可以互相调用吗？

可以。一个 Skill 的步骤里可以引用另一个 Skill：

```markdown
## 步骤
1. 使用 yfinance-data skill 获取财务数据
2. 计算 DCF
3. ...
```

这不是真正的"函数调用"——它是**文档层面的引用**。Agent 在执行步骤 1 时，会先去 `skill_read("yfinance-data")` 加载那个 Skill。

### 4.3 谁来创建和维护 Skill？

最开始是人。但有了 `skill-creator` 这个 Skill 之后……

```
# skill-creator

## 用途
创建新的 Skill、修改已有 Skill

## 步骤
1. 分析用户需求 → 确定需要什么领域的知识
2. 创建 .axon/skills/{name}.md 文件
3. 定义用途、步骤、注意事项
4. 用 skill_list 验证新 Skill 可见
```

注意：**skill-creator 本身也是一个 Skill**。它被用来创建其他的 Skill，包括修改它自己。

这叫**自举（bootstrapping）**——系统用自身的能力来扩展自己。一旦 `skill-creator` 写好，Agent 就可以自己创建新的 Skill 了。

```
用户：我需要一个分析 SaaS 公司估值的 Skill
      ↓
Agent：好的，我看看 skill-creator 怎么用
       → skill_read("skill-creator")
       → 按照步骤创建 .axon/skills/saas-valuation.md
       → skill_list 验证可见
       → 让用户验收
```

---

## 5. 代码解剖：Axon 的 Skill 系统

Skill 系统的代码很简单——因为它就两个工具。核心在 `src/tool/skill.ts`。

### skill_list

```typescript
// src/tool/skill.ts

async function handleSkillList(): Promise<string> {
  const skillsDir = getSkillsDir();

  if (!fs.existsSync(skillsDir)) {
    return '暂无可用技能';
  }

  const files = fs.readdirSync(skillsDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  const lines = files.map(f => {
    const name = f.replace('.md', '');
    const content = fs.readFileSync(
      path.join(skillsDir, f), 'utf-8'
    );

    // 提取第一段用途描述
    const purposeMatch = content.match(
      /## 用途\s*\n\s*([^\n]+)/
    );
    const purpose = purposeMatch
      ? purposeMatch[1].trim()
      : '无描述';

    return `- **${name}**: ${purpose}`;
  });

  return lines.length > 0
    ? `可用技能：\n${lines.join('\n')}`
    : '暂无可用技能';
}
```

### skill_read

```typescript
async function handleSkillRead({ name }: { name: string }): Promise<string> {
  const filePath = path.join(getSkillsDir(), `${name}.md`);

  if (!fs.existsSync(filePath)) {
    return `错误：技能 "${name}" 不存在。使用 skill_list 查看所有技能。`;
  }

  return fs.readFileSync(filePath, 'utf-8');
}
```

### Agent 使用示例

```
用户：帮我看看 META 的财报前瞻

Agent 内部调用链路：

① skill_list()
   ↓
   name: earnings-preview
   desc: 生成财报前瞻分析简报

② skill_read("earnings-preview")
   ↓
   加载步骤：
   1. 获取财务数据
   2. 分析师预期
   3. 对比历史
   4. 关键关注点

③ 按步骤执行
   → yfinance 拉 META 数据
   → 对比去年同期
   → 整理关注点
   → 生成报告
```

---

## 6. 动手实验：用 Skill 系统

### 实验一：查看可用的 Skill

```
用户：你都会什么技能？
```

Agent 会调用 `skill_list()`，你就能看到当前所有可用的 Skill。

### 实验二：创建一个新 Skill

```
用户：创建一个新的 skill 叫做 "pizza-analyzer"
      专门分析披萨店的质量
      步骤：1. 看评分  2. 看配料  3. 看价格
```

Agent 应该会用 `skill-creator`（或者直接写文件）来创建：

```markdown
# pizza-analyzer

## 用途
分析披萨店的综合质量

## 步骤
1. 获取评分数据
2. 分析配料搭配
3. 评估价格合理性
4. 给出综合评分
```

### 实验三：Skill 覆盖与冲突

如果两个 Skill 用途描述相似，Agent 会选哪个？试试：

```
用户：创建两个 Skill：
  - "fetch-stock-price": 获取股票当前价格
  - "get-share-price": 也是获取股票当前价格

然后问 Agent "MSFT 当前多少钱"
```

看 Agent 选哪个。它靠什么决策？

### 动手改代码

打开 `src/tool/skill.ts`，试试：

1. **给 skill_list 加分类**：`finance`、`social`、`analysis` 等标签
2. **加 search 功能**：`skill_search("估值")` 返回相关的 Skill
3. **Skill 版本号**：每个 Skill 头部加 `version: 1.0`，list 时显示

---

**上一篇**：[DAG 任务规划：拆解复杂目标](./04-task-planning.md) → **下一篇**：[记忆系统：让 Agent 记住你](./07-memory-system)

Agent 每次对话压缩后就失忆了。怎么让它记住你的名字、偏好、项目决策？记忆系统就是干这个的。
