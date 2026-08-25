import { z } from "zod";
import { assertBudgetChangeWithinCap } from "./ad-budget-cap.js";
import { AD_NUMERIC_OPS, AdLevelSchema, AdOpSchema } from "./ad-vocabulary.js";

const AdActionSchema = z
  .object({
    action_id: z.string().min(1),
    account_id: z.string({ error: "account_id là bắt buộc" }).min(1, "account_id là bắt buộc"),
    snapshot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    op: AdOpSchema,
    target: z.object({
      level: AdLevelSchema,
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
    if (AD_NUMERIC_OPS.has(value.op)) {
      if (value.target.level !== "adgroup") {
        ctx.addIssue({
          code: "custom",
          message: `${value.op} chỉ áp dụng ở cấp adgroup, không phải ${value.target.level}`,
        });
        return;
      }
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

/**
 * Ánh xạ sang đúng tool MCP và tham số của nó.
 *
 * `AdAction` là kiểu cấu trúc (z.infer), nên một object literal đúng hình có thể
 * tới đây mà chưa từng qua parseAdAction. Ba khẳng định dưới là chốt cuối cùng
 * ngay trước khi ghi.
 *
 * Bất đối xứng có chủ ý: trần ±50% KHÔNG kiểm ở đây. Trần đó canh thứ model đề
 * xuất, nên thuộc về parseAdAction. Nghịch đảo của một cú giảm 50% hợp lệ là một
 * cú tăng 100%; ép trần ở đây thì không hoàn tác được nữa (trái ASSERT-6), mà
 * hoàn tác chỉ trả lại giá trị vài phút trước còn đang chạy — an toàn tự thân.
 */
export function adActionToolCall(action: AdAction): {
  tool: string;
  args: Record<string, unknown>;
} {
  const { level, object_id: objectId } = action.target;
  if (AD_NUMERIC_OPS.has(action.op) && level !== "adgroup") {
    throw new Error(`${action.op} chỉ áp dụng ở cấp adgroup, không phải ${level}`);
  }
  if (!action.requires_confirm) {
    throw new Error(`${action.action_id}: thiếu requires_confirm = true, không được ghi`);
  }
  if (!action.confirmed_by?.trim()) {
    throw new Error(`${action.action_id}: thiếu confirmed_by, không được ghi`);
  }
  if (action.op === "set_daily_budget" || action.op === "set_bid") {
    // tiktok_update_adgroup chỉ có adgroup_id/advertiser_id/params ở top level
    // (đã kiểm bằng tools/list) — budget và bid_price đi qua params dạng chuỗi JSON.
    const field = action.op === "set_daily_budget" ? "budget" : "bid_price";
    return {
      tool: "tiktok_update_adgroup",
      args: {
        adgroup_id: objectId,
        advertiser_id: action.account_id,
        params: JSON.stringify({ [field]: action.to }),
      },
    };
  }
  // Ba tool *_status dùng opt_status (không phải operation_status), và các
  // trường *_ids khai type "string" trong inputSchema thật — nghĩa là chuỗi
  // JSON của mảng, không phải mảng thô.
  const optStatus = action.op === "pause" ? "DISABLE" : "ENABLE";
  if (level === "ad") {
    return {
      tool: "tiktok_update_ad_status",
      args: {
        ad_ids: JSON.stringify([objectId]),
        advertiser_id: action.account_id,
        opt_status: optStatus,
      },
    };
  }
  if (level === "adgroup") {
    return {
      tool: "tiktok_update_adgroup_status",
      args: {
        adgroup_ids: JSON.stringify([objectId]),
        advertiser_id: action.account_id,
        opt_status: optStatus,
      },
    };
  }
  return {
    tool: "tiktok_update_campaign_status",
    args: {
      campaign_ids: JSON.stringify([objectId]),
      advertiser_id: action.account_id,
      opt_status: optStatus,
    },
  };
}
