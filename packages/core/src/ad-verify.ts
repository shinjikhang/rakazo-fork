import type { AdAction } from "./ad-action.js";

export type VerifyOutcome = { status: "verified" | "unverified"; note: string };

const UNVERIFIED_NOTE = "chưa xác nhận được, sẽ kiểm lại ở lần kéo sau";

/**
 * Vòng lặp B: sau khi đổi, đọc lại đúng đối tượng vừa đổi để xác nhận đã có
 * hiệu lực. Bắt buộc gọi API TikTok thật — đọc lại cơ sở dữ liệu của Cluega là
 * tự kiểm chứng chính mình, vì dữ liệu đó do một tiến trình đồng bộ khác ghi.
 */
export function verificationToolCall(action: AdAction): {
  tool: string;
  args: Record<string, unknown>;
} {
  const { level, object_id: objectId } = action.target;
  // tiktok_get_ads/_ad_groups/_campaigns không có tham số *_ids ở top level
  // (đã kiểm bằng tools/list) — chỉ có advertiser_id (bắt buộc) và filters,
  // một chuỗi JSON. Lọc theo id cụ thể đi qua filters.
  if (level === "ad") {
    return {
      tool: "tiktok_get_ads",
      args: {
        advertiser_id: action.account_id,
        filters: JSON.stringify({ ad_ids: [objectId] }),
      },
    };
  }
  if (level === "adgroup") {
    return {
      tool: "tiktok_get_ad_groups",
      args: {
        advertiser_id: action.account_id,
        filters: JSON.stringify({ adgroup_ids: [objectId] }),
      },
    };
  }
  return {
    tool: "tiktok_get_campaigns",
    args: {
      advertiser_id: action.account_id,
      filters: JSON.stringify({ campaign_ids: [objectId] }),
    },
  };
}

function rowsOf(observed: unknown): Record<string, unknown>[] {
  if (typeof observed !== "object" || observed === null) return [];
  const list = (observed as { list?: unknown }).list;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

export function verifyApplied(action: AdAction, observed: unknown): VerifyOutcome {
  const { level, object_id: objectId } = action.target;
  const idField = level === "ad" ? "ad_id" : level === "adgroup" ? "adgroup_id" : "campaign_id";
  const row = rowsOf(observed).find((candidate) => candidate[idField] === objectId);
  if (!row) return { status: "unverified", note: `Không thấy ${objectId}; ${UNVERIFIED_NOTE}` };

  const field =
    action.op === "set_daily_budget"
      ? "budget"
      : action.op === "set_bid"
        ? "bid_price"
        : "operation_status";
  const current = row[field];
  if (current === action.to) {
    return { status: "verified", note: `${objectId}: ${field} đã là ${String(action.to)}` };
  }
  return {
    status: "unverified",
    note: `${objectId}: ${field} đang là ${String(current)}, kỳ vọng ${String(action.to)}; ${UNVERIFIED_NOTE}`,
  };
}
