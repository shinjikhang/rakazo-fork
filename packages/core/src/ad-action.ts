import { z } from "zod";
import { assertBudgetChangeWithinCap } from "./ad-budget-cap.js";

const NUMERIC_OPS = new Set(["set_daily_budget", "set_bid"]);

const AdActionSchema = z
  .object({
    action_id: z.string().min(1),
    snapshot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    op: z.enum(["pause", "resume", "set_daily_budget", "set_bid"]),
    target: z.object({
      level: z.enum(["campaign", "adgroup", "ad"]),
      object_id: z.string().min(1),
    }),
    // Giá trị cũ là bắt buộc: không có nó thì không hoàn tác được, và cũng
    // không trả lời được câu «hôm qua ai đã đổi cái gì».
    from: z.union([z.number(), z.string()], { error: "from là bắt buộc để hoàn tác" }),
    to: z.union([z.number(), z.string()], { error: "to là bắt buộc" }),
    reason: z.string().min(1),
    requires_confirm: z.boolean(),
    confirmed_by: z.string().optional(),
    confirmed_at: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.requires_confirm) {
      ctx.addIssue({
        code: "custom",
        message: "mọi thao tác tiêu tiền phải có requires_confirm = true",
      });
    }
    if (NUMERIC_OPS.has(value.op)) {
      if (typeof value.from !== "number" || typeof value.to !== "number") {
        ctx.addIssue({ code: "custom", message: "from và to phải là số với thao tác đổi số" });
        return;
      }
      try {
        assertBudgetChangeWithinCap(value.from, value.to);
      } catch (error) {
        ctx.addIssue({ code: "custom", message: (error as Error).message });
      }
    }
  });

export type AdAction = z.infer<typeof AdActionSchema>;

export function parseAdAction(raw: unknown): AdAction {
  const parsed = AdActionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}

/** Đổi chiều một lệnh đã chạy, để hoàn tác trong cửa sổ cho phép. */
export function inverseAdAction(action: AdAction): AdAction {
  const op = action.op === "pause" ? "resume" : action.op === "resume" ? "pause" : action.op;
  return {
    ...action,
    action_id: `${action.action_id}_inverse`,
    op,
    from: action.to,
    to: action.from,
    reason: `Hoàn tác ${action.action_id}`,
    confirmed_by: undefined,
    confirmed_at: undefined,
  };
}

/** Ánh xạ sang đúng tool MCP và tham số của nó. */
export function adActionToolCall(action: AdAction): {
  tool: string;
  args: Record<string, unknown>;
} {
  const { level, object_id: objectId } = action.target;
  if (action.op === "set_daily_budget" || action.op === "set_bid") {
    // tiktok_update_adgroup chỉ có adgroup_id/advertiser_id/params ở top level
    // (đã kiểm bằng tools/list) — budget và bid_price đi qua params dạng chuỗi JSON.
    const field = action.op === "set_daily_budget" ? "budget" : "bid_price";
    return {
      tool: "tiktok_update_adgroup",
      args: { adgroup_id: objectId, params: JSON.stringify({ [field]: action.to }) },
    };
  }
  // Ba tool *_status dùng opt_status (không phải operation_status), và các
  // trường *_ids khai type "string" trong inputSchema thật — nghĩa là chuỗi
  // JSON của mảng, không phải mảng thô.
  const optStatus = action.op === "pause" ? "DISABLE" : "ENABLE";
  if (level === "ad") {
    return {
      tool: "tiktok_update_ad_status",
      args: { ad_ids: JSON.stringify([objectId]), opt_status: optStatus },
    };
  }
  if (level === "adgroup") {
    return {
      tool: "tiktok_update_adgroup_status",
      args: { adgroup_ids: JSON.stringify([objectId]), opt_status: optStatus },
    };
  }
  return {
    tool: "tiktok_update_campaign_status",
    args: { campaign_ids: JSON.stringify([objectId]), opt_status: optStatus },
  };
}
