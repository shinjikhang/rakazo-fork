import type { ActionApprovalRule } from "./action-approval.js";

/**
 * Bốn tool duy nhất được phép đổi thứ tiêu tiền trên TikTok ở đợt này.
 *
 * Cổng phê duyệt của executor mặc định cho qua khi không rule nào khớp
 * (action-approval.ts:107), nên danh sách này tồn tại để dựng rule tường minh
 * chứ không dựa vào suy đoán theo tên tool.
 */
export const TIKTOK_WRITE_TOOLS = [
  "tiktok_update_ad_status",
  "tiktok_update_adgroup",
  "tiktok_update_adgroup_status",
  "tiktok_update_campaign_status",
] as const;

/** Rule khớp theo tên tool: cụ thể nhất, nên thắng mọi rule connector hay category. */
export function tiktokApprovalRules(): ActionApprovalRule[] {
  return TIKTOK_WRITE_TOOLS.map((matchValue) => ({
    effect: "require_approval" as const,
    matchKind: "tool" as const,
    matchValue,
  }));
}
