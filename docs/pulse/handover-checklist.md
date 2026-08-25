# Checklist bàn giao — vòng lặp quảng cáo TikTok

Theo Ruling R3: những bước dưới đây cần token TikTok thật, biến môi trường của `mcp_gateway`, hoặc
thao tác trên trình duyệt. Subagent đã dựng sẵn mọi file; phần còn lại là chạy và bấm.

Hai biến đường dẫn dùng suốt tài liệu — đặt theo máy của bạn:
`export MCP_GATEWAY_DIR=~/dev/cluega/mcp_gateway` và `export REPO=~/dev/cluega/rakazo`.

Thứ tự: **H1 → H3 → H5 → H6** cho đường chỉ đọc. Thêm **H2 → H2b → H4** khi bật tool ghi.

Hai cổng chặn không được bỏ qua:
- **H2** — chưa chứng minh được token có quyền ghi thì mọi bước ghi sau vô nghĩa.
- **H4** — chưa có 4 rule phê duyệt thì không được bật tool ghi, nếu không AI đổi ngân sách thật mà
  không hỏi ai (`executor.ts:793` trả "allow" khi không rule nào khớp).

---

## H1 · Bật gateway và xác minh tool (Task 1, bước 2–4)

```bash
cd "$MCP_GATEWAY_DIR"
# Cấp từ nơi lưu bí mật của đội, đừng ghi vào file trong repo:
#   CDP_BASE_URL, CDP_SERVICE_TOKEN, CDP_TENANT_ID, AD_MANAGER_BASE_URL
#   CLUEGA_TIKTOK_AD_MANAGER_API_BASE_URL, CLUEGA_TIKTOK_AD_MANAGER_REQUEST_TIMEOUT
make run
```

Rồi ở repo rakazo:

```bash
cd "$REPO"
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"

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

Đạt: cả hai in `đủ N tool bắt buộc`, thoát mã 0.
Cổng mặc định là `5235` (`configs/mcp-gateway.yaml`: `port: ${MCP_GATEWAY_PORT:5235}`); đổi bằng biến
`MCP_GATEWAY_PORT` nếu cần. Prefix lấy theo từng config: `tiktok-mcp-stdio.yaml` dùng
`/gateway/tiktok-mcp` (KHÔNG phải `/gateway/tiktok-ads-mcp`), `cluega-tiktok-ad-manager-mcp.yaml` dùng
`/gateway/cluega-tiktok-ad-manager-mcp`.

## H2 · Chứng minh token có quyền ghi (Task 1, bước 5) — **cổng chặn cả plan**

```bash
export ADGROUP_ID=...      # ad group thử nghiệm
export ADVERTISER_ID=...
node scripts/pulse/probe-write.mjs http://127.0.0.1:5235/gateway/tiktok-mcp/mcp \
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

## H3 · Đăng ký MCP server trong Rakazo

**Rakazo có HAI hệ thống đăng ký khác nhau.** Chọn nhầm là mất khả năng giới hạn tool.

| | Integrations → Tool sources | Nút "MCP servers" (góc trên phải) |
|---|---|---|
| Ghi vào bảng | `capability_installs` | `mcp_servers` + `bot_mcp_servers` |
| Phạm vi | **cả workspace** — mọi bot dùng được ngay | **từng bot**, phải tick tên bot |
| Giới hạn tool | **không có** | có cột `allowedTools`, nhưng giao diện không phơi ra |
| Kiểm URL | `assertSafeRemoteUrl` — bắt HTTPS, chặn host riêng tư | lỏng hơn |

**Dùng cái nào:**
- Server **chỉ đọc** (ad-manager, 15 tool đọc) → Integrations → Tool sources. Nhanh, không cần gán bot.
- Server **có tool ghi** (`tiktok-ads-mcp`, 249 tool gồm 4 tool đổi ngân sách) → **bắt buộc** dùng nút
  "MCP servers", rồi chạy SQL ở H4 để đặt `allowedTools`. Thêm qua Integrations là mọi bot trong
  workspace gọi được tool tiêu tiền, không có cách nào giới hạn.

### Vấn đề HTTPS

`assertSafeRemoteUrl` (`packages/adapters/src/remote-mcp.ts:116`) chặn bốn thứ: không phải HTTPS,
URL chứa credential, hostname riêng tư, IP phân giải ra dải nội bộ. `http://127.0.0.1:5235` vướng cả
hai điều đầu — **đây là chốt chặn SSRF cố ý, không phải bug.**

Cách qua: tunnel gateway ra HTTPS công khai.

```bash
ngrok http 5235      # → https://xxxx.ngrok-free.app
```

URL điền vào Rakazo: `https://xxxx.ngrok-free.app/gateway/cluega-tiktok-ad-manager-mcp/mcp`

Ba lưu ý:
- Tunnel **phơi toàn bộ 13 router của gateway ra internet**, gồm cả `tiktok-mcp` với tool tiêu tiền.
  Lớp bảo vệ duy nhất là phải biết tenant UUID — đó là bí mật qua sự mù mờ, không phải xác thực.
  **Dùng xong tắt ngay.**
- URL đổi mỗi lần restart ngrok bản free; đổi là phải sửa lại connector.
- Nếu máy đã có ngrok agent khác chạy, agent mới rơi xuống cổng quản trị 4041 chứ không phải 4040 —
  đọc nhầm API sẽ lấy phải URL của tunnel kia.

Muốn URL cố định và không phơi ra internet thì làm lối khác: thêm cờ `RAKAZO_MCP_ALLOW_HTTP_LOCALHOST`
mặc định tắt, nới `assertSafeRemoteUrl` cho loopback. Đó là sửa một chốt bảo mật, nên phải kèm test.

### Điền form

| Ô | Giá trị |
|---|---|
| Display name | `Cluega Ad Manager` |
| URL | `https://<tunnel>/gateway/cluega-tiktok-ad-manager-mcp/mcp` — **nhớ hậu tố `/mcp`** |
| Kiểu xác thực | **Bearer token** |
| Credential | JWT trần, **không** gõ thêm chữ `Bearer` (nền tảng tự thêm) |

Giao diện tự thử kết nối trước khi lưu, nên sai token hay sai URL là biết ngay.

Xác nhận đã vào đúng bảng:

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select kind, name, \"secretId\" is not null as co_token from capability_installs
   order by \"createdAt\" desc limit 3;"
```

## H4 · Rule phê duyệt + giới hạn tool — chỉ khi bật server có tool ghi

Bỏ qua mục này nếu chỉ dùng ad-manager (15 tool đọc).

**Thứ tự không được đảo.** `executor.ts:793` gọi `resolveActionApproval`, hàm này trả `"allow"` khi
không rule nào khớp, và nhánh `bypassApproval` ở dòng 891 chạy thẳng tool.

### 1. Tạo 4 rule phê duyệt

Giao diện chỉ có preset `email`/`purchase`, **không có ô cho `matchKind=tool`** — phải chèn thẳng:

```sql
INSERT INTO action_approval_rules (id,"workspaceId","createdByUserId",effect,"matchKind","matchValue")
VALUES
 (gen_random_uuid()::text,'<ws>','<user>','require_approval','tool','tiktok_update_adgroup'),
 (gen_random_uuid()::text,'<ws>','<user>','require_approval','tool','tiktok_update_ad_status'),
 (gen_random_uuid()::text,'<ws>','<user>','require_approval','tool','tiktok_update_adgroup_status'),
 (gen_random_uuid()::text,'<ws>','<user>','require_approval','tool','tiktok_update_campaign_status');
```

Ghi tên **trần**, không kèm tiền tố `mcp__` — `ruleMatches` tự khớp cả phần đuôi.

### 2. Giới hạn tool — giao diện KHÔNG làm được

`McpServersOverlay.tsx:130` gán cứng `allowAllTools: true, allowedTools: []`. Không có ô tick tool nào
trong UI. Gán `tiktok-ads-mcp` cho một bot qua giao diện nghĩa là bot đó thấy **cả 249 tool**, gồm 4
tool đổi ngân sách thật. Phải chạy SQL ngay sau khi gán, **trước khi bot chạy lần nào**:

```sql
UPDATE bot_mcp_servers SET
  "allowAllTools" = false,
  "allowedTools"  = '["tiktok_get_authorized_ad_accounts","tiktok_get_campaigns",
                      "tiktok_get_ad_groups","tiktok_get_ads",
                      "tiktok_get_ad_account_balance","tiktok_recommend_bid",
                      "tiktok_update_ad_status","tiktok_update_adgroup",
                      "tiktok_update_adgroup_status","tiktok_update_campaign_status"]'::jsonb,
  "updatedAt" = now()
WHERE "botId"    = (SELECT id FROM bots WHERE name = 'Tiktok Ads')
  AND "serverId" = (SELECT id FROM mcp_servers WHERE name ILIKE '%tiktok%');
```

Kiểm lại:

```bash
docker exec -i rakazo-pg psql -U rakazo -d rakazo \
  -v expected=10 -f /dev/stdin < scripts/pulse/assert-allowlist.sql
```

## H5 · System prompt và routine — tuỳ chọn

Bot gọi tool được mà **không cần** prompt. Prompt chỉ định hình chất lượng đầu ra và thêm rào chống
prompt injection. Muốn dùng thì dán `docs/pulse/tiktok-bot-prompt.md` vào system prompt.

**Không cần điền `advertiser_id`** — bot tự gọi `cluega_tiktok_ad_manager_advertiser_list` để lấy.

Routine tự động: cron `0 9 * * *`, timezone theo múi giờ tài khoản quảng cáo, `notify` bật, `active`
bật. Bấm chạy thử (`routines.testRun`) thay vì chờ tới 9 giờ sáng.

```bash
docker exec rakazo-pg psql -U rakazo -d rakazo -c \
  "select id, status, \"createdAt\" from runs order by \"createdAt\" desc limit 3;"
```

## H6 · Nghiệm thu (Task 9)

Theo `docs/pulse/acceptance-log.md`. Người thao tác không phải người viết mã.
Gồm cả ba phép kiểm ép lỗi: ASSERT-7 (khoá model sai, báo cáo vẫn hiện), ASSERT-4 (đòi đổi ngân sách,
phải dừng ở `waiting_input`), ASSERT-5 (đòi giảm còn 10%, phải bị chặn).
