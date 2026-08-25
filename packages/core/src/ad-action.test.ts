import { describe, expect, it } from "vitest";
import { adActionToolCall, inverseAdAction, parseAdAction } from "./ad-action.js";

const budgetAction = {
  action_id: "act_7731",
  account_id: "tt_88231",
  snapshot_date: "2026-08-24",
  op: "set_daily_budget",
  target: { level: "adgroup", object_id: "adg_3301" },
  from: 500000,
  to: 300000,
  reason: "CPA 7 ngày gần nhất cao hơn mục tiêu 38%",
  requires_confirm: true,
};

describe("hợp đồng AdAction", () => {
  it("nhận lệnh đổi ngân sách hợp lệ", () => {
    expect(parseAdAction(budgetAction).to).toBe(300000);
  });

  it("từ chối khi thiếu from — không có thì không hoàn tác được, ASSERT-6", () => {
    const { from: _dropped, ...withoutFrom } = budgetAction;
    expect(() => parseAdAction(withoutFrom)).toThrow(/from/);
  });

  it("từ chối khi vượt trần 50% — ASSERT-5", () => {
    expect(() => parseAdAction({ ...budgetAction, to: 100000 })).toThrow(/vượt trần/);
  });

  it("thao tác tiêu tiền bắt buộc requires_confirm = true — ASSERT-4", () => {
    expect(() => parseAdAction({ ...budgetAction, requires_confirm: false })).toThrow(
      /requires_confirm/,
    );
  });

  it("dựng được lệnh nghịch đảo từ from — ASSERT-6", () => {
    const inverse = inverseAdAction(parseAdAction(budgetAction));
    expect(inverse.from).toBe(300000);
    expect(inverse.to).toBe(500000);
    expect(inverse.target.object_id).toBe("adg_3301");
  });

  it("nghịch đảo của pause là resume", () => {
    const pause = parseAdAction({
      action_id: "act_1",
      account_id: "tt_88231",
      snapshot_date: "2026-08-24",
      op: "pause",
      target: { level: "ad", object_id: "ad_55120" },
      from: "ENABLE",
      to: "DISABLE",
      reason: "CTR giảm liên tục 5 ngày",
      requires_confirm: true,
    });
    expect(inverseAdAction(pause).op).toBe("resume");
  });

  it("ánh xạ set_daily_budget sang tiktok_update_adgroup", () => {
    // tiktok_update_adgroup thật (đối chiếu qua tools/list) chỉ nhận adgroup_id
    // ở top level; budget đi trong params dạng chuỗi JSON.
    const call = adActionToolCall(parseAdAction(budgetAction));
    expect(call.tool).toBe("tiktok_update_adgroup");
    expect(call.args.adgroup_id).toBe("adg_3301");
    expect(JSON.parse(call.args.params as string)).toMatchObject({ budget: 300000 });
  });

  it("ánh xạ pause ở cấp ad sang tiktok_update_ad_status", () => {
    const call = adActionToolCall(
      parseAdAction({
        action_id: "act_2",
        account_id: "tt_88231",
        snapshot_date: "2026-08-24",
        op: "pause",
        target: { level: "ad", object_id: "ad_55120" },
        from: "ENABLE",
        to: "DISABLE",
        reason: "CPA gấp đôi mục tiêu",
        requires_confirm: true,
      }),
    );
    // ad_ids khai type "string" trong inputSchema thật (chuỗi JSON của mảng),
    // và trường trạng thái tên là opt_status (đối chiếu qua tools/list).
    expect(call.tool).toBe("tiktok_update_ad_status");
    expect(call.args).toMatchObject({
      ad_ids: JSON.stringify(["ad_55120"]),
      opt_status: "DISABLE",
    });
  });

  it("ánh xạ tool gắn advertiser_id từ account_id — đổi ngân sách và pause", () => {
    const budgetCall = adActionToolCall(parseAdAction(budgetAction));
    expect(budgetCall.args.advertiser_id).toBe("tt_88231");

    const pauseCall = adActionToolCall(
      parseAdAction({
        action_id: "act_3",
        account_id: "tt_88231",
        snapshot_date: "2026-08-24",
        op: "pause",
        target: { level: "ad", object_id: "ad_55120" },
        from: "ENABLE",
        to: "DISABLE",
        reason: "CTR giảm liên tục 5 ngày",
        requires_confirm: true,
      }),
    );
    expect(pauseCall.args.advertiser_id).toBe("tt_88231");
  });

  it("từ chối khi thiếu account_id — không biết chạy trên tài khoản nào", () => {
    const { account_id: _dropped, ...withoutAccountId } = budgetAction;
    expect(() => parseAdAction(withoutAccountId)).toThrow(/account_id/);
  });
});
