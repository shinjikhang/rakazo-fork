# Checklist bàn giao — vòng lặp quảng cáo TikTok

Theo Ruling R3: những bước dưới đây cần token TikTok thật, biến môi trường của `mcp_gateway`, hoặc
thao tác trên trình duyệt. Subagent đã dựng sẵn mọi file; phần còn lại là chạy và bấm.

Thứ tự bắt buộc: **H1 → H2 → H2b → H3 → H4 → H5 → H6**.

Hai cổng chặn không được bỏ qua:
- **H2** — chưa chứng minh được token có quyền ghi thì mọi bước sau vô nghĩa.
- **H4** — chưa có 4 rule phê duyệt thì không được bật tool ghi, nếu không AI đổi ngân sách thật mà
  không hỏi ai (`executor.ts:793` trả "allow" khi không rule nào khớp).

---

## H1 · Bật gateway và xác minh tool (Task 1, bước 2–4)

```bash
cd /Users/khanghuynh/Documents/Dev/cluega/mcp_gateway
# Cấp từ nơi lưu bí mật của đội, đừng ghi vào file trong repo:
#   CDP_BASE_URL, CDP_SERVICE_TOKEN, CDP_TENANT_ID, AD_MANAGER_BASE_URL
#   CLUEGA_TIKTOK_AD_MANAGER_API_BASE_URL, CLUEGA_TIKTOK_AD_MANAGER_REQUEST_TIMEOUT
make run
```

Rồi ở repo rakazo:

```bash
cd /Users/khanghuynh/Documents/Dev/cluega/rakazo
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"

node scripts/pulse/probe-mcp.mjs http://127.0.0.1:8080/gateway/tiktok-ads-mcp \
  tiktok_get_authorized_ad_accounts tiktok_get_campaigns tiktok_get_ad_groups \
  tiktok_get_ads tiktok_get_ad_account_balance tiktok_recommend_bid \
  tiktok_update_ad_status tiktok_update_adgroup \
  tiktok_update_adgroup_status tiktok_update_campaign_status

node scripts/pulse/probe-mcp.mjs http://127.0.0.1:8080/gateway/cluega-tiktok-ad-manager-mcp \
  cluega_tiktok_ad_manager_report_daily_summary \
  cluega_tiktok_ad_manager_report_daily_trend \
  cluega_tiktok_ad_manager_report_period_compare \
  cluega_tiktok_ad_manager_report_creative_fatigue \
  cluega_tiktok_ad_manager_report_ctr_decay \
  cluega_tiktok_ad_manager_campaign_list \
  cluega_tiktok_ad_manager_adgroup_list \
  cluega_tiktok_ad_manager_ad_list
```

Đạt: cả hai in `đủ N tool bắt buộc`, thoát mã 0.
Cổng `8080` lấy theo `configs/mcp-gateway.yaml`; sửa lại nếu khác.

## H2 · Chứng minh token có quyền ghi (Task 1, bước 5) — **cổng chặn cả plan**

```bash
export ADGROUP_ID=...      # ad group thử nghiệm
export ADVERTISER_ID=...
node scripts/pulse/probe-write.mjs http://127.0.0.1:8080/gateway/tiktok-ads-mcp \
  "$ADGROUP_ID" "$ADVERTISER_ID"
```

Script đặt ngân sách thành **đúng giá trị nó đang có** — không đổi gì thật, nhưng đi hết đường ghi.

Đạt: in `ghi được: token có quyền ghi`.
Không đạt: dừng lại, xin token có scope ghi. Mọi việc sau đều vô nghĩa nếu không ghi được.

## H2b · Kiểm khoá bên trong `params` trên tài khoản sandbox (Ruling R7) — **làm trước khi chạm tài khoản thật**

`adActionToolCall` gói giá trị ngân sách vào trường `params` dạng chuỗi JSON:

```json
{"advertiser_id":"...","adgroup_id":"...","params":"{\"budget\":300000}"}
```

Schema của MCP khai `params` là chuỗi mờ, nên **không có cách nào chứng minh cục bộ** rằng `budget` đúng
là tên trường của TikTok `/adgroup/update/`, hay ngân sách ngày có cần `budget_mode` đi kèm. Đây là chỗ
duy nhất trong toàn bộ đường ghi mà tính đúng đắn chưa được kiểm chứng.

Trên một ad group **sandbox hoặc ngân sách nhỏ**, gọi `tiktok_update_adgroup` một lần với ngân sách
lệch đi một chút, rồi đọc lại bằng `tiktok_get_ad_groups`:

- Nếu giá trị đổi thật → tên trường đúng, xong.
- Nếu trả thành công mà giá trị không đổi → đúng loại hỏng im lặng. Lấy tên trường thật từ tài liệu
  TikTok Marketing API, sửa `adActionToolCall` trong `packages/core/src/ad-action.ts` và test kèm theo.
- Nếu báo lỗi thiếu `budget_mode` → thêm vào cùng chỗ đó.

## H3 · Tạo bot, đăng ký MCP, allowlist 14 tool đọc (Task 2, bước 3–4)

Mở http://127.0.0.1:5173

1. Tạo bot tên **TikTok Ads**.
2. Integrations → thêm hai nguồn **HTTPS MCP** trỏ tới hai URL ở H1.
3. Với mỗi nguồn: **tắt** "cho phép mọi tool", tick đúng danh sách:
   
   Từ `cluega-tiktok-ad-manager-mcp`:
   - cluega_tiktok_ad_manager_report_daily_summary
   - cluega_tiktok_ad_manager_report_daily_trend
   - cluega_tiktok_ad_manager_report_period_compare
   - cluega_tiktok_ad_manager_report_creative_fatigue
   - cluega_tiktok_ad_manager_report_ctr_decay
   - cluega_tiktok_ad_manager_campaign_list
   - cluega_tiktok_ad_manager_adgroup_list
   - cluega_tiktok_ad_manager_ad_list
   
   Từ `tiktok-ads-mcp`:
   - tiktok_get_authorized_ad_accounts
   - tiktok_get_campaigns
   - tiktok_get_ad_groups
   - tiktok_get_ads
   - tiktok_get_ad_account_balance
   - tiktok_recommend_bid

4. **Chưa bật 4 tool ghi** ở bước này.

```bash
docker exec -i rakazo-pg psql -U rakazo -d rakazo < scripts/pulse/assert-allowlist.sql
```

Đạt: `NOTICE: allowlist đúng: 14 tool, không server nào mở toàn bộ`.

## H4 · Tạo rule phê duyệt rồi mới bật tool ghi (Task 3, bước 5–6)

**Thứ tự này không được đảo.** `executor.ts:793` gọi `resolveActionApproval`, hàm này trả `"allow"`
khi không rule nào khớp, và nhánh `bypassApproval` ở dòng 891 chạy thẳng tool.

1. Giao diện → cài đặt phê duyệt → thêm **4 rule** `require_approval`, khớp theo **tool**:
   `tiktok_update_ad_status`, `tiktok_update_adgroup`, `tiktok_update_adgroup_status`,
   `tiktok_update_campaign_status`.

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select \"matchKind\", \"matchValue\", effect from action_approval_rules order by \"matchValue\";"
```

Đạt: đúng 4 hàng, `matchKind=tool`, `effect=require_approval`.

2. Chỉ khi đủ 4 hàng: thêm 4 tool ghi vào allowlist của nguồn `tiktok-ads-mcp`, sửa `14` thành `18`
   trong `scripts/pulse/assert-allowlist.sql`, chạy lại khẳng định.

Đạt: `NOTICE: allowlist đúng: 18 tool, không server nào mở toàn bộ`.

## H5 · System prompt và routine 09:00 (Task 4, bước 5–6)

1. Dán toàn bộ `docs/pulse/tiktok-bot-prompt.md` vào system prompt của bot **TikTok Ads**.
2. Tạo routine: tên `Báo cáo TikTok hôm qua`, cron `0 9 * * *`, timezone theo múi giờ tài khoản
   quảng cáo, `notify` bật, `active` bật. Prompt của routine:

```
Đọc số liệu TikTok của ngày hôm qua, so với trung bình 7 ngày và 28 ngày.
Trả lời đúng bốn phần đã quy định trong hướng dẫn của bạn.
```

3. Bấm chạy thử (`routines.testRun`), không chờ tới 9 giờ sáng.

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select id, status, \"createdAt\" from runs order by \"createdAt\" desc limit 3;"
```

Đạt: run mới kết thúc `completed`, tin nhắn của bot có đủ bốn phần.

## H6 · Nghiệm thu (Task 9)

Theo `docs/pulse/acceptance-log.md`. Người thao tác không phải người viết mã.
Gồm cả ba phép kiểm ép lỗi: ASSERT-7 (khoá model sai, báo cáo vẫn hiện), ASSERT-4 (đòi đổi ngân sách,
phải dừng ở `waiting_input`), ASSERT-5 (đòi giảm còn 10%, phải bị chặn).
