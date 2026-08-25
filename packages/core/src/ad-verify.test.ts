import { describe, expect, it } from "vitest";
import { parseAdAction } from "./ad-action.js";
import { verificationToolCall, verifyApplied } from "./ad-verify.js";

const budgetAction = parseAdAction({
  action_id: "act_7731",
  account_id: "tt_88231",
  snapshot_date: "2026-08-24",
  op: "set_daily_budget",
  target: { level: "adgroup", object_id: "adg_3301" },
  from: 500000,
  to: 300000,
  reason: "CPA cao hơn mục tiêu 38%",
  requires_confirm: true,
  confirmed_by: "user_2210",
});

describe("kiểm chứng sau thực thi", () => {
  it("kiểm chứng gọi API TikTok thật, không đọc lại DB của Cluega", () => {
    expect(verificationToolCall(budgetAction).tool).toBe("tiktok_get_ad_groups");
    expect(verificationToolCall(budgetAction).tool).not.toMatch(/^cluega_/);
  });

  it("truyền advertiser_id bắt buộc của tool đọc thật", () => {
    expect(verificationToolCall(budgetAction).args.advertiser_id).toBe("tt_88231");
  });

  it("giá trị quan sát khớp thì verified", () => {
    const outcome = verifyApplied(budgetAction, { list: [{ adgroup_id: "adg_3301", budget: 300000 }] });
    expect(outcome.status).toBe("verified");
  });

  it("giá trị chưa đổi thì unverified, không phải thất bại", () => {
    const outcome = verifyApplied(budgetAction, { list: [{ adgroup_id: "adg_3301", budget: 500000 }] });
    expect(outcome.status).toBe("unverified");
    expect(outcome.note).toContain("sẽ kiểm lại ở lần kéo sau");
  });

  it("không tìm thấy đối tượng thì unverified", () => {
    expect(verifyApplied(budgetAction, { list: [] }).status).toBe("unverified");
  });

  it("kết quả rác thì unverified chứ không ném lỗi", () => {
    expect(verifyApplied(budgetAction, "không phải json").status).toBe("unverified");
  });

  it("kiểm chứng pause ở cấp ad dùng tiktok_get_ads", () => {
    const pause = parseAdAction({
      action_id: "act_2",
      account_id: "tt_88231",
      snapshot_date: "2026-08-24",
      op: "pause",
      target: { level: "ad", object_id: "ad_55120" },
      from: "ENABLE",
      to: "DISABLE",
      reason: "CPA gấp đôi",
      requires_confirm: true,
    });
    expect(verificationToolCall(pause).tool).toBe("tiktok_get_ads");
    expect(
      verifyApplied(pause, { list: [{ ad_id: "ad_55120", operation_status: "DISABLE" }] }).status,
    ).toBe("verified");
  });
});
