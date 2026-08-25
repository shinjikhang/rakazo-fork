import { describe, expect, it } from "vitest";
import {
  assertBudgetChangeWithinCap,
  BUDGET_DELTA_CAP,
  budgetChangeWithinCap,
} from "./ad-budget-cap.js";

describe("trần đổi ngân sách", () => {
  it("trần là 50%", () => {
    expect(BUDGET_DELTA_CAP).toBe(0.5);
  });

  it("giảm 40% thì được", () => {
    expect(budgetChangeWithinCap(500000, 300000)).toBe(true);
  });

  it("giảm đúng 50% thì được", () => {
    expect(budgetChangeWithinCap(500000, 250000)).toBe(true);
  });

  it("giảm 60% thì bị chặn", () => {
    expect(budgetChangeWithinCap(500000, 200000)).toBe(false);
  });

  it("tăng 60% thì bị chặn", () => {
    expect(budgetChangeWithinCap(500000, 800000)).toBe(false);
  });

  it("giá trị cũ bằng 0 thì luôn bị chặn — không có mốc để tính phần trăm", () => {
    expect(budgetChangeWithinCap(0, 100000)).toBe(false);
  });

  it("giá trị âm bị chặn", () => {
    expect(budgetChangeWithinCap(500000, -1)).toBe(false);
  });

  it("assert ném lỗi có ghi cả hai giá trị", () => {
    expect(() => assertBudgetChangeWithinCap(500000, 200000)).toThrow(/500000.*200000/);
  });

  it("assert im lặng khi hợp lệ", () => {
    expect(() => assertBudgetChangeWithinCap(500000, 300000)).not.toThrow();
  });
});
