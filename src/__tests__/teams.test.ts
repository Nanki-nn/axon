import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import {
  getInboxesDir,
  getTeamsDir,
  readInbox,
  sendMessage,
  teamToolHandlers,
} from "../features/teams";

const TEST_TEAMS_DIR = join(process.cwd(), ".tmp", "teams-test");

function cleanTeams(): void {
  const teamsDir = getTeamsDir();
  if (existsSync(teamsDir)) {
    rmSync(teamsDir, { recursive: true, force: true });
  }
}

describe("teams", () => {
  beforeEach(() => {
    process.env.AXON_TEAMS_DIR = TEST_TEAMS_DIR;
    cleanTeams();
  });

  afterEach(() => {
    cleanTeams();
    delete process.env.AXON_TEAMS_DIR;
  });

  it("创建、列出并删除队友", () => {
    const created = teamToolHandlers.partner_create({ name: "alice", instruction: "数据分析师" });
    expect(created).toContain("alice");

    const list = teamToolHandlers.partner_list({});
    expect(list).toContain("alice");
    expect(list).toContain("数据分析师");

    const removed = teamToolHandlers.partner_remove({ name: "alice" });
    expect(removed).toContain("已移除");
    expect(teamToolHandlers.partner_list({})).toContain("暂无队友");
  });

  it("发送、读取并清空收件箱", () => {
    teamToolHandlers.partner_create({ name: "bob", instruction: "开发者" });

    const sent = teamToolHandlers.partner_send({ to: "bob", content: "请处理任务" });
    expect(sent).toContain("已发送");
    expect(existsSync(join(getInboxesDir(), "bob.jsonl"))).toBe(true);

    const inbox = readInbox("bob");
    expect(inbox).toContain("请处理任务");
    expect(readInbox("bob")).toContain("收件箱为空");
  });

  it("支持队友回复 leader 和 self 别名", () => {
    const leaderReply = sendMessage("bob", "leader", "任务完成");
    expect(leaderReply).toContain("已发送");

    const selfReply = sendMessage("bob", "self", "补充说明");
    expect(selfReply).toContain("已发送");

    const leaderInboxPath = join(getInboxesDir(), "leader.jsonl");
    const rawInbox = readFileSync(leaderInboxPath, "utf-8");
    expect(rawInbox).toContain("任务完成");
    expect(rawInbox).toContain("补充说明");

    const inbox = teamToolHandlers.partner_read_inbox({});
    expect(inbox).toContain("任务完成");
    expect(inbox).toContain("补充说明");
  });

  it("拒绝发送给不存在的队友", () => {
    const result = teamToolHandlers.partner_send({ to: "missing", content: "hello" });
    expect(result).toContain("不存在");
  });
});
