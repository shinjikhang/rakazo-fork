import { describe, expect, it } from "vitest";
import { resolveActionApproval } from "./action-approval.js";
import { TIKTOK_WRITE_TOOLS, tiktokApprovalRules } from "./ad-approval.js";

describe("cổng phê duyệt cho tool ghi TikTok", () => {
  it("bốn tool ghi đều phải hỏi khi đã có rule", () => {
    const rules = tiktokApprovalRules();
    for (const toolName of TIKTOK_WRITE_TOOLS) {
      expect(resolveActionApproval({ toolName, connectorKind: "tiktok", rules })).toBe("ask");
    }
  });

  it("không có rule thì tool ghi chạy thẳng — đây là lý do rule bắt buộc", () => {
    expect(
      resolveActionApproval({
        toolName: "tiktok_update_adgroup",
        connectorKind: "tiktok",
        rules: [],
      }),
    ).toBe("allow");
  });

  it("tool đọc không bị chặn", () => {
    const rules = tiktokApprovalRules();
    expect(
      resolveActionApproval({
        toolName: "tiktok_get_ad_groups",
        connectorKind: "tiktok",
        rules,
      }),
    ).toBe("allow");
  });

  it("tên tool có tiền tố mcp__<slug>__ vẫn khớp rule — M1", () => {
    const rules = tiktokApprovalRules();
    for (const toolName of TIKTOK_WRITE_TOOLS) {
      expect(
        resolveActionApproval({
          toolName: `mcp__tiktok-ads-mcp__${toolName}`,
          connectorKind: "tiktok",
          rules,
        }),
      ).toBe("ask");
    }
  });

  it("tool đọc có tiền tố vẫn chạy thẳng", () => {
    expect(
      resolveActionApproval({
        toolName: "mcp__tiktok-ads-mcp__tiktok_get_ad_groups",
        connectorKind: "tiktok",
        rules: tiktokApprovalRules(),
      }),
    ).toBe("allow");
  });

  it("danh sách tool ghi đúng bốn cái, không dư", () => {
    expect([...TIKTOK_WRITE_TOOLS].sort()).toEqual([
      "tiktok_update_ad_status",
      "tiktok_update_adgroup",
      "tiktok_update_adgroup_status",
      "tiktok_update_campaign_status",
    ]);
  });
});
