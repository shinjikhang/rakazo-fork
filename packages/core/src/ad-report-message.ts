import { z } from "zod";

/**
 * Cấu trúc bốn phần bắt buộc của PRD cho mọi thông điệp chủ động:
 * điều gì xảy ra · vì sao quan trọng · đề xuất · nguồn đã dùng.
 *
 * Model chỉ điền các trường này; phần hiển thị do formatAdReportMessage dựng.
 * Tên chiến dịch và nội dung quảng cáo là dữ liệu từ bên ngoài, nên không cho
 * model nhả văn bản tự do vào hộp thư của khách (R-01 prompt injection).
 */
const SuggestionSchema = z
  .object({
    text: z.string().min(1),
    op: z.enum(["pause", "resume", "set_daily_budget", "set_bid"]),
    level: z.enum(["campaign", "adgroup", "ad"]),
    object_id: z.string().min(1),
    from: z.number().optional(),
    to: z.number().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.op === "set_daily_budget" || value.op === "set_bid") {
      if (value.from === undefined) {
        ctx.addIssue({ code: "custom", message: "gợi ý đổi số phải có from" });
      }
      if (value.to === undefined) {
        ctx.addIssue({ code: "custom", message: "gợi ý đổi số phải có to" });
      }
    }
  });

const AdReportMessageSchema = z.object({
  what_happened: z.string().min(1),
  why_it_matters: z.string().min(1),
  suggestions: z.array(SuggestionSchema).min(3, "cần ít nhất 3 gợi ý"),
  sources: z.array(z.string().min(1)).min(1, "phải ghi nguồn đã dùng"),
});

export type AdReportMessage = z.infer<typeof AdReportMessageSchema>;

export function parseAdReportMessage(raw: unknown): AdReportMessage {
  const parsed = AdReportMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data;
}

export function formatAdReportMessage(message: AdReportMessage): string {
  const lines = [
    message.what_happened,
    "",
    message.why_it_matters,
    "",
    ...message.suggestions.map((suggestion, index) => `${index + 1}. ${suggestion.text}`),
    "",
    `Nguồn: ${message.sources.join(", ")}`,
  ];
  return lines.join("\n");
}
