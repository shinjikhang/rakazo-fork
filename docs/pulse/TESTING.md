# Sổ tay test — vòng lặp quảng cáo TikTok

Dùng lại mỗi lần. Mọi truy vấn và lệnh trong file này đã chạy thật trên máy phát triển, tên cột đã đối
chiếu với schema, không phỏng đoán.

Khác nhau giữa ba tài liệu:

| File | Dùng khi |
|---|---|
| `handover-checklist.md` | **Một lần**, khi triển khai lần đầu — trình tự H1→H6 có cổng chặn |
| `TESTING.md` (file này) | **Nhiều lần**, tra công thức test theo thứ cần kiểm |
| `acceptance-log.md` | Khi nghiệm thu chính thức, người ngoài đội phát triển điền |

Mọi lệnh giả định:

```bash
cd /Users/khanghuynh/Documents/Dev/cluega/rakazo
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
```

---

## 0. Vừa đổi gì thì chạy gì

| Vừa đổi | Chạy |
|---|---|
| Một module trong `packages/core` | §1.1 test khu trú → §1.3 check → §1.4 lint |
| Tham số tool MCP, hoặc nghi hỏng im lặng | §2.2 dò `inputSchema` — công thức này đã bắt được 4 lỗi |
| Allowlist tool của bot | §3.1 |
| Rule phê duyệt | §3.2 rồi §5.1 |
| Prompt hoặc routine | §4.2 |
| Bất cứ thứ gì trên đường tiêu tiền | §5 trọn bộ, trên ad group ngân sách nhỏ |
| Trước khi merge | §1.2 toàn repo + §6 |

---

## 1. Test tự động

### 1.1 Khu trú — vòng lặp thường ngày

```bash
corepack pnpm vitest run packages/core/src/ad-action.test.ts        # hợp đồng AdAction
corepack pnpm vitest run packages/core/src/ad-approval.test.ts      # cổng phê duyệt
corepack pnpm vitest run packages/core/src/ad-budget-cap.test.ts    # trần ±50%
corepack pnpm vitest run packages/core/src/ad-snapshot.test.ts      # tầng chỉ số
corepack pnpm vitest run packages/core/src/ad-report-message.test.ts # thông điệp 4 phần
corepack pnpm vitest run packages/core/src/ad-verify.test.ts        # vòng lặp B
corepack pnpm vitest run packages/core/src/action-approval.test.ts  # file nền dùng chung
```

Cả gói: `corepack pnpm vitest run packages/core` — kỳ vọng **288 test xanh, 27 file**.

### 1.2 Toàn repo — trước khi merge

```bash
corepack pnpm test
```

**Kỳ vọng 2 đỏ, và hai cái đó là bình thường** — có sẵn từ trước, không do vòng lặp quảng cáo:

| Test | Vì sao đỏ |
|---|---|
| `packages/adapters/src/desktop-sandbox-write-containment.test.ts` | Lỗi có sẵn trên macOS: `assertContainedFileHandle` verify lại qua đường dẫn nên symlink bị resolve ra ngoài; nhánh `/proc/self/fd` chỉ có trên Linux |
| `packages/adapters/src/voice-http.test.ts` | Flaky, deadline 1ms; chạy riêng thì xanh |

Cách chứng minh một lỗi đỏ là có sẵn chứ không phải do mình (dùng lại được cho mọi lỗi khác):

```bash
W=/tmp/base-check
git worktree add -q --detach "$W" <commit-gốc>
for p in "" packages packages/adapters packages/core packages/contracts packages/db packages/adapter-kit; do
  ln -s "$PWD/$p/node_modules" "$W/$p/node_modules" 2>/dev/null
done
(cd "$W" && corepack pnpm vitest run <đường/dẫn/test.ts>)
git worktree remove --force "$W" && git worktree prune
```

### 1.3 Kiểm kiểu

```bash
corepack pnpm check      # tsc --noEmit từng package — kỳ vọng 20/20
```

### 1.4 Lint

```bash
corepack pnpm lint       # biome — kỳ vọng "Checked 543 files. No fixes applied."
corepack pnpm format     # sửa tự động
```

---

## 2. Test kết nối MCP

### 2.1 Tool có tới được không

```bash
node scripts/pulse/probe-mcp.mjs http://127.0.0.1:5235/gateway/tiktok-mcp/mcp \
  tiktok_get_authorized_ad_accounts tiktok_get_campaigns tiktok_get_ad_groups \
  tiktok_get_ads tiktok_get_ad_account_balance tiktok_recommend_bid \
  tiktok_update_ad_status tiktok_update_adgroup \
  tiktok_update_adgroup_status tiktok_update_campaign_status

node scripts/pulse/probe-mcp.mjs http://127.0.0.1:5235/gateway/cluega-tiktok-ad-manager-mcp/mcp \
  cluega_tiktok_ad_manager_report_daily_summary \
  cluega_tiktok_ad_manager_report_daily_trend \
  cluega_tiktok_ad_manager_report_period_compare \
  cluega_tiktok_ad_manager_report_creative_fatigue \
  cluega_tiktok_ad_manager_report_ctr_decay \
  cluega_tiktok_ad_manager_campaign_list \
  cluega_tiktok_ad_manager_adgroup_list \
  cluega_tiktok_ad_manager_ad_list
```

Đạt: in `đủ N tool bắt buộc`, thoát mã 0. Số đo thật ngày 25/08: ad-manager **15 tool**,
tiktok-mcp **249 tool**.

**URL phải có hậu tố `/mcp`.** Gateway lấy segment cuối làm endpoint
(`internal/core/server_routes.go:145-153`, hợp lệ: `sse` · `message` · `mcp`), phần trước là prefix.
Thiếu `/mcp` thì trả `404 {"error":{"message":"Invalid prefix"}}`, và `probe-mcp.mjs` sẽ in
`tổng: 0` thay vì báo lỗi rõ — thấy `tổng: 0` thì nghĩ ngay tới URL.

Gọi không kèm tên tool thì nó in toàn bộ danh sách — hữu ích khi muốn xem server phơi những gì.

### 2.2 Dò `inputSchema` của một tool — công thức quan trọng nhất trong file này

Đây là phép thử đã bắt được **bốn** lỗi hỏng im lặng: `opt_status` (không phải `operation_status`), id
phải là **chuỗi JSON** chứ không phải mảng, `budget` nằm trong `params`, và tool đọc không có `*_ids`.
Không cần token, không cần mạng, không cần gateway — gọi thẳng binary.

```bash
cd /Users/khanghuynh/Documents/Dev/cluega/mcp_gateway
TOOLS='tiktok_update_adgroup tiktok_update_ad_status'   # đổi danh sách ở đây
printf '%s\n%s\n%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"1"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| timeout 20 ./data/bin/tiktok-ads-mcp 2>/dev/null | TOOLS="$TOOLS" python3 -c "
import sys, json, os
want = set(os.environ['TOOLS'].split())
for line in sys.stdin:
    try: m = json.loads(line)
    except: continue
    if m.get('id') == 2:
        for t in m['result']['tools']:
            if t['name'] in want:
                s = t.get('inputSchema', {})
                print('==', t['name'])
                print('   required:', s.get('required'))
                for k, v in (s.get('properties') or {}).items():
                    print(f'   {k}: {v.get(\"type\")} — {(v.get(\"description\") or \"\")[:110]}')
"
```

Đổi `./data/bin/tiktok-ads-mcp` thành `./data/bin/cluega-tiktok-ad-manager-mcp` để dò server còn lại.
Danh sách binary có sẵn: `ls data/bin`.

**Đọc kỹ cột `type`.** Một tham số khai `"string"` mà bạn truyền mảng thì TikTok bỏ qua, trả thành
công, và không đổi gì. Đó là cách hỏng tệ nhất vì nó im lặng.

### 2.3 Gọi thử một tool — phép thử chứng minh đường dữ liệu thông

**`tools/list` chạy được mà không cần auth, `tools/call` thì không.** Nên `probe-mcp.mjs` báo xanh
không có nghĩa là lấy được dữ liệu. Luôn gọi thử ít nhất một tool trước khi tin là xong.

```bash
node scripts/pulse/call-tool.mjs \
  http://127.0.0.1:5235/gateway/cluega-tiktok-ad-manager-mcp/mcp \
  cluega_tiktok_ad_manager_advertiser_list '{"pagesize":10}' \
  -H "Authorization: Bearer $CLUEGA_TOKEN"
```

Thoát 0 là gọi được. Thoát 1 kèm `isError: true` là tool từ chối — đọc `message` trong đó.

Hai thông báo đã gặp thật, cả hai đều là **thiếu token**, không phải lỗi cấu hình:

| Server | Thông báo | Cách xử lý — đã kiểm thật |
|---|---|---|
| tiktok-mcp | `tenant context is required (missing or invalid forwarded auth token)` | **chỉ cần header `x-tenant-id: <uuid tenant>`**, KHÔNG cần JWT. Thông báo nói "auth token" nên dễ hiểu sai |
| tiktok-mcp | `no active TikTok connection for this tenant` | qua được auth rồi; tenant chưa nối tài khoản quảng cáo TikTok — xem ghi chú dưới |
| ad-manager | `missing Authorization: forward user Bearer token or set CLUEGA_TIKTOK_AD_MANAGER_ACCESS_TOKEN for local dev only` | cần Bearer JWT của CDP. Nhưng service đích (`CLUEGA_TIKTOK_AD_MANAGER_API_BASE_URL`, mặc định `localhost:8896` = `cluega_ad_manager`, repo ngoài) phải đang chạy |

Gateway đã chuyển tiếp sẵn cả `authorization` và `x-tenant-id`
(`configs/mcp-gateway.yaml`: `FORWARD_ALLOW_HEADERS` mặc định), không cần sửa gì.

Khi đăng ký MCP server trong Rakazo thì đặt header ngay ở đó (`mcp_servers.headers`) — với tiktok-mcp
là `x-tenant-id`, với ad-manager là `Authorization: Bearer <jwt>`.

**Về "no active TikTok connection":** kết nối quảng cáo TikTok không nằm trong DB `cluega_cdp`. Toàn
bộ DB đó chỉ có `tiktok_advertiser_bindings` (rỗng), không có bảng connection/token nào cho quảng cáo
— khác với Google (`google_ads_connections` + `google_ads_advertisers`) và Facebook
(`facebook_ad_accounts`). Bảng `tiktok_connections` có dữ liệu nhưng là Login Kit của creator
(`tiktok_open_id`, `avatar_url`, `granted_scopes`), không phải tài khoản quảng cáo. Theo
`mcp_gateway/.env.example`, token quảng cáo "sourced from BE IM service" ở bảng
`integration_tiktok_tokens` — và các container IM (`cluega_im_postgres`, `cluega_im_manage_db`) đang
tắt. Muốn có dữ liệu thì hoặc nối tài khoản quảng cáo qua UI Integrations của CDP, hoặc bật service IM,
hoặc trỏ sang staging.

### 2.3b Chuỗi xác thực service-to-service — đã truy hết ngày 25/08

Ghi lại toàn bộ để lần sau không phải truy lại. Chuỗi thật:

```
Rakazo bot
  → mcp_gateway :5235          header x-tenant-id  (KHÔNG cần JWT)
  → tiktok-ads-mcp
  → cdp_backend :8080          header X-Internal-Key = CDP_INTERNAL_API_KEY
       GET /internal/v1/integrations/tiktok/tenants/{tenant}/connections/active/token     → 200 ✅
       GET /internal/v1/integrations/tiktok/tenants/{tenant}/connections/active/metadata  → 404 ❌
  → giải mã token trong tenant_<id>.tiktok_connections
```

**Khoá dùng chung.** `cdp_backend` bảo vệ `/internal/v1/*` bằng một shared secret
(`config.go:1565`: *"Env: `CDP_INTERNAL_API_KEY`"*), nhận qua header `X-Internal-Key` hoặc
`Authorization: Bearer`. `mcp_gateway` gửi nó dưới tên `CDP_SERVICE_TOKEN`. **Hai biến phải cùng giá
trị**, và cả hai service đọc `.env` lúc khởi động (`godotenv`), nên đổi khoá là phải restart cả hai.

Middleware từ chối khi khoá rỗng (`service_auth.go:46`), và log lúc boot cho biết đã nạp chưa:

```
service auth: internal key internal_key_configured=true
```

**Lỗi đang chặn (chưa sửa được từ phía Rakazo).** `tiktok-ads-mcp` gọi tiếp endpoint `metadata` để lấy
danh sách advertiser. Endpoint đó **không tồn tại trong `cdp_backend`** — router chỉ đăng ký các route
`/token` và `/mark-expired` cho TikTok. Mà `internal/cdp/client.go:452` của MCP lại dịch 404 thành:

```go
// 404/410 means no active TikTok connection exists for this tenant.
case se.Code == http.StatusNotFound || se.Code == http.StatusGone:
    return nil, fmt.Errorf("%w", domain.ErrNoActiveConnection)
```

Nên thông báo hiện ra là `no active TikTok connection for this tenant` — **sai hoàn toàn**: connection
vẫn tốt (4 hàng `active`, token hạn 2027, endpoint `/token` trả 200). Đừng đi tìm connection khi thấy
thông báo này; hãy xem log của `cdp_backend` để biết endpoint nào 404.

Đáng chú ý: **Facebook đã có** `/internal/v1/integrations/facebook/.../connections/active/metadata`
kèm handler `facebook_mcp_compat`. Lớp tương thích MCP đã làm cho Facebook nhưng chưa làm cho TikTok.
Đây là việc của `cdp_backend` (Kin-CG05), không phải của Rakazo.

**Cái gì CHẠY ĐƯỢC hôm nay — đã kiểm thật 25/08.** Chỉ khâu tự dò advertiser hỏng; mọi thứ khác thông,
kể cả gọi tới API TikTok và lấy về số liệu chi tiêu thật. Đi vòng bằng cách đưa thẳng `advertiser_id`:

```bash
TEN=<tenant uuid>            # lấy từ CDP_TENANT_ID trong mcp_gateway/.env
U=http://127.0.0.1:5235/gateway/tiktok-mcp/mcp

# 1. Business center — chỉ cần token, KHÔNG qua metadata
node scripts/pulse/call-tool.mjs "$U" tiktok_get_business_centers '{}' -H "x-tenant-id: $TEN"

# 2. Advertiser dưới BC. Chú ý asset_type nằm trong params dạng chuỗi JSON,
#    đúng quy ước mà các tool ghi cũng dùng
node scripts/pulse/call-tool.mjs "$U" tiktok_get_business_center_assets \
  '{"bc_id":"<bc_id>","page_size":10,"params":"{\"asset_type\":\"ADVERTISER\"}"}' \
  -H "x-tenant-id: $TEN"

# 3. Chiến dịch
node scripts/pulse/call-tool.mjs "$U" tiktok_get_campaigns \
  '{"advertiser_id":"<adv_id>","page_size":5}' -H "x-tenant-id: $TEN"

# 4. Báo cáo hiệu suất — đúng thứ yêu cầu 1 của PM cần
node scripts/pulse/call-tool.mjs "$U" tiktok_get_reports \
  '{"advertiser_id":"<adv_id>","dimensions":"[\"campaign_id\"]",
    "metrics":"[\"spend\",\"impressions\",\"clicks\",\"ctr\",\"cpc\",\"conversion\"]",
    "start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","page_size":5}' \
  -H "x-tenant-id: $TEN"
```

Cả bốn đều trả `success: true` với dữ liệu thật. `dimensions`, `metrics`, `filters` đều là **chuỗi
JSON**, không phải mảng — cùng cái bẫy `type: "string"` đã gặp ở tool ghi.

**Hệ quả cho mức 1:** bot đọc được báo cáo TikTok ngay hôm nay, miễn là `advertiser_id` được đưa vào
tường minh — đặt trong system prompt của bot, hoặc để khách nói ra. Chỉ mất khả năng bot tự liệt kê
advertiser cho tới khi cdp có endpoint `metadata`.

> **Đây là đường tạm, không phải thiết kế.** Luồng chính để lấy báo cáo là
> `cluega-tiktok-ad-manager-mcp` (spec §4: đã tổng hợp sẵn, rẻ, không đụng hạn mức TikTok). Nó đang
> tắc ở local vì service `cluega_ad_manager` cổng 8896 chưa chạy. Khi nó sống lại thì bỏ `tiktok_get_reports`
> khỏi đường lấy báo cáo và trả nó về đúng vai trò kiểm chứng. Xem `STATUS.md` mục *Luồng lấy báo cáo*.

**Cách chẩn đoán nhanh** — chạy lệnh gọi tool rồi soi log cdp trong cùng khoảng thời gian:

```bash
L=<file log của cdp_backend>
BEFORE=$(wc -l < "$L")
node scripts/pulse/call-tool.mjs http://127.0.0.1:5235/gateway/tiktok-mcp/mcp \
  tiktok_get_authorized_ad_accounts '{"page_size":5}' -H "x-tenant-id: $TEN" >/dev/null 2>&1
sleep 2
tail -n +$((BEFORE+1)) "$L" | grep -iE "internal|tiktok|401|404"
```

Không có dòng nào nghĩa là MCP chưa hề gọi tới cdp. Có 401 là sai khoá. Có 404 là thiếu route.

### 2.3c Luồng chính — `cluega_ad_manager` ở cổng 8896

Chạy thật 25/08. Service **không nằm trong `~/Documents/Dev/cluega/`** mà ở
`~/Documents/Dev/cluega_ad_manager_golang`.

**Cảnh báo trước khi khởi động: nó chạy migration vô điều kiện.**
`internal/infrastructure/bootstrap/database.go:20` gọi `migrations.Run` không có cờ nào tắt được, và
11 file SQL trong đó chứa **6 `DELETE`, 24 `UPDATE`, 7 `DROP`** — không phải no-op. Trỏ vào DB dev
dùng chung mà để nó chạy là sửa dữ liệu của người khác. Comment đầu file nói thẳng: *"Run 在服务启动时
无条件执行"*. Dòng log `[migrate] schema up to date` in ra ở cuối **vô điều kiện**, không phải kết quả
kiểm tra — đừng tin nó.

Cách chạy an toàn:

```bash
cd ~/Documents/Dev/cluega_ad_manager_golang

# 1. Override DB bằng config.local.toml (đã bị .gitignore, merge đè lên config.toml)
cat > config.local.toml <<'EOF'
[psql]
host = "<host dev>"
port = 5432
user = "<user>"
pass = "<pass>"
name = "cdp_cluega_ad_manager"
ssl_mode = "require"
EOF
chmod 600 config.local.toml

# 2. Tắt migration — SỬA TẠM, hoàn tác trước khi commit
#    comment khối migrations.Run trong internal/infrastructure/bootstrap/database.go
#    hoàn tác: git checkout -- internal/infrastructure/bootstrap/database.go

# 3. Chạy
go run ./cmd/server
```

Xác nhận migration KHÔNG chạy: `grep -c "\[migrate\]" <log>` phải ra **0**.

**Xác thực.** ad_manager kiểm JWT HMAC, khoá và issuer nằm ngay trong `config.toml` mục `[jwt]`
(`mode = "hmac"`, `key` là hex, `issuer`). Claim cần: `tenant_id`, `org_role`, `iss`, `sub`, `exp`.
Ký bằng Python là đủ — xem `[jwt]` để lấy khoá, decode hex thành bytes, ký HS256.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $JWT" \
  "http://localhost:8896/internal/mcp/advertiser/list?pagesize=5"     # mong đợi 200
```

Rồi qua MCP:

```bash
node scripts/pulse/call-tool.mjs \
  http://127.0.0.1:5235/gateway/cluega-tiktok-ad-manager-mcp/mcp \
  cluega_tiktok_ad_manager_report_daily_summary \
  '{"advertiser_id":"<adv>","start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD",
    "report_level":"AUCTION_ADVERTISER"}' \
  -H "Authorization: Bearer $JWT"
```

**PHẢI đặt `debug = false`.** `config.toml` mặc định `debug = true`, và khi đó
`routes/internal.go:20` cài một middleware **bỏ qua JWT** rồi ép:

```go
c.Set("uuid", "debug-user")
c.Set("tenant_id", "debug-tenant")   // tenant không tồn tại
```

Hệ quả: mọi truy vấn lọc theo tenant trả **0 dòng**, trong khi API vẫn trả `success: true`, HTTP 200 và
envelope đúng cấu trúc. Không một thông báo lỗi nào. Đây là kiểu hỏng khó thấy nhất — dễ tưởng là
"chưa có dữ liệu" và đi tìm nhầm chỗ hàng giờ.

Đặt `debug = false` trong `config.local.toml` thì `InternalAuth()` đọc tenant thật từ JWT. Kiểm chứng
25/08: cùng một lời gọi, trước `total_records: 0`, sau `spend: 2678.28 · impressions: 500143 ·
clicks: 60340 · total_records: 4`.

**Dấu hiệu nhận biết:** API trả 200 và `success: true` nhưng `total_records: 0` với advertiser bạn
biết chắc có số liệu → kiểm `debug` trước tiên, đừng đi đào dữ liệu.

**Tác dụng phụ phải biết:** khởi động ad_manager sẽ bật các worker Asynq chạy theo lịch, và chúng
**ghi vào DB dev** khi đồng bộ thành công. Ở lần chạy 25/08 chúng thất bại ở bước credential nên chưa
ghi, nhưng đừng để service chạy nền quên tắt.

### 2.4 Token có quyền ghi không

```bash
export ADGROUP_ID=...  ADVERTISER_ID=...      # ad group thử nghiệm, ngân sách nhỏ
node scripts/pulse/probe-write.mjs http://127.0.0.1:5235/gateway/tiktok-mcp/mcp \
  "$ADGROUP_ID" "$ADVERTISER_ID"
```

Script đặt ngân sách thành **đúng giá trị nó đang có** — đi hết đường ghi mà không đổi gì. Đạt: in
`ghi được: token có quyền ghi`.

---

## 3. Khẳng định trên cơ sở dữ liệu

### 3.1 Allowlist tool

```bash
# Mặc định: bot tên 'TikTok Ads', kỳ vọng 14 tool (chưa bật tool ghi)
docker exec -i rakazo-pg psql -U rakazo -d rakazo < scripts/pulse/assert-allowlist.sql

# Sau khi bật 4 tool ghi:
docker exec -i rakazo-pg psql -U rakazo -d rakazo \
  -v expected=18 -f /dev/stdin < scripts/pulse/assert-allowlist.sql

# Bot khác:
docker exec -i rakazo-pg psql -U rakazo -d rakazo \
  -v bot="'Meta Ads'" -f /dev/stdin < scripts/pulse/assert-allowlist.sql
```

Script so **tập hợp** tên tool, không chỉ đếm — nên 14 tool sai danh sách vẫn bị bắt.

### 3.2 Rule phê duyệt

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select \"matchKind\", \"matchValue\", effect from action_approval_rules order by \"matchValue\";"
```

Đạt: đúng 4 hàng, `matchKind=tool`, `effect=require_approval`, giá trị là bốn tên tool ghi **dạng
trần** (không có tiền tố `mcp__`) — `ruleMatches` tự khớp cả phần đuôi.

Thêm rule (giao diện web không có ô cho `matchKind=tool`):

```sql
INSERT INTO action_approval_rules (id,"workspaceId","createdByUserId",effect,"matchKind","matchValue")
VALUES
 (gen_random_uuid()::text,'<ws>','<user>','require_approval','tool','tiktok_update_adgroup'),
 (gen_random_uuid()::text,'<ws>','<user>','require_approval','tool','tiktok_update_ad_status'),
 (gen_random_uuid()::text,'<ws>','<user>','require_approval','tool','tiktok_update_adgroup_status'),
 (gen_random_uuid()::text,'<ws>','<user>','require_approval','tool','tiktok_update_campaign_status');
```

Lấy `<ws>` và `<user>`:

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select o.id as workspace, u.id as usr, u.email from organization o, \"user\" u limit 5;"
```

### 3.3 Run vừa chạy ra sao

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select id, status, trigger, \"modelId\", error,
          round(extract(epoch from (\"completedAt\" - \"startedAt\"))::numeric,1) as giay
   from runs order by \"createdAt\" desc limit 5;"
```

### 3.4 Bot đã gọi tool nào

Đây là cách chắc nhất để biết bot *thật sự* làm gì, thay vì tin vào lời nó nói:

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select \"createdAt\", left(payload::text, 160) from events
   where type = 'agent.tool.called' order by \"createdAt\" desc limit 20;"
```

### 3.5 Lệnh ghi ra ngoài — bảng quan trọng nhất khi test đường tiêu tiền

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select status, kind, left(request::text,120) as yeu_cau, left(result::text,80) as ket_qua,
          round(extract(epoch from (\"updatedAt\" - \"createdAt\"))::numeric,1) as giay
   from external_effects order by \"createdAt\" desc limit 10;"
```

`kind` là tên tool **có tiền tố** (`mcp__tiktok-mcp__tiktok_update_adgroup`). `status` đi qua
`intended` → `completed`. Một lệnh ghi còn ở `intended` nghĩa là chưa chạy.

---

## 4. Test hành vi của bot

### 4.1 Đường đọc — làm trước, an toàn nhất

Chat thẳng với bot, không cần routine:

> Cho tôi xem chi tiêu TikTok hôm qua, so với trung bình 7 ngày.

Rồi §3.4 để xem nó gọi đúng tool đọc, và đối chiếu số với TikTok Ads Manager. Bốc 3 chiến dịch, lệch
phải dưới 1%.

### 4.2 Routine

Tạo routine cron `0 9 * * *`, timezone theo tài khoản quảng cáo, rồi **bấm chạy thử** thay vì chờ sáng
(`routines.testRun`). Kiểm bằng §3.3.

Test lịch mà không chờ: đặt tạm cron thành phút kế tiếp, xem worker có nhặt không, rồi đổi lại.

### 4.3 Đường ghi

Yêu cầu bot đổi ngân sách một ad group nhỏ. Chuỗi kỳ vọng:

1. Run chuyển `waiting_input` (§3.3)
2. Thread hiện thẻ chờ duyệt
3. `external_effects` có hàng mới, `status` chưa phải `completed` (§3.5)
4. Bấm duyệt → `status` thành `completed`
5. Trong 5 phút, TikTok Ads Manager thấy giá trị mới

**Nếu bước 5 không đổi mà bước 4 báo thành công** → khoá bên trong `params` sai tên. Quay lại §2.2 lấy
tên thật, sửa `adActionToolCall` trong `packages/core/src/ad-action.ts` và test kèm theo.

---

## 5. Test ép lỗi

Ba phép này kiểm rào an toàn có thật sự chặn hay không. Làm sau mỗi lần đổi rule hoặc đổi guard.

### 5.1 ASSERT-4 — không duyệt thì không ghi

Yêu cầu bot đổi ngân sách. Kỳ vọng: run dừng ở `waiting_input`, và **chưa** có lệnh ghi nào tới TikTok.

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select status, kind from external_effects order by \"createdAt\" desc limit 3;"
```

Hàng mới nhất phải chưa `completed`. Nếu nó đã `completed` mà bạn chưa bấm gì → **rule không khớp**,
kiểm §3.2 ngay và dừng test đường ghi.

### 5.2 ASSERT-5 — trần ±50%

Yêu cầu bot giảm ngân sách xuống còn 10% giá trị hiện tại.

Lưu ý: hiện `assertBudgetChangeWithinCap` **chưa nối vào executor**, nên phép này chỉ kiểm được model
có tự tuân prompt hay không, chưa phải rào cứng. Rào cứng có sau khi làm plan nối executor. Test cứng
ngay bây giờ thì dùng §1.1 với `ad-budget-cap.test.ts`.

### 5.3 ASSERT-7 — model hỏng thì báo cáo vẫn còn

Đặt tạm khoá model sai, chạy `routines.testRun`, rồi mở dashboard.

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select id, status, error from runs order by \"createdAt\" desc limit 1;"
```

Kỳ vọng: run lỗi, nhưng trang báo cáo vẫn hiển thị đủ số liệu. Khôi phục khoá sau khi kiểm.

---

## 6. Đo độ trễ (ASSERT-8)

Hai ngưỡng: kéo dữ liệu một tài khoản P95 dưới 3 phút; từ lúc bấm nút tới lúc TikTok đổi P95 dưới 60
giây. Cần ~20 lượt để P95 có nghĩa.

```bash
# P95 thời lượng run
docker exec rakazo-pg psql -U rakazo -d rakazo -tAc \
 "select round(extract(epoch from (\"completedAt\" - \"startedAt\"))::numeric,1)
  from runs where \"completedAt\" is not null order by \"createdAt\" desc limit 20;" \
| sort -n | awk 'NF{v[++n]=$1} END{if(n)print "P95 run:", v[int(n*0.95+0.5)], "giây (trần 180)"}'

# P95 thời lượng một lệnh ghi ra ngoài
docker exec rakazo-pg psql -U rakazo -d rakazo -tAc \
 "select round(extract(epoch from (\"updatedAt\" - \"createdAt\"))::numeric,1)
  from external_effects where status = 'completed' order by \"createdAt\" desc limit 20;" \
| sort -n | awk 'NF{v[++n]=$1} END{if(n)print "P95 ghi:", v[int(n*0.95+0.5)], "giây (trần 60)"}'
```

Truy vấn trong `docs/superpowers/plans/2026-08-25-pulse-ad-loop.md` Task 9 bước 5 dùng cột
`approvedAt`/`completedAt` của `external_effects` — **hai cột đó không tồn tại**. Dùng bản trên.

---

## 7. Nghiệm thu chính thức

`acceptance-log.md`, 8 tình huống, do người **không phải** người viết mã thao tác, phán định có/không.
Chạy đủ một lượt mỗi ngày kể từ mốc M2. Ghi cả hai số P95 ở §6 vào cuối bảng.

---

## 8. Luật an toàn khi test trên tài khoản thật

1. Ad group ngân sách nhỏ, hoặc chiến dịch đã tắt. Không bao giờ test trên chiến dịch đang chạy chính.
2. §2.3 trước §4.3 — chứng minh quyền ghi bằng phép ghi vô hại trước khi ghi thật.
3. Ghi lại giá trị cũ trước khi bấm. Hiện `from` chưa được ép bắt buộc trong đường chạy thật, nên bản
   ghi để hoàn tác là do bạn tự giữ.
4. Sau mỗi lệnh ghi, đối chiếu TikTok Ads Manager bằng mắt. Đừng tin `status = completed` một mình.
5. Đừng dùng `pnpm compose:down` — script đó có `-v`, xoá volume Postgres.

---

## 9. Triệu chứng → nguyên nhân

| Triệu chứng | Nghĩ tới |
|---|---|
| `probe-mcp` không kết nối được | Gateway chưa lên, hoặc sai cổng (mặc định 5235), hoặc sai prefix (`/gateway/tiktok-mcp`) |
| `probe-mcp` in `thiếu: ...` | Config chưa nạp server đó, hoặc binary trong `data/bin` thiếu |
| Bot không thấy tool nào | `allowedTools` rỗng mà `allowAllTools=false` — kiểm §3.1 |
| Bot ghi được mà không hỏi ai | **Rule không khớp.** Kiểm §3.2. Đây là lỗi M1, tên tool tới executor có tiền tố `mcp__<slug>__` |
| Duyệt xong, `status=completed`, TikTok không đổi | Khoá trong `params` sai tên — §2.2 |
| Kiểm chứng luôn trả `unverified` | Tên trường trong response, hoặc `filters` sai khoá — §2.2 rồi đọc `ad-verify.ts` |
| Bot trả lời `invalid x-api-key` | Khoá model sai; kiểm `user_model_credentials` và bản mã trong `secrets` |
| `pnpm install` báo lỗi engine | Node sai phiên bản; phải là v24.18.0 |
| Run kẹt ở `waiting_input` mãi | Đang chờ người duyệt — đúng như thiết kế, không phải lỗi |
| Test đỏ ở `desktop-sandbox` hoặc `voice-http` | Có sẵn từ trước, xem §1.2 |
