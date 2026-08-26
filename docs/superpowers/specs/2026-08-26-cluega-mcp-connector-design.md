# Một connector duy nhất: Cluega MCP — thiết kế

Ngày: 2026-08-26 · Trạng thái: chờ duyệt · Người viết: Khang Huynh

Liên quan: `2026-08-25-pulse-agent-loop-design.md` (vòng lặp quảng cáo), `docs/pulse/TESTING.md`
(những cái bẫy đã gặp khi nối tay).

## 1. Vấn đề

Nối Rakazo với `mcp_gateway` bằng tay lộ ra một bệnh không nằm ở chỗ nào cụ thể: **một danh tính đi
qua năm ranh giới bằng năm định dạng khác nhau.**

| Chặng | Cơ chế hiện tại |
|---|---|
| Rakazo → gateway | header tĩnh cấu hình sẵn (JWT tự ký, hoặc `x-tenant-id` trần) |
| gateway → binary MCP | chuyển tiếp header |
| MCP → `cdp_backend` | `X-Internal-Key` — bí mật chung, không mang tenant |
| MCP → `cluega_ad_manager` | JWT HMAC, issuer riêng, khoá riêng |
| `cdp_backend` → ad_manager | subsystem callback ký riêng |

Mỗi chặng mới là một cơ chế mới. Hệ quả đo được: một buổi tối nối tay vấp bốn lỗi mà cả bốn đều **trả
`success: true`** — sai prefix URL, thiếu hậu tố `/mcp`, hai khoá service lệch nhau, và `debug=true` ép
tenant giả. Người mới phải học năm cơ chế trước khi sửa được lỗi đầu tiên.

Thêm một vấn đề cấu trúc: credential nằm ở `mcp_servers` (phạm vi workspace), nên **mỗi tenant cần một
hàng server riêng** — N hàng, N credential, N chỗ xoay vòng.

## 2. Sáu quyết định

**D1 — Một endpoint MCP gộp ở gateway, prefix cũ giữ nguyên.**
Thêm `/gateway/cluega/mcp` hợp nhất các server upstream. Không đổi, không xoá prefix nào đang có:
`ai_agent` nối thẳng từng prefix (`campaign_scan.py:137`, `plan_constants.py:74`) và không được phép vỡ.
Rakazo chỉ biết một URL, vĩnh viễn — thêm Meta hay Google về sau **không đụng Rakazo**.

**D2 — Danh tính đi theo từng lời gọi, không nằm trong cấu hình.**
Rakazo xác thực với gateway một lần như một service, rồi mỗi lời gọi tool mang `x-tenant-id` và
`x-user-id` lấy từ `AdapterContext` của run. Một hàng đăng ký cho mọi tenant. Không token nào để hết
hạn; thu hồi ở CDP có hiệu lực tức thì.

Gateway đã cho phép sẵn hai header đó: `FORWARD_ALLOW_HEADERS` mặc định gồm
`authorization, x-tenant-id, x-user-id, ...` (`configs/mcp-gateway.yaml`).

**D3 — Dùng đường `mcp_servers`, không dùng `capability_installs`.**
`InstalledConnectorProvider` lọc **chỉ theo `workspaceId`** (`installed-connectors.ts:125`) và **không
có `allowedTools`**. Với server chỉ đọc thì tiện; với tool ghi thì đó là mở tool tiêu tiền cho mọi bot
trong workspace, không có cách chặn. `mcp_servers` + `bot_mcp_servers` cho cách ly theo bot và
allowlist theo bot.

**D4 — Không đổi tên gì ở gateway hay ad_manager.**
Tiền tố tên tool mà model nhìn thấy là `mcp__<slug>__<tool>`, trong đó `slug` là cột của
**`mcp_servers` bên Rakazo** (`mcp-connector.ts:64`), do người đăng ký tự đặt
(`domain.ts:277`: `^[a-z0-9][a-z0-9_-]{0,63}$`). Nó độc lập với prefix gateway.

Đặt `slug = "cluega"` là đủ. Đo thật 26/08 bằng cách gọi `tools/list` lên từng binary:

| Server | Số tool | Tên dài nhất | Cộng `mcp__cluega__` |
|---|---|---|---|
| `tiktok-ads-mcp` | 246 | `tiktok_get_smart_plus_material_report_breakdown` (47) | **60** |
| `cluega-tiktok-ad-manager-mcp` | 12 | `cluega_tiktok_ad_manager_report_creative_fatigue` (48) | **61** |

Cả hai dưới trần `MAX_AGENT_TOOL_NAME_LENGTH = 64` (`pi-runtime.ts:42`). Không tên nào bị băm.

**D5 — v1 không lọc tool theo nền tảng tenant đã nối.**
Lọc như vậy đòi gateway hỏi CDP xem tenant có gì — thêm một phụ thuộc. v1 trả hợp nhất đầy đủ; bộ lọc
thật là `allowedTools` theo từng bot bên Rakazo. Thêm lọc theo tenant khi có khách thật.

**D6 — v1 không dùng `/internal/select`.**
Consumer duy nhất của nó đã bỏ dùng. `ai_agent/app/routers/chat_helpers/tool_select.py:112` ghi rõ hai
tầng thu hẹp đều bị gỡ — keyword matcher (267 → 171) và `/internal/select` (171 → 138) — vì *"Neither
helped the index pick better"*. Không xây gì lên trên một endpoint mà chủ của nó đã rời bỏ.

Rakazo **không có bài toán mà `/internal/select` sinh ra để giải**: `ai_agent` là một agent đối diện mọi
nền tảng nên phải xếp hạng ngữ nghĩa trên 267 tool; Rakazo là một bot cho một connector, mỗi bot có
`allowedTools` tĩnh. Mô hình "1 connector = 1 bot" **loại bỏ** bài toán thay vì giải nó.

## 3. Ranh giới

```
Rakazo (bot service, không có đăng nhập riêng)
  │  1 service credential  +  x-tenant-id / x-user-id theo từng lời gọi
  ▼
mcp_gateway  /gateway/cluega/mcp          ← endpoint MỚI
  │  hợp nhất tools/list · định tuyến tools/call theo tiền tố
  ├─→ /gateway/tiktok-mcp                 ← prefix cũ, ai_agent vẫn dùng
  ├─→ /gateway/cluega-tiktok-ad-manager-mcp
  └─→ /gateway/facebook-mcp · google-ads-mcp · …
```

Rakazo giữ `tenant_id`/`user_id` của CDP trong `workspaceId`/`userId` — nó không phát hành danh tính,
chỉ mang theo.

## 4. Hợp đồng

### 4.1 `tools/list` — hợp nhất

Fan-out tới các upstream trong `platformToolRoutes` (`internal/core/tool_prefix.go`) cộng
`cluega-tiktok-ad-manager-mcp`, gọi `tools/list` từng cái, gộp kết quả.

**Bắt buộc có cache.** Gọi 13 upstream mỗi lần bot khởi động là chậm và dễ vỡ — đây là rủi ro lớn nhất
của thiết kế này. Khoá cache là tập upstream (v1 chưa theo tenant vì D5), **TTL 60 giây**, làm mới nền
chứ không chặn request đang chờ.

**Suy giảm từng phần.** Một upstream chết thì bỏ tool của nó, không làm hỏng cả danh sách. Rakazo cũng
xử lý đúng vậy ở `mcp-connector.ts:71` với ghi chú *"A single unavailable server must not hide tools
from other connectors"* — giữ cùng ngữ nghĩa để hành vi nhất quán hai bên.

**Va chạm tên — sẽ xảy ra chắc chắn, không phải giả thuyết.** Đo 26/08: tool *của các server* không
trùng nhau (246 + 12 + 110 + 3 = 371 tên, tất cả duy nhất). **Nhưng gateway tự chèn ba tool của nó vào
mọi server**: `ask_clarification`, `recommend_ad_creatives`, `search_knowledge_base` — binary ad-manager
có 12 tool, qua gateway thành 15; binary utm có 3, qua gateway thành 6.

Hợp nhất ngây thơ sẽ nhân ba tool này lên 13 lần. Router gộp phải **khử trùng lặp**: tool cấp gateway
xuất hiện đúng một lần, tool cấp server giữ nguyên. Nếu phát hiện trùng ngoài ba cái đó, log và giữ cái
đầu tiên theo thứ tự upstream xác định — im lặng ghi đè là loại lỗi khó truy nhất.

### 4.2 `tools/call` — định tuyến theo tiền tố

Tra `platformToolRoutes` bằng tiền tố tên tool, chuyển tiếp nguyên vẹn kèm phong bì danh tính.

Bảng này **đã tồn tại và đang được dùng**. Router gộp phải dùng chung đúng bảng đó, không tạo bản sao —
hiện đã có hai bản (Go và Python `ai_agent/app/routers/chat_helpers/tool_names.py`), đừng thêm bản thứ ba.

### 4.3 Phong bì danh tính

Gateway dựng `__forwardHeaders` **từ request đã xác thực**, và **loại bỏ** bất cứ thứ gì client nhét vào
tham số tool. Đây là hành vi cố ý, `forward_stdio.go:32`:

> *"The container is SERVER-OWNED. Tool arguments reach here from the model and from whatever client
> drove the MCP session, so a container found in them is discarded and rebuilt from the authenticated
> request — never merged, never preserved."*

Router gộp **giữ nguyên** ngữ nghĩa này. Danh tính chỉ đi bằng header HTTP.

### 4.4 Phía Rakazo

`McpConnector.execute()` và `discoverTools()` đều nhận `AdapterContext` mang `workspaceId`, `userId`,
`botId` (`adapter-kit/src/types.ts:6-8`). Thêm hai header đó vào `requestInit.headers` của lời gọi
outbound. Đây là thay đổi duy nhất bên Rakazo.

## 5. Mô hình tin cậy

Rakazo xác thực với gateway **một lần như một service**; gateway **tin tenant mà Rakazo khai**. Đây là
mô hình trusted subsystem.

Nói thẳng điểm yếu: Rakazo lỗi hoặc bị chiếm thì rò chéo tenant. Nhưng đây **không phải điều mới** —
`X-Internal-Key` hiện tại đã cho phép bất kỳ ai giữ khoá hỏi CDP token của bất kỳ tenant nào. Thiết kế
này không làm xấu đi; nó làm điều đó hiện ra rõ ràng thay vì ẩn trong một bí mật chung.

Siết thêm khi có khách thật: gateway kiểm tenant được khai có nằm trong phạm vi mà service credential
được cấp không. Ngoài phạm vi v1.

**Rào đường tiền vẫn nằm ở Rakazo**, không chuyển đi đâu: `allowedTools` chặn ở mức bot, và
`resolveActionApproval` chặn trước khi thực thi. Bot đọc báo cáo đơn giản là **không có** tool ghi
trong danh sách — khác hẳn "có nhưng mong model không gọi".

Ghi nhận từ hệ khác, để đối chiếu chứ không phải phạm vi của spec này: `ai_agent` sau khi gỡ hai tầng
lọc đã tự ghi *"Write tools can therefore now be OFFERED on a read turn"* (`tool_select.py:120`). Nên
báo Jimmy-CG08, nhất là khi Rakazo sắp bật tool ghi trên cùng gateway.

## 6. Nghiệm thu

| # | Khẳng định | Kiểm thế nào |
|---|---|---|
| 1 | `/gateway/cluega/mcp` trả hợp nhất tool của mọi upstream đang sống | `probe-mcp.mjs` lên endpoint mới, đếm ≥ tổng của hai server đã biết |
| 2 | Prefix cũ không đổi hành vi | `probe-mcp.mjs` lên `/gateway/tiktok-mcp/mcp` vẫn ra 249 tool |
| 3 | Một upstream chết không làm hỏng danh sách | tắt một upstream, `tools/list` vẫn trả tool của các cái còn lại |
| 3b | Ba tool cấp gateway xuất hiện đúng một lần | đếm `ask_clarification` trong `tools/list` gộp = 1, không phải 13 |
| 4 | `tools/call` định tuyến đúng | gọi `tiktok_get_campaigns` và `cluega_tiktok_ad_manager_report_daily_summary` qua endpoint gộp, cả hai ra dữ liệu thật |
| 5 | Danh tính không giả mạo được qua tham số | gửi `__forwardHeaders` trong args với tenant khác, xác nhận bị bỏ qua |
| 6 | Không tên tool nào bị băm | với `slug=cluega`, mọi tên `mcp__cluega__*` ≤ 64 ký tự |
| 7 | Rakazo gửi danh tính theo từng run | bot của workspace A và workspace B gọi cùng tool, log gateway thấy hai `x-tenant-id` khác nhau |
| 8 | Cache không phục vụ chéo tenant | sau khi thêm lọc theo tenant (ngoài v1) — v1 chỉ cần khẳng định cache không chứa dữ liệu theo tenant |

## 7. Rủi ro

| # | Rủi ro | Xử lý |
|---|---|---|
| 1 | Router gộp là điểm nghẽn: gateway hỏng thì bot mất **toàn bộ** tool, không suy giảm từng phần | cache + suy giảm từng phần ở §4.1; chấp nhận có ý thức |
| 2 | Fan-out 13 upstream mỗi lần khởi động bot | cache bắt buộc, TTL ngắn |
| 3 | Trùng tên tool giữa upstream | log và giữ theo thứ tự xác định, không im lặng ghi đè |
| 4 | Bản sao thứ ba của bảng định tuyến | dùng chung `platformToolRoutes`, không copy |
| 5 | Rakazo khai sai tenant | trusted subsystem; siết bằng kiểm phạm vi credential khi có khách thật |
| 6 | `assertSafeRemoteUrl` chặn HTTP loopback ở dev | cờ `RAKAZO_MCP_ALLOW_HTTP_LOCALHOST` mặc định tắt — việc riêng, xem §8 |

## 8. Cố tình không làm

Lọc tool theo nền tảng tenant đã nối (D5). Dùng `/internal/select` (D6). Đổi tên prefix hay tên tool
(D4). Xây OAuth cho Rakazo — nó không có đăng nhập nên không có ai để hỏi đồng ý; OAuth là cánh cửa cho
căn phòng không có người bước vào. Gỡ `capability_installs` khỏi Rakazo — chỉ ngừng dùng cho việc này.

Cờ `RAKAZO_MCP_ALLOW_HTTP_LOCALHOST` để dev khỏi cần ngrok là việc tách riêng: nó sửa một chốt chặn
SSRF (`remote-mcp.ts:116`), nên phải có test và bản ghi riêng, không trộn vào spec này.

## 9. Giả định cần xác nhận

1. Kane-CG12 đồng ý nhận router gộp vào `mcp_gateway`, và đồng ý rằng prefix cũ không đổi.
2. Rakazo sẽ không có đăng nhập riêng trong 6 tháng tới. Nếu có, D2 phải đổi thành trao đổi token và
   OAuth quay lại đúng chỗ.
3. ~~Tên tool giữa các upstream không trùng nhau~~ — **đã kiểm chứng 26/08**, không trùng. Nhưng ba
   tool cấp gateway lặp ở mọi server; xem §4.1.
4. Một service credential dùng chung cho Rakazo là đủ ở giai đoạn này — chưa cần credential theo tenant.
