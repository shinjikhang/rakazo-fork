import { z } from "zod";

const nonNegative = z.number().nonnegative();

/**
 * Tầng chỉ số — thứ duy nhất AI được phép đọc.
 *
 * Tầng thô giữ nguyên dữ liệu API và tầng tổng hợp gom theo ngày đều nằm ở
 * cdp_backend; model không chạm tới chúng. Bắt buộc có tenant_id, currency và
 * timezone vì một con số không kèm đơn vị và chủ sở hữu là một con số vô nghĩa.
 */
const AdDailySnapshotSchema = z.object({
  tenant_id: z.string().min(1),
  account_id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date phải theo dạng YYYY-MM-DD"),
  currency: z.string().min(1),
  timezone: z.string().min(1),
  level: z.enum(["campaign", "adgroup", "ad"]),
  object_id: z.string().min(1),
  name: z.string(),
  status: z.string().min(1),
  daily_budget: nonNegative,
  spend: nonNegative,
  impressions: nonNegative,
  clicks: nonNegative,
  ctr: nonNegative,
  cpc: nonNegative,
  conversions: nonNegative,
  cpa: nonNegative,
  roas: nonNegative,
  compare: z
    .object({
      d7_avg_cpa: nonNegative,
      d28_avg_cpa: nonNegative,
      cpa_delta_pct: z.number(),
    })
    .optional(),
});

export type AdDailySnapshot = z.infer<typeof AdDailySnapshotSchema>;

export function parseAdDailySnapshot(raw: unknown): AdDailySnapshot {
  const parsed = AdDailySnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}
