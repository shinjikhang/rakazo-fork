/**
 * Mỗi lần chỉnh ngân sách không quá ±50% giá trị đang có (ASSERT-5).
 *
 * Trần này chặn thiệt hại của một đề xuất sai: model đọc nhầm đơn vị tiền tệ
 * hoặc nhầm đối tượng thì sai số bị giới hạn ở một nửa, thay vì gấp mười lần.
 * Muốn đổi nhiều hơn thì thao tác thủ công trên TikTok.
 */
export const BUDGET_DELTA_CAP = 0.5;

export function budgetChangeWithinCap(from: number, to: number): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  if (from <= 0 || to < 0) return false;
  return Math.abs(to - from) / from <= BUDGET_DELTA_CAP;
}

export function assertBudgetChangeWithinCap(from: number, to: number): void {
  if (!budgetChangeWithinCap(from, to)) {
    throw new Error(
      `Đổi ngân sách từ ${from} sang ${to} vượt trần ${BUDGET_DELTA_CAP * 100}% mỗi lần`,
    );
  }
}
