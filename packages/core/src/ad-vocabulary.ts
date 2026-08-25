import { z } from "zod";

/**
 * Từ vựng dùng chung cho mọi hợp đồng quảng cáo.
 *
 * Trước đây `op` khai lại ở ad-action.ts và ad-report-message.ts, `level` khai
 * lại ở ba nơi — và ruling R6 (chỉ đổi số ở cấp adgroup) chỉ hạ cánh ở một chỗ.
 * Một nguồn duy nhất để lần sau không lệch nữa.
 */
export const AD_OPS = ["pause", "resume", "set_daily_budget", "set_bid"] as const;
export const AD_LEVELS = ["campaign", "adgroup", "ad"] as const;

export type AdOp = (typeof AD_OPS)[number];
export type AdLevel = (typeof AD_LEVELS)[number];

export const AdOpSchema = z.enum(AD_OPS);
export const AdLevelSchema = z.enum(AD_LEVELS);

/** Hai thao tác đổi số: bị trần ±50% và chỉ áp dụng ở cấp adgroup. */
export const AD_NUMERIC_OPS: ReadonlySet<AdOp> = new Set(["set_daily_budget", "set_bid"]);
