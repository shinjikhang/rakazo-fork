import { describe, expect, it } from "vitest";
import { formatAdReportMessage, parseAdReportMessage } from "./ad-report-message.js";

const valid = {
  what_happened: "Chi tiêu hôm qua 4.830.000đ, CPA 26.833đ.",
  why_it_matters: "CPA cao hơn trung bình 7 ngày 38%.",
  suggestions: [
    {
      text: "Giảm ngân sách ngày nhóm adg_3301 từ 500.000đ xuống 300.000đ",
      op: "set_daily_budget",
      level: "adgroup",
      object_id: "adg_3301",
      from: 500000,
      to: 300000,
    },
    { text: "Tắt quảng cáo ad_55120", op: "pause", level: "ad", object_id: "ad_55120" },
    { text: "Tắt quảng cáo ad_55121", op: "pause", level: "ad", object_id: "ad_55121" },
  ],
  sources: ["cluega_tiktok_ad_manager_report_daily_summary"],
};

describe("thông điệp báo cáo bốn phần", () => {
  it("nhận thông điệp hợp lệ", () => {
    expect(parseAdReportMessage(valid).suggestions).toHaveLength(3);
  });

  it("từ chối khi có ít hơn ba gợi ý — FR-04", () => {
    expect(() =>
      parseAdReportMessage({ ...valid, suggestions: valid.suggestions.slice(0, 2) }),
    ).toThrow(/ít nhất 3 gợi ý/);
  });

  it("từ chối gợi ý đổi ngân sách mà thiếu from — ASSERT-6", () => {
    const broken = {
      ...valid,
      suggestions: [
        { text: "Giảm ngân sách", op: "set_daily_budget", level: "adgroup", object_id: "adg_1", to: 300000 },
        ...valid.suggestions.slice(1),
      ],
    };
    expect(() => parseAdReportMessage(broken)).toThrow(/from/);
  });

  it("từ chối khi thiếu nguồn đã dùng", () => {
    expect(() => parseAdReportMessage({ ...valid, sources: [] })).toThrow(/nguồn/);
  });

  it("render ra text không chèn thêm gì ngoài các trường đã khai", () => {
    const out = formatAdReportMessage(parseAdReportMessage(valid));
    expect(out).toContain("Chi tiêu hôm qua");
    expect(out).toContain("CPA cao hơn trung bình 7 ngày 38%");
    expect(out).toContain("Giảm ngân sách ngày nhóm adg_3301");
    expect(out).toContain("cluega_tiktok_ad_manager_report_daily_summary");
  });
});
