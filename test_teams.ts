/**
 * 团队系统核心功能测试（不含 spawn）
 */
import * as path from "path";
import * as fs from "fs";
import { teamToolHandlers } from "./src/tools/teams";

const TEAMS_DIR = path.join(process.cwd(), ".agents", "teams");
const INBOXES_DIR = path.join(TEAMS_DIR, "inboxes");

function clean() {
  if (fs.existsSync(TEAMS_DIR)) {
    fs.rmSync(TEAMS_DIR, { recursive: true });
    console.log("✓ 已清理 .agents/teams/");
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`✗ FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function run() {
  clean();

  section("1. 创建队友");
  let r = await teamToolHandlers.partner_create({ name: "alice", instruction: "数据分析师" });
  console.log(`  alice: ${r}`);
  r = await teamToolHandlers.partner_create({ name: "bob", instruction: "Python 开发者" });
  console.log(`  bob: ${r}`);
  r = await teamToolHandlers.partner_create({ name: "charlie", instruction: "文档撰写" });
  console.log(`  charlie: ${r}`);

  const team = JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, "team.json"), "utf-8"));
  assert(team.length === 3, "team.json 有 3 个队友");

  section("2. 列出队友");
  r = await teamToolHandlers.partner_list({});
  console.log(`  结果:\n${r}`);
  assert(r.includes("alice"), "alice 在列表中");

  section("3. 发消息给 bob");
  r = await teamToolHandlers.partner_send({ to: "bob", content: "请写斐波那契脚本" });
  console.log(`  结果: ${r}`);
  assert(r.includes("已发送"), "发送成功");
  assert(fs.existsSync(path.join(INBOXES_DIR, "bob.jsonl")), "bob 收件箱已创建");

  section("4. 发消息给 leader");
  r = await teamToolHandlers.partner_send({ to: "leader", content: "自测消息" });
  console.log(`  结果: ${r}`);
  assert(r.includes("已发送"), "发送成功");

  section("5. 发消息给 self（应映射到 leader 收件箱）");
  r = await teamToolHandlers.partner_send({ to: "self", content: "self 测试" });
  console.log(`  结果: ${r}`);
  assert(r.includes("已发送"), "发送成功");

  const leaderInbox = path.join(INBOXES_DIR, "leader.jsonl");
  const leaderContent = fs.readFileSync(leaderInbox, "utf-8").trim();
  assert(leaderContent.includes("self 测试"), "self 消息写入 leader 收件箱");
  assert(!fs.existsSync(path.join(INBOXES_DIR, "self.jsonl")), "没有单独的 self.jsonl");

  section("6. 广播");
  r = await teamToolHandlers.partner_broadcast({ content: "全体通知" });
  console.log(`  结果: ${r}`);
  assert(r.includes("3 个队友"), "广播给所有队友");

  section("7. 删除 charlie");
  r = await teamToolHandlers.partner_remove({ name: "charlie" });
  console.log(`  结果: ${r}`);
  assert(r.includes("已移除"), "移除成功");

  const team2 = JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, "team.json"), "utf-8"));
  assert(team2.length === 2, "剩 2 个");
  assert(!fs.existsSync(path.join(INBOXES_DIR, "charlie.jsonl")), "收件箱已删除");

  section("8. 读取 leader 收件箱");
  r = await teamToolHandlers.partner_read_inbox({});
  console.log(`  结果:\n${r}`);
  assert(r.includes("自测消息") && r.includes("self 测试"), "包含所有消息");

  const afterRead = fs.readFileSync(leaderInbox, "utf-8").trim();
  assert(afterRead === "", "读取后清空");

  section("9. 错误处理测试");
  r = await teamToolHandlers.partner_create({ name: "alice", instruction: "重复" });
  assert(r.includes("已存在"), "重复创建提示存在");

  r = await teamToolHandlers.partner_remove({ name: "charlie" });
  assert(r.includes("不存在"), "重复删除提示不存在");

  r = await teamToolHandlers.partner_send({ to: "nonexistent", content: "测试" });
  assert(r.includes("不存在"), "发给不存在的提示");

  r = await teamToolHandlers.partner_spawn({ name: "nonexistent" });
  assert(r.includes("不存在"), "spawn 不存在的提示");

  clean();
  console.log("\n✓ 所有核心功能测试通过！");
}

run().catch(err => { console.error("测试失败:", err); process.exit(1); });
