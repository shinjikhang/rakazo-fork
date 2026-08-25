import { describe, expect, it } from "vitest";
import { parseAdDailySnapshot } from "./ad-snapshot.js";

const valid = {
  tenant_id: "t_0912",
  account_id: "tt_88231",
  date: "2026-08-24",
  currency: "VND",
  timezone: "Asia/Ho_Chi_Minh",
  level: "ad",
  object_id: "ad_55120",
  name: "Video review 15s",
  status: "ACTIVE",
  daily_budget: 500000,
  spend: 483000,
  impressions: 91200,
  clicks: 1120,
  ctr: 0.0123,
  cpc: 431,
  conversions: 18,
  cpa: 26833,
  roas: 1.8,
  compare: { d7_avg_cpa: 19400, d28_avg_cpa: 20100, cpa_delta_pct: 0.38 },
};

describe("hợp đồng AdDailySnapshot", () => {
  it("nhận bản ghi hợp lệ", () => {
    expect(parseAdDailySnapshot(valid).object_id).toBe("ad_55120");
  });

  it("bắt buộc có tenant_id — không có thì không cách ly được", () => {
    const { tenant_id: _dropped, ...withoutTenant } = valid;
    expect(() => parseAdDailySnapshot(withoutTenant)).toThrow(/tenant_id/);
  });

  it("bắt buộc có timezone và currency — số liệu không có đơn vị là số vô nghĩa", () => {
    const { timezone: _tz, ...withoutTz } = valid;
    expect(() => parseAdDailySnapshot(withoutTz)).toThrow(/timezone/);
    const { currency: _cur, ...withoutCurrency } = valid;
    expect(() => parseAdDailySnapshot(withoutCurrency)).toThrow(/currency/);
  });

  it("từ chối ngày sai định dạng", () => {
    expect(() => parseAdDailySnapshot({ ...valid, date: "24/08/2026" })).toThrow(/date/);
  });

  it("từ chối cấp không hợp lệ", () => {
    expect(() => parseAdDailySnapshot({ ...valid, level: "account" })).toThrow(/level/);
  });

  it("từ chối số âm ở chi tiêu", () => {
    expect(() => parseAdDailySnapshot({ ...valid, spend: -1 })).toThrow(/spend/);
  });

  it("compare là tuỳ chọn — ngày đầu tiên chưa có mốc so sánh", () => {
    const { compare: _dropped, ...withoutCompare } = valid;
    expect(parseAdDailySnapshot(withoutCompare).compare).toBeUndefined();
  });
});
