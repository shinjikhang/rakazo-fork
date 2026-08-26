# Đồng bộ kết nối CDP → bot Rakazo — thiết kế

Ngày 26/08/2026. Kế thừa `2026-08-26-cluega-mcp-connector-design.md` (một connector = Cluega MCP),
đã cài đặt và chạy được đầu-cuối cùng ngày.

## 1. Vấn đề

Người dùng OAuth một tích hợp trong CDP. Muốn thấy ngay một bot trong Rakazo biết dùng tích hợp đó,
không phải cấu hình lại lần thứ hai.

Hôm nay việc đó làm bằng tay: tôi chạy SQL để tạo `organization`, `bots`, `mcp_servers`,
`bot_mcp_servers`. Không có đường tự động nào, vì actor của Rakazo suy ra từ phiên better-auth
(`apps/api/src/app.ts:272`) nên **không service nào trở thành actor được**.

Điều đáng mừng: mọi mảnh cấp phát đã tồn tại dưới dạng RPC — `bots.create`, `mcp.servers.create`,
`mcp.assignments.replace`. Bài toán không phải xây API, mà là chọn cơ chế gọi chúng.

## 2. Bảy quyết định

**D1. Hai làn, tách tĩnh theo loại kết nối.** Không có fallback lúc chạy.

**D2. Kéo, không đẩy — cho cả hai làn.** Một cơ chế duy nhất.

**D3. Một endpoint ở CDP là toàn bộ giao diện giữa hai service.**

**D4. Bot theo từng người**, không theo tenant.

**D5. Định danh dùng chung: `organization.id` = tenant CDP, `user.id` = user CDP.**

**D6. Ngắt kết nối thì thu tool, giữ bot.** Không xoá dữ liệu.

**D7. Phạm vi tool theo bot cho làn Composio: cố tình hoãn.** Xem §6.

## 3. Hai làn

| Làn | Token nằm ở | Chọn kết nối bằng | Đường đi |
|---|---|---|---|
| TikTok / Facebook / Google Ads | CDP giữ | `x-tenant-id` | Rakazo → mcp-gateway → binary MCP → CDP |
| Gmail, Notion, Slack, … | Composio giữ; CDP giữ `connected_account_id` | `x-user-id` | Rakazo → Composio thẳng |

Hai làn **không giao nhau**, nên chia tĩnh là đủ. Loại kết nối đã biết lúc đồng bộ.

Đây là lý do bác bỏ phương án "gọi gateway khi Rakazo không có tool": fallback lúc chạy cần thứ tự
ưu tiên, cần dò trùng tên, và khi hỏng thì không biết hỏng ở nhánh nào. Chia tĩnh cho cùng kết quả
mà không phải nuôi cơ chế nào.

**Làn Composio không đi qua gateway.** Gateway có `ComposioTransport` mint phiên theo từng người
(`internal/core/mcpproxy/composio.go:174` `clientForUser`), và Rakazo có `ComposioConnector` làm y
hệt (`packages/adapters/src/composio-connector.ts:190` `composio.create(userId, …)`). Cùng cơ chế,
hai bản cài đặt. Rakazo dùng bản của mình: bớt một chặng, và cô lập chặt hơn — gateway nạp sẵn 37
toolkit ở mức toàn server (`COMPOSIO_EXPOSE_TOOLKITS`), còn `sessionForExecute(userId, toolkits)`
chỉ mở đúng toolkit của người đó.

## 4. Định danh — chịu lực toàn bộ

`organization.id` = UUID tenant của CDP. `user.id` = user id của CDP. Rakazo thôi tự sinh id.

Cả hai làn đứng trên đây. Làn quảng cáo gửi `workspaceId` làm `x-tenant-id`; làn Composio dùng
`userId` làm entity id của Composio. Sai một trong hai là không thấy kết nối nào — không phải lỗi
báo ra, mà là danh sách rỗng.

Nửa đầu **đã chứng minh** ngày 26/08: một workspace có `id` là tenant UUID của CDP gọi được
`tiktok_get_business_centers` ra dữ liệu thật.

**Giá phải trả:** kết nối Composio hiện có trong Rakazo nằm dưới entity id của better-auth
(`MOLM47Qd…`). Đổi sang id của CDP làm chúng mồ côi và phải nối lại. Ít người dùng thì rẻ, nhưng
không miễn phí, và phải nói trước với người dùng.

## 5. Hợp đồng

### 5.1 Endpoint ở CDP

```
GET /internal/v1/tenants                            (service auth, scope read)
→ [{ tenant_id, status }]

GET /internal/v1/tenants/{tenant}/connections       (service auth, scope read)
→ [{ kind: "composio" | "ads",
      key: "gmail" | "tiktok" | "facebook" | "google-ads",
      owner_user_id, owner_email, owner_name,
      connection_id, status: "active" | "revoked" }]
```

`owner_email` là bắt buộc, không phải cho đẹp: `user.email` trong Rakazo là `NOT NULL UNIQUE`
(`user_email_key`), nên không tạo được hàng `user` chỉ từ một id. `owner_name` cũng `NOT NULL`.
Nếu CDP không muốn trả email, Rakazo phải tự bịa `{owner_user_id}@cdp.invalid` — chạy được và không
bao giờ trùng, nhưng khi đó mọi chỗ hiển thị người dùng trong Rakazo đều sai. Trả email đúng thì rẻ hơn.

Endpoint thứ nhất cần thiết vì kéo thì phải biết kéo cho ai. Endpoint thứ hai cũng giải bài toán
**liệt kê người dùng**: `listConnectedSlugs(userId)` cần một userId để hỏi, mà Rakazo không có cách
nào tự biết tenant có những ai. `owner_user_id` cấp luôn.

Hôm nay CDP **chưa có** hai endpoint này. `GET /api/v1/integrations/facebook/connections` nằm sau
`authMiddleware()` (`internal/adapter/http/router.go:1208`) nên là route của người dùng; đường
internal duy nhất là `/connections/active/token`, mà cái đó trả token nên quá nhiều quyền để liệt kê.

Nên gộp về **một** endpoint liệt kê thay vì viết cái thứ năm cho mỗi nền tảng. Bốn endpoint
`/connections/active/token` (`router.go:2204, 2237, 2252, 2266`) vẫn giữ nguyên — chúng phục vụ các
binary MCP, khác việc.

**Một nguồn sự thật là CDP.** Rakazo *có thể* hỏi Composio trực tiếp bằng `listConnectedSlugs`
(`composio-connector.ts:249`) và như thế tự lành hơn khi CDP lệch, nhưng đó là hai nguồn sự thật.
Composio chỉ được hỏi lúc gọi tool, không dùng để phát hiện kết nối.

### 5.2 Vòng đồng bộ ở Rakazo

Một job Graphile Worker, chu kỳ 5 phút. Với mỗi tenant:

1. Lấy danh sách kết nối.
2. Upsert `organization(id = tenant)`, `user(id = owner_user_id)`, `member`.
3. Mỗi kết nối `status: "active"` → upsert bot và dây nối của nó (§5.3).
4. Mỗi kết nối đã biến mất hoặc `revoked` → thu tool, **giữ bot** (§5.4).

Idempotent do cấu trúc, không do khéo tay: mọi hàng khoá theo `(tenant, owner_user_id, kind, key)`.
Chạy lại vòng đồng bộ hai lần không đẻ bot thứ hai.

Bot xuất hiện trễ tối đa 5 phút. Đó là cái giá của kéo, đã chấp nhận có ý thức: đổi lấy việc không
cần retry, không cần idempotency token, và **không cần xác thực chiều CDP → Rakazo**.

### 5.3 Cấp phát cho một kết nối

Làn quảng cáo:

| Hàng | Giá trị |
|---|---|
| `mcp_servers` | `slug: "cluega"`, `transport: "streamable_http"`, endpoint là `/gateway/cluega/mcp` |
| `bots` | tên theo nền tảng, `workspaceId` = tenant, `userId` = owner |
| `bot_mcp_servers` | `allowAllTools: false`, `allowedTools` = tool của nền tảng đó |

`allowedTools` tính bằng tiền tố tên tool, lấy từ `tools/list` của endpoint gộp lúc đồng bộ: `tiktok_`
cho TikTok, `facebook_` cho Facebook, `google_` cho Google Ads, cộng `cluega_tiktok_ad_manager_` cho
TikTok. Đo ngày 26/08 trên endpoint gộp: 246 tool `tiktok_`, 110 tool `facebook_`, 12 tool
`cluega_tiktok_ad_manager_`.

Ba tool cấp gateway (`ask_clarification`, `recommend_ad_creatives`, `search_knowledge_base`) không
thuộc nền tảng nào; thêm cả ba vào mọi bot quảng cáo.

Làn Composio: **không có hàng `mcp_servers`**. Kết nối đã nằm ở bảng `connection` và
`ComposioConnector` tự phát hiện. Đồng bộ chỉ tạo `bots`.

Đây là chỗ hai làn dùng hai primitive khác nhau, và là gốc của §6.

### 5.4 Thu hồi

Tắt `mcp_servers.enabled`, xoá hàng `bot_mcp_servers`, tăng `revision`. Bot còn nguyên cùng toàn bộ
lịch sử chat. Nối lại thì tool quay về đúng bot cũ, vì khoá idempotent không đổi.

Tăng `revision` là bắt buộc: `McpConnector.sessionFor` so `revision` để quyết định dùng lại phiên
(`packages/adapters/src/mcp-connector.ts:151`). Không tăng thì phiên cũ vẫn phục vụ tool đã bị thu.

## 6. Mô hình quyền — và chỗ cố tình để hở

Hai làn **không** có cùng mức cô lập.

```
Làn MCP:       botMcpServer.findMany({ where: { botId, workspaceId, userId } })
                                              ^^^^^  → ranh giới thật

Làn Composio:  connection.findMany({ where: { userId, workspaceId } })
               (executor.ts:519)               → không có botId
```

Nghĩa là **bot Composio là nhóm hiển thị, không phải ranh giới quyền.** Alice nối Gmail, Notion,
Slack thì mọi bot của Alice đều thấy tool của cả ba — kể cả bot TikTok Ads.

Nói rõ điều **không** đúng, vì dễ hiểu sai: đây không phải "nối Composio là gọi được mọi tool".
Chỉ những toolkit Alice đã tự nối. Con số 37 toolkit là của `COMPOSIO_EXPOSE_TOOLKITS` bên gateway
— cơ chế khác, làn khác.

**Hệ quả bảo mật, phải chấp nhận có ý thức:** một bot bị prompt-injection có thể dùng tool của kết
nối khác cùng người. Bot TikTok Ads gửi được mail qua Gmail của Alice. Đây đúng loại lỗ hổng mà 20
test chống prompt-injection (R11 trong spec trước) định chặn, và chúng cũng chưa viết.

**Hai điều bắt buộc vì đã hoãn:**

1. **UI không được hứa điều ngược lại.** Không có chữ nào ngụ ý bot Composio bị giới hạn ở một
   toolkit. Tên bot là nhãn tổ chức, không phải tuyên bố về quyền.
2. Khi làm thật, hình dạng đã rõ: một bảng `bot_connections` soi khuôn `bot_mcp_servers`, cộng
   `botId` vào lời truy vấn ở `executor.ts:519`, cộng UI chọn. Schema + executor + UI.

Làn quảng cáo **không** có chỗ hở này: `allowedTools` chặn ở mức bot, và bot cấp phát tự động không
bao giờ `allowAllTools`.

## 7. Nghiệm thu

| # | Khẳng định | Kiểm thế nào |
|---|---|---|
| 1 | Kết nối mới ở CDP sinh đúng một bot trong 5 phút | nối một tích hợp, chờ một chu kỳ, đếm bot |
| 2 | Chạy vòng đồng bộ hai lần không đẻ bot thứ hai | gọi job hai lần, đếm bot |
| 3 | Hai người cùng tenant cùng toolkit ra hai bot riêng | Alice và Bob cùng nối Gmail |
| 4 | Ngắt kết nối thì bot còn, tool mất | ngắt ở CDP, xác nhận bot còn lịch sử chat và `bot_mcp_servers` rỗng |
| 5 | Nối lại thì tool về đúng bot cũ | nối lại, xác nhận cùng `botId`, không có bot mới |
| 6 | Bot quảng cáo không bao giờ `allowAllTools` | truy vấn SQL sau đồng bộ |
| 7 | Phiên MCP không phục vụ tool đã thu | thu hồi rồi gọi lại ngay, phải bị từ chối |
| 8 | Tenant rỗng không sinh gì | tenant không kết nối gì, không có bot |
| 9 | CDP chết không làm hỏng bot đang có | tắt CDP, chạy đồng bộ, bot cũ còn nguyên |

Nghiệm thu #9 quan trọng: vòng đồng bộ **không được** coi "không lấy được danh sách" là "không có
kết nối nào". Lỗi lấy danh sách phải bỏ qua tenant đó, không thu hồi gì.

## 8. Rủi ro

| # | Rủi ro | Xử lý |
|---|---|---|
| 1 | CDP trả danh sách rỗng do lỗi → thu hồi sạch mọi bot | phân biệt "lấy được, rỗng" với "không lấy được"; nghiệm thu #9 |
| 2 | Bot Composio bị hiểu là có cô lập | §6, và cấm UI hứa ngược lại |
| 3 | Đổi user id làm mồ côi kết nối Composio đang có | thông báo trước; ít người dùng nên rẻ |
| 4 | Hai UI cùng nối/ngắt một thứ → hỗ trợ khách khó lần | chấp nhận có ý thức; cùng project nên trạng thái vẫn nhất quán |
| 5 | Chu kỳ 5 phút là trễ với người vừa nối xong | chấp nhận; nếu đau thì thêm webhook đánh thức, không mang dữ liệu |
| 6 | Rakazo giữ khoá Composio thay cho mọi người trong project | đã đúng như vậy hôm nay; không xấu thêm, nhưng ghi nhận |

## 9. Cố tình không làm

Phạm vi tool theo bot cho làn Composio (D7, §6). Đẩy từ CDP sang Rakazo — kéo là cơ chế duy nhất.
Webhook đánh thức. Xoá bot khi ngắt kết nối. Gỡ better-auth khỏi Rakazo — nó vẫn còn, chỉ là id nó
lưu phải là id của CDP. Nối làn Composio qua gateway.

## 10. Giả định cần xác nhận

1. **Rakazo và CDP dùng cùng một project Composio (cùng API key).** Khác project thì kết nối OAuth ở
   CDP vô hình với Rakazo và toàn bộ làn Composio sụp. Chưa kiểm chứng được trên máy này —
   `COMPOSIO_API_KEY` không có trong `.env` của gateway.
2. **Quy ước tên tool của Composio.** Chưa kiểm chứng được vì lý do trên. Không có chỗ nào trong
   thiết kế này dựa vào nó, nhưng §5.3 của làn quảng cáo dựa vào tiền tố tên tool của nền tảng
   (`tiktok_`, `facebook_`), và cái đó **đã đo**: 246 tool `tiktok_`, 110 tool `facebook_`.
3. **CDP đồng ý thêm hai endpoint liệt kê** ở §5.1, và đồng ý rằng đó là chỗ liệt kê duy nhất.
4. **`owner_user_id` mà CDP trả về là cùng chuỗi mà Composio dùng làm entity id.** Nếu CDP dùng id
   nội bộ khác với id đã dùng lúc `InitiateConnect`, cần một cột ánh xạ.
