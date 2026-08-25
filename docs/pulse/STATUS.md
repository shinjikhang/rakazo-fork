# Vòng lặp quảng cáo TikTok — báo cáo hiện trạng

Ngày: 2026-08-25 · Nhánh: `feat/pulse-ad-loop` (16 commit, **chưa merge, chưa push**)
Tách từ: `dev @ d6b99c5` · HEAD: `f20088b`

Đọc file này trước khi làm tiếp. Ba tài liệu đi kèm trong cùng thư mục:

| File | Dùng khi |
|---|---|
| `handover-checklist.md` | Khi chạy test — H1→H6, có hai cổng chặn |
| `tiktok-bot-prompt.md` | Dán vào system prompt của bot TikTok Ads |
| `TESTING.md` | Sổ tay test dùng lại — công thức theo thứ cần kiểm |
| `acceptance-log.md` | Khi nghiệm thu, người thao tác điền vào |

Thiết kế và kế hoạch gốc: `docs/superpowers/specs/2026-08-25-pulse-agent-loop-design.md` và
`docs/superpowers/plans/2026-08-25-pulse-ad-loop.md`.

---

## 1. Điều quan trọng nhất phải biết trước khi test

**Sáu module vừa xây chưa có ai gọi.** Kiểm được bằng:

```bash
grep -rn "adActionToolCall\|parseAdAction\|parseAdReportMessage\|verifyApplied\|\
assertBudgetChangeWithinCap" --include='*.ts' apps packages | grep -v packages/core/src
# → rỗng
```

Vòng lặp bạn test hôm nay chạy trên đường native của Rakazo, không đi qua code này. Nghĩa là:

| Guard | Trong đường chạy thật? | Vì sao |
|---|---|---|
| Allowlist 18 tool | **có** | tính năng gốc của Rakazo, `bot_mcp_servers.allowedTools` |
| Cổng phê duyệt trước khi ghi | **có** | bản sửa `ruleMatches` nằm trong đường `executor.ts:793` |
| Consent gác ở gateway | tuỳ Kane-CG12 | ngoài repo này |
| Trần ±50% ngân sách | chưa | `assertBudgetChangeWithinCap` không ai gọi |
| Bắt buộc có `from` để hoàn tác | chưa | `parseAdAction` không ai gọi |
| Chỉ đổi số ở cấp adgroup | chưa | cùng lý do |
| Kiểm `confirmed_by` trước khi ghi | chưa | `adActionToolCall` không ai gọi |
| Thông điệp bốn phần | chưa | model vẫn nhả văn tự do |
| Kéo lại kiểm chứng (vòng B) | chưa | `verifyApplied` không ai gọi |

Hai guard quan trọng nhất cho tiền — **allowlist** và **người duyệt** — đã sống. Bộ hạn chế thiệt hại
và bản ghi để hoàn tác thì chưa. **Test trên ad group ngân sách nhỏ, đừng test trên chiến dịch chính.**

---

## 2. Đã xây gì

25 file, +1.460 dòng. `packages/core` 288/288 test xanh, `pnpm check` 20/20, `pnpm lint` xanh.

### Hợp đồng và guard — `packages/core/src/`

| File | Nội dung |
|---|---|
| `ad-vocabulary.ts` | `AD_OPS`, `AD_LEVELS`, `AD_NUMERIC_OPS` — từ vựng dùng chung, tránh trôi lệch |
| `ad-snapshot.ts` | `AdDailySnapshot` — tầng chỉ số, thứ duy nhất AI được đọc |
| `ad-action.ts` | `AdAction`, `parseAdAction`, `inverseAdAction`, `adActionToolCall` |
| `ad-budget-cap.ts` | `BUDGET_DELTA_CAP = 0.5`, `assertBudgetChangeWithinCap` |
| `ad-approval.ts` | `TIKTOK_WRITE_TOOLS`, `tiktokApprovalRules()` |
| `ad-report-message.ts` | `AdReportMessage` — cấu trúc bốn phần bắt buộc |
| `ad-verify.ts` | `verificationToolCall`, `verifyApplied` — vòng lặp B |

Sửa thêm một file nền dùng chung: `packages/core/src/action-approval.ts` — xem M1 ở mục 4.

### Script vận hành — `scripts/pulse/`

| File | Dùng làm gì |
|---|---|
| `probe-mcp.mjs` | Dò một MCP server, thoát ≠0 nếu thiếu tool bắt buộc |
| `probe-write.mjs` | Chứng minh token có quyền ghi (ghi lại đúng giá trị đang có) |
| `assert-allowlist.sql` | Khẳng định allowlist đúng bộ tool, có `-v bot` và `-v expected` |

---

## 3. Nguồn tool — số liệu đã kiểm chứng thật

| MCP server | Prefix HTTP | Số tool | Dùng cho |
|---|---|---|---|
| `cluega-tiktok-ad-manager-mcp` | `/gateway/cluega-tiktok-ad-manager-mcp/mcp` | 15 qua gateway (12 từ binary), chỉ đọc | phân tích hằng ngày (đọc DB Cluega, rẻ, không đụng rate limit TikTok) |
| `tiktok-ads-mcp` | `/gateway/tiktok-mcp/mcp` | **249** qua gateway (246 từ binary), có đủ phần ghi | thực thi và kiểm chứng (gọi thẳng API TikTok) |

Cổng gateway mặc định **5235** (`configs/mcp-gateway.yaml`: `port: ${MCP_GATEWAY_PORT:5235}`).
Hai điều dễ sai ở URL, cả hai đã kiểm thật:
- prefix của `tiktok-ads-mcp` là `/gateway/tiktok-mcp`, **không** trùng tên server;
- phải có hậu tố **`/mcp`** ở cuối, thiếu là 404 `Invalid prefix`.

Bot chỉ thấy 18 trong 246 tool: 8 đọc từ ad-manager, 6 đọc/kiểm chứng + 4 ghi từ tiktok-ads-mcp.
Danh sách đầy đủ ở `handover-checklist.md` H3 và H4.

**Bốn tool ghi:** `tiktok_update_ad_status`, `tiktok_update_adgroup`, `tiktok_update_adgroup_status`,
`tiktok_update_campaign_status`. Đây là phát hiện lớn nhất của đợt này — **FR-05 trong đặc tả không
phải việc phải xây, nó đã tồn tại từ 25/06.**

---

## 4. Lỗi mà quy trình bắt được

Ghi lại vì đều là loại hỏng im lặng: API trả thành công mà không đổi gì trên TikTok.

### Ba lỗi shape, tìm ra bằng cách dò binary MCP thật

| Plan đoán | Thực tế |
|---|---|
| `operation_status` | `opt_status` |
| `ad_ids: ["ad_1"]` (mảng) | chuỗi JSON — schema khai `type: "string"` |
| `budget` ở cấp cao nhất | nằm trong trường `params` dạng chuỗi JSON |
| tool đọc nhận `adgroup_ids` | không có; chỉ `advertiser_id` (bắt buộc) + `filters` chuỗi JSON |

### M1 — rule phê duyệt không bao giờ khớp (nghiêm trọng nhất)

`mcp-connector.ts:64` phơi tool cho model dưới tên `` mcp__${slug}__${tool} ``, còn rule ghi tên trần,
`ruleMatches` so sánh bằng chính xác → không khớp → `resolveActionApproval` trả `"allow"` →
`bypassApproval` → **đổi ngân sách thật, không thẻ duyệt, không `confirmed_by`.**

Đúng thứ mà cả Task 3 tồn tại để ngăn. Đã sửa trong `ruleMatches`: khớp cả tên đầy đủ lẫn phần đuôi
sau `mcp__<slug>__`. Có test dùng tên có tiền tố.

### Khoảng trống ASSERT-4

Trước đợt fix, **không dòng code nào kiểm `confirmed_by` trước khi ghi** — ASSERT-4 dựa hoàn toàn vào
rule trong DB, mà rule đó thì M1 vừa chứng minh là không khớp. Nay `adActionToolCall` kiểm ba điều
trước khi dựng tham số: cấp adgroup cho op đổi số, `requires_confirm === true`, `confirmed_by` không
rỗng.

---

## 5. Mười một phán quyết đã đưa ra

Đây là những quyết định tôi tự quyết trong lúc chạy. Xem lại và đảo cái nào bạn không đồng ý.

| # | Phán quyết | Cái giá nếu sai |
|---|---|---|
| R1 | Làm trên checkout hiện tại, không tạo git worktree — plan ràng buộc vào stack đang chạy tại đúng đường dẫn này | cây làm việc của `dev` bị chiếm; đổi nhánh là xong |
| R2 | Giữ `ad-budget-cap` độc lập, không phụ thuộc `TIKTOK_WRITE_TOOLS` | một dòng mô tả interface sai trong plan |
| R3 | Subagent chỉ dựng file; mọi bước cần token hoặc trình duyệt gom vào checklist, **không giả vờ đã chạy** | không mất gì đã dựng |
| R4 | Thêm `zod ^4.1.5` vào `packages/core` thay vì dời schema sang `packages/contracts` | `core` có thêm một cạnh phụ thuộc; dời sau là cơ học |
| R5 | Thêm `account_id` bắt buộc vào `AdAction` — spec tự mâu thuẫn, bốn tool thật đều đòi `advertiser_id` | bên sinh AdAction phải điền thêm một trường |
| R6 | Từ chối op đổi số ngoài cấp adgroup ngay lúc parse, không định tuyến theo cấp | muốn đổi ngân sách cấp campaign phải thêm tool vào allowlist trước |
| R7 | Không sửa khoá bên trong `params`; đưa vào phép thử sandbox (H2b) | lệnh đổi ngân sách đầu tiên thất bại, phải sửa tên trường |
| R8 | Không cho subagent mò tên trường trong response của `verifyApplied` | cùng phép thử sandbox với R7 |
| R9 | **Không** áp trần ngân sách trong `adActionToolCall` — nghịch đảo của một lần cắt 50% là tăng 100%, áp trần ở đó làm undo không dựng được, trái ASSERT-6 | lệnh hoàn tác vượt trần vẫn dựng được; bù lại nó chỉ trả về giá trị vốn đã sống trên tài khoản vài phút trước |
| R10 | Sửa M1 ở `ruleMatches`, không cho rule phát tên có tiền tố — slug do người vận hành đặt, hardcode sẽ vỡ khi đổi tên server | rule dạng `tool` rộng hơn chút; hướng lệch là về phía **hỏi thêm**, không phải cho qua |
| R11 | Bộ 20 ca kiểm thử đối kháng prompt injection (spec §11) là task riêng | nhánh merge mà chưa có bằng chứng chống injection; giảm nhẹ vì chưa nối executor |

**R9 và R10 là hai cái đáng xem lại nhất** — cả hai đổi ngữ nghĩa an toàn của đường tiêu tiền.

---

## 6. Trạng thái test

`pnpm test` toàn repo: **2 đỏ / 1254 xanh / 67 skip**. Cả hai đều **không do nhánh này**, đã chứng minh
bằng worktree tạm tại merge base:

| Test | Ở merge base | Trên nhánh |
|---|---|---|
| `packages/adapters/src/desktop-sandbox-write-containment.test.ts` | **đỏ** | đỏ — có sẵn, lỗi trên macOS |
| `packages/adapters/src/voice-http.test.ts` | xanh khi chạy riêng | xanh khi chạy riêng — flaky do deadline 1ms |

`packages/core` (toàn bộ code của nhánh này): **288/288 xanh**.

---

## 7. Làm gì tiếp

### Ngay — chạy test theo `handover-checklist.md`

Thứ tự **H1 → H2 → H2b → H3 → H4 → H5 → H6**. Hai cổng chặn:

- **H2** — chưa chứng minh được token có quyền ghi thì mọi bước sau vô nghĩa.
- **H4** — chưa có 4 rule phê duyệt thì **không được** bật tool ghi.

Lưu ý: giao diện web chỉ có preset `email`/`purchase`, **không có chỗ thêm rule dạng `tool`**. Phải
dùng `rpc.approvalRules.set` hoặc chèn thẳng vào `action_approval_rules`.

### Sau đó — plan nối vào executor

Đây là việc làm cho các guard ở mục 1 có hiệu lực thật:

1. Chặn tool ghi qua `parseAdAction` trước khi dispatch.
2. Ép thông điệp chủ động qua `parseAdReportMessage`, render bằng template.
3. Gọi `verifyApplied` sau mỗi lần ghi thành công (vòng lặp B).
4. Bộ 20 ca đối kháng prompt injection (R11).

### Giai đoạn 2 của spec — dựng lại bộ cảnh báo

Hệ quả của quyết định bỏ `notification_service`: năm evaluator ngưỡng, kho metric theo giờ, khử trùng
lặp cảnh báo, kênh gửi ngoài, và job handler `alert.evaluate`. Có plan riêng, chỉ bắt đầu sau khi
nghiệm thu giai đoạn 1 xanh.

Ghi chú thiết kế cho `alert.evaluate`: routine của Rakazo luôn khởi động một lượt LLM. Cảnh báo ngưỡng
là phép số học, nên phải chạy tất định trước và chỉ khi có ngưỡng nổ mới đẩy `run.continue` — nếu
không sẽ trả tiền model 24 lượt/bot/ngày cho việc máy tính được.

---

## 8. Nợ kỹ thuật đã ghi nhận

Không cái nào chặn merge, nhưng đừng để rơi:

- `ad-verify.ts` — tên trường trong response (`budget`, `operation_status`) và khoá trong `filters` chưa
  ai xác nhận được; thuộc phép thử H2b.
- `action-approval.ts` — comment nói "chỉ có thể làm tăng số lần hỏi" là chưa chính xác: rule
  `always_allow` dạng `tool` cũng được khớp theo tiền tố, nên có thể làm giảm. Chỉ sai ở comment.
- `bareToolName` không đệ quy, tên bọc hai lần (`mcp__a__mcp__b__t`) sẽ không khớp rule trần. Lệch về
  phía dưới-khớp, an toàn.
- `assert-allowlist.sql` lấy hàng đầu tiên nếu hai bot cùng tên.
- `docs/superpowers/plans/2026-08-25-pulse-ad-loop.md` còn vài đường dẫn tuyệt đối `/Users/khanghuynh/...`.
- Hai schema `AdDailySnapshot`/`AdAction` đang ở `packages/core` nhưng `packages/contracts` mới là nhà
  của hợp đồng zod trong repo này. Quyết định của đội, không phải lỗi.

---

## 9. Môi trường đang chạy

```
API                 http://127.0.0.1:3100      (health: composio true, runtime pi, jobs graphile)
Web                 http://127.0.0.1:5173
Sandbox supervisor  http://127.0.0.1:7091
Postgres            127.0.0.1:5434  container rakazo-pg  (5433 đã bị project khác chiếm)
Node                v24.18.0 qua nvm — bắt buộc, engine-strict
```

Khởi động lại:

```bash
cd /Users/khanghuynh/Documents/Dev/cluega/rakazo
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
docker start rakazo-pg && corepack pnpm dev
```

Dừng mà **không** mất dữ liệu: Ctrl-C ở `pnpm dev`, rồi `docker stop rakazo-pg`.
Đừng dùng `pnpm compose:down` — script đó có `-v`, sẽ xoá volume.
