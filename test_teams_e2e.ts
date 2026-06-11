/**
 * 端到端集成测试：验证 Agent Teams 系统完整工作流
 */
import { existsSync, unlinkSync } from "fs";
import { join } from "path";

const TEAM_DIR = join(process.cwd(), ".teams");

// 清理前次测试残留
try { unlinkSync(join(TEAM_DIR, "test-agent.jsonl")); } catch {}
try { unlinkSync(join(TEAM_DIR, "leader.jsonl")); } catch {}

import { teamToolHandlers, readInbox, sendMessage } from "./src/tools/teams";

const partnerCreate = teamToolHandlers.partner_create;
const partnerList = teamToolHandlers.partner_list;
const partnerSend = teamToolHandlers.partner_send;
const partnerReadInbox = teamToolHandlers.partner_read_inbox;
const partnerSpawn = teamToolHandlers.partner_spawn;
const partnerRemove = teamToolHandlers.partner_remove;

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

async function main() {
  console.log("\n🧪 Agent Teams E2E 端到端测试\n");

  // ── 1. 创建队友 ──
  console.log("1️⃣  创建队友");
  let result = partnerCreate({ name: "test-agent", instruction: "测试助手" });
  assert(result.includes("test-agent"), `创建队友: ${result}`);

  // ── 2. 验证队友已列出 ──
  console.log("\n2️⃣  验证队友列表");
  result = partnerList({});
  assert(result.includes("test-agent"), `列表包含新队友: ${result}`);

  // ── 3. 发送消息给队友 ──
  console.log("\n3️⃣  发送消息给队友");
  result = partnerSend({ to: "test-agent", content: "请回复 test-ok" });
  assert(result.includes("已发送"), `发送消息: ${result}`);

  // ── 4. 直接验证队友收件箱 ──
  console.log("\n4️⃣  验证队友收件箱");
  result = readInbox("test-agent");
  assert(result.includes("请回复 test-ok"), `队友收件箱有消息: ${result.substring(0, 50)}`);

  // ── 5. 队友清空收件箱后再次读取应得到空（Read and Clear 模式）──
  console.log("\n5️⃣  验证 Read and Clear 模式");
  result = readInbox("test-agent");
  assert(result.includes("空") || result === "", `收件箱已清空: ${result}`);

  // ── 6. 发送消息到 leader（模拟队友回复）──
  console.log("\n6️⃣  模拟队友回复 leader");
  result = sendMessage("test-agent", "leader", "test-ok", "message");
  assert(result.includes("已发送"), `队友回复 leader: ${result}`);

  // ── 7. 验证 leader 收件箱有回复 ──
  console.log("\n7️⃣  验证 leader 收件箱");
  result = partnerReadInbox();
  assert(result.includes("test-ok"), `leader 收到回复: ${result.substring(0, 50)}`);

  // ── 8. 清理 ──
  console.log("\n8️⃣  清理");
  result = partnerRemove({ name: "test-agent" });
  assert(result.includes("已移除"), `移除队友: ${result}`);

  // ── 9. 验证收件箱文件已删除 ──
  console.log("\n9️⃣  验证收件箱文件已清理");
  assert(!existsSync(join(TEAM_DIR, "test-agent.jsonl")),
    "test-agent.jsonl 已删除");

  // ── 汇总 ──
  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
