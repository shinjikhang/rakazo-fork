# Vòng lặp quảng cáo khép kín trên nền Rakazo — thiết kế

Ngày: 2026-08-25 · Trạng thái: chờ duyệt · Người viết: Khang Huynh

Tài liệu nguồn: `Cluega_AI_PRD_v1.0_VI.docx` (PRD), `Cluega_Dac_ta_vong_lap_quang_cao_dau_tien_v1.0_VI.docx`
(đặc tả vòng lặp — mọi mã `FR-*`, `ASSERT-*`, vòng lặp A/B/C dưới đây trỏ về tài liệu đó).

## 1. Mục tiêu

Dựng vòng lặp khép kín đầu tiên trên nền Rakazo, chạy được thật với tài khoản quảng cáo TikTok thật:

1. Mỗi sáng khách có báo cáo TikTok của hôm qua.
2. Sau báo cáo có phân tích và đề xuất của AI, mỗi đề xuất bấm được.
3. Khách ra lệnh, hệ thống gọi MCP chỉnh quảng cáo thật, rồi kiểm chứng và báo kết quả.

Đây là ba yêu cầu PM đặt cho đợt này. Vòng lặp là bước giữa trên đường tới L4 — nơi AI tự phát hiện
vấn đề và lên tiếng trước khi khách hỏi.

## 2. Bốn quyết định

**D1 — Rakazo là nền của agent service, không phải kho code để bê từng mảnh.**
Chạy nguyên bản đang có, cấu hình thay vì viết mới ở giai đoạn đầu. Phần Rakazo dùng tới: bots,
routines, runs + lease, executor, action approval, MCP connector, secrets, Graphile jobs, realtime
`pg_notify`. Phần không dùng: sandbox/computer, supervisor, voice, artifacts, teach playbook. Không xoá
chúng ở đợt này; chỉ không cấu hình.

**D2 — Một connector là một bot.**
Bot thuộc về một workspace, nên đơn vị thật là một bot cho mỗi cặp (tenant × connector). Mỗi bot có
lịch riêng, allowlist tool riêng, thread riêng, ngữ cảnh riêng. Thêm Meta hay Google ở đợt sau là thêm
bot và trỏ vào MCP tương ứng, không sửa vòng lặp.

**D3 — Bỏ `notification_service`; hộp thư là thread chat của bot.**
Đây là quyết định của người chủ trì sau khi đã cân nhắc phương án giữ. Hệ quả phải gánh, liệt kê ở
mục 9: năm evaluator ngưỡng, kho metric theo giờ, khử trùng lặp cảnh báo, kênh gửi ngoài và cơ chế
retry đều phải dựng lại trong Rakazo. Cách ly tenant tạm hạ từ mức schema xuống mức cột
(`workspaceId`), sẽ refactor sau khi vòng lặp chạy ổn.

**D4 — Model viết nội dung, code quyết định có gửi hay không.**
Không để LLM tự chọn gọi hay không gọi tool báo tin. Executor luôn phát đúng một thông báo khi kết
thúc run. Lý do: nguyên tắc 4 của PRD — *"Im lặng không phải kết quả hợp lệ"* — và R-01 prompt
injection mức rất cao, vì tên chiến dịch và nội dung quảng cáo là dữ liệu ngoài.

## 3. Ranh giới

Ba service, mỗi service một động từ, không service nào chạm cơ sở dữ liệu của service khác.

| Service | Động từ | Sở hữu | Chủ |
|---|---|---|---|
| `cdp_backend` (Go) | lưu | ba tầng dữ liệu quảng cáo, consent | Kin-CG05 |
| Rakazo agent (TS) | quyết + nói | bots, routines, runs, lease, AdAction, approval, thread | Jimmy-CG08 |
| `mcp_gateway` (Go) | làm + gác | tool đọc và ghi TikTok, chặn khi chưa cấp quyền | Kane-CG12 |

Agent đọc số liệu **chỉ qua tool MCP**, không truy vấn thẳng cơ sở dữ liệu của CDP. Đây là luật 4.2
của đặc tả.

Consent được gác ở gateway, không ở agent. Tài khoản chưa bật ô cho phép đọc thì tool từ chối, nên
`ASSERT-2` trở thành một bài kiểm thử của gateway chứ không phải lời hứa giữa hai service. Một cánh
cửa, một người gác: agent có lỗi cũng không kéo được dữ liệu chưa được phép.

## 4. Nguồn tool

Hai MCP server, dùng cho hai mục đích khác nhau. Cả hai đã tồn tại và chạy được.

**`cluega-tiktok-ad-manager-mcp`** — 12 tool, chỉ đọc, lấy từ cơ sở dữ liệu của Cluega. Rẻ, đã tổng
hợp sẵn, không đụng hạn mức tần suất của TikTok. Dùng cho phân tích hằng ngày.

**`tiktok-ads-mcp`** — 246 tool, gọi thẳng API TikTok, có đủ phần ghi. Dùng cho thực thi và cho bước
kiểm chứng.

Bước kiểm chứng (vòng lặp B) **bắt buộc dùng `tiktok-ads-mcp`**. Kiểm chứng bằng cơ sở dữ liệu của
Cluega là tự kiểm chứng chính mình: dữ liệu đó cũng do một tiến trình đồng bộ khác ghi, nên nó không
chứng minh được TikTok đã đổi thật.

### Allowlist

246 tool là quá nhiều để đưa cho model: context phình, và model chọn nhầm. Bot chỉ thấy 18 tool sau.
Chặn ở hai lớp — `bot_mcp_servers.allowedTools` phía Rakazo và tool policy phía gateway.

Đọc, từ `cluega-tiktok-ad-manager-mcp`:

```
report_daily_summary · report_daily_trend · report_period_compare
report_creative_fatigue · report_ctr_decay · campaign_list · adgroup_list · ad_list
```

Đọc và kiểm chứng, từ `tiktok-ads-mcp`:

```
tiktok_get_authorized_ad_accounts · tiktok_get_campaigns · tiktok_get_ad_groups
tiktok_get_ads · tiktok_get_ad_account_balance · tiktok_recommend_bid
```

Ghi, từ `tiktok-ads-mcp`:

```
tiktok_update_ad_status          bật/tắt quảng cáo
tiktok_update_adgroup            đổi ngân sách ngày
tiktok_update_adgroup_status     bật/tắt nhóm quảng cáo
tiktok_update_campaign_status    bật/tắt chiến dịch
```

Bốn tool ghi đều đi qua cổng phê duyệt. Không tool nào khác trong 246 được bật ở đợt này. Tool tạo nội
dung (`tiktok_upload_video`, `tiktok_store_cluega_media`, `tiktok_generate_smart_text`) để lại cho
FR-10 ở đợt sau; đợt này chỉ mở lối vào Cluega Design bằng liên kết.

## 5. Vòng đời một run

Bảy giai đoạn của đặc tả, ánh xạ vào cơ chế có sẵn của Rakazo.

| Giai đoạn | Cơ chế |
|---|---|
| 1 · Kéo dữ liệu | `routines` cron `0 9 * * *` theo múi giờ tài khoản → job `routine.wakeup` |
| 2 · Lưu kho | thuộc `cdp_backend`, agent không ghi |
| 3 · Dựng báo cáo | tool `report_daily_summary` + `report_period_compare` |
| 4 · AI phân tích | executor gọi model, sinh tối thiểu ba đề xuất theo mẫu ba đoạn |
| 5 · Khách quyết định | thread chat; tool ghi bị chặn lại chờ duyệt |
| 6 · MCP thực thi | tool ghi chạy sau khi có `confirmed_by` |
| 7 · Kéo lại kiểm chứng | job `run.continue` gọi `tiktok_get_ad_groups` đối chiếu giá trị vừa đặt |

Giai đoạn 3, 4 và 5 không nối cứng. Báo cáo phải xem được cả khi model chưa trả lời xong — `ASSERT-7`.

Ba vòng lặp có trần:

| Mã | Kích hoạt | Trần | Vượt trần |
|---|---|---|---|
| A | lệnh chạm ngân sách, giá thầu, bật/tắt | 1 lượt hỏi | huỷ lệnh, ghi nhật ký lý do |
| B | một lệnh thực thi trả về thành công | 1 lần/thao tác | vẫn báo thành công, ghi "chưa xác nhận được" |
| C | một chỉ số lệch quá ngưỡng | 1 lần/chỉ số/ngày | gộp các biến động cùng loại thành một nhắc |

Mỗi lượt chạy vòng lặp ghi lại số lượt, lý do thoát và có chạm trần hay không. Tỷ lệ chạm trần là chỉ
số chất lượng: vòng A hay bị huỷ nghĩa là đề xuất của AI chưa đáng tin.

## 6. Hợp đồng

Đóng băng ở mốc M1. AI chỉ đọc cái thứ nhất và sinh ra cái thứ hai; MCP chỉ thực thi cái thứ hai.

```jsonc
// AdDailySnapshot — thứ AI được phép đọc
{
  "tenant_id": "t_0912", "account_id": "tt_88231", "date": "2026-08-24",
  "currency": "VND", "timezone": "Asia/Ho_Chi_Minh",
  "level": "ad",                    // campaign | adgroup | ad
  "object_id": "ad_55120", "name": "Video review 15s",
  "status": "ACTIVE", "daily_budget": 500000,
  "spend": 483000, "impressions": 91200, "clicks": 1120,
  "ctr": 0.0123, "cpc": 431, "conversions": 18, "cpa": 26833, "roas": 1.8,
  "compare": { "d7_avg_cpa": 19400, "d28_avg_cpa": 20100, "cpa_delta_pct": 0.38 }
}

// AdAction — thứ AI sinh ra và MCP thực thi
{
  "action_id": "act_7731", "snapshot_date": "2026-08-24",
  "op": "set_daily_budget",         // pause | resume | set_daily_budget | set_bid
  "target": { "level": "adgroup", "object_id": "adg_3301" },
  "from": 500000, "to": 300000,     // from là bắt buộc, không có thì không hoàn tác được
  "reason": "CPA 7 ngày gần nhất cao hơn mục tiêu 38%",
  "requires_confirm": true,         // mọi thao tác tiêu tiền đều true
  "confirmed_by": "user_2210", "confirmed_at": "2026-08-25T09:12:00+07:00",
  "result": { "status": "success", "verified_at": "2026-08-25T09:16:00+07:00" }
}
```

Ánh xạ `op` sang tool: `pause`/`resume` → `tiktok_update_ad_status` hoặc
`tiktok_update_adgroup_status`; `set_daily_budget` → `tiktok_update_adgroup`; `set_bid` →
`tiktok_update_adgroup` sau khi tham khảo `tiktok_recommend_bid`.

## 7. Kiểm soát rủi ro

| Luật | Thực thi ở đâu |
|---|---|
| Thao tác tiêu tiền phải có `confirmed_by` | cổng phê duyệt của executor, chặn trước khi gọi tool |
| Mỗi lần đổi ngân sách không quá ±50% | kiểm tra trong executor trước khi dựng lệnh gọi tool |
| Mọi AdAction phải có `from` | schema, từ chối ở tầng ghi |
| Ghi idempotent theo (tài khoản, ngày, đối tượng) | thuộc `cdp_backend` |
| Chưa cấp quyền thì không kéo | tool policy của gateway |
| Nội dung thông báo render bằng template | executor, model chỉ điền trường |

Cấu trúc bốn phần bắt buộc cho mọi thông điệp chủ động, theo PRD: điều gì xảy ra · vì sao quan trọng ·
đề xuất · nguồn đã dùng. Model điền bốn trường này, không nhả văn bản tự do vào hộp thư của khách.

## 8. Cảnh báo tất định

Năm loại cảnh báo dưới đây tính được bằng số học, không cần model:

| Loại | Công thức |
|---|---|
| `budget_warning` | chi hôm nay ÷ ngân sách ngày |
| `zero_spend` | số giờ liên tiếp chi bằng 0 |
| `spend_spike` | phần trăm tăng so với giờ trước |
| `rejection_rate` | tỉ lệ bị từ chối |
| `account_status_change` | trạng thái tài khoản đổi |

Chúng chạy trong một job handler mới, `alert.evaluate`, theo giờ. **Job này không gọi model.** Chỉ khi
có ngưỡng nổ nó mới đẩy một `run.continue` để bot lên tiếng. Nếu để routine bình thường chạy mỗi giờ,
mỗi bot tốn 24 lượt model mỗi ngày cho việc máy tính được.

Bot chủ động ở hai chỗ, cả hai đều rẻ: lượt chạy 09:00 hằng ngày (một lượt model cho mỗi bot mỗi
ngày), và khi đọc nhật ký cảnh báo trong lượt chạy đó — một cảnh báo lẻ là số liệu, ba cảnh báo cùng
loại liên tiếp là một nhận định, và nhận định mới đúng việc của bot.

Phân tích được tính lúc khách mở, không tính sẵn cho mọi cảnh báo. Phần lớn cảnh báo sẽ không ai bấm
vào; chi phí model nhờ đó tỉ lệ với mức quan tâm thật, không tỉ lệ với số cảnh báo.

## 9. Ba giai đoạn

### Giai đoạn 0 — chứng minh vòng lặp chạy

Chạy trên môi trường Rakazo đang có ở máy phát triển: API `127.0.0.1:3100`, web `127.0.0.1:5173`,
Postgres `rakazo-pg` cổng 5434. Gần như không viết code.

1. Bật `mcp_gateway` với `configs/tiktok-mcp-stdio.yaml` và `configs/cluega-tiktok-ad-manager-mcp.yaml`.
2. Đăng ký hai URL gateway vào Rakazo dạng HTTPS MCP server.
3. Đặt allowlist 17 tool ở mục 4.
4. Tạo bot **TikTok Ads**, viết system prompt theo mẫu ba đoạn và cấu trúc bốn phần.
5. Tạo routine cron `0 9 * * *`.
6. Bật cổng phê duyệt cho bốn tool ghi.
7. Chạy thử bằng `routines.testRun`, không chờ 9 giờ sáng.

Xong giai đoạn này là chạy được đủ ba yêu cầu của PM, với tài khoản và token thật.

### Giai đoạn 1 — làm cho nó đúng

1. Schema hoá `AdDailySnapshot` và `AdAction`; từ chối AdAction thiếu `from`.
2. Trần ±50% cho mỗi lần đổi ngân sách.
3. Kiểm chứng sau thực thi qua `tiktok-ads-mcp`.
4. Nhật ký vòng lặp: số lượt, lý do thoát, có chạm trần không.
5. Bộ đánh giá chất lượng đề xuất: mỗi đề xuất phải nêu đối tượng và con số.

### Giai đoạn 2 — phần phải dựng lại vì bỏ `notification_service`

1. Năm evaluator ngưỡng.
2. Kho metric theo giờ.
3. Khử trùng lặp cảnh báo, 1 lần/chỉ số/ngày.
4. Kênh gửi ngoài (Telegram) kèm retry và backoff.
5. Job handler `alert.evaluate`.

## 10. Nghiệm thu

Tám khẳng định tự động của đặc tả, ánh xạ vào nơi kiểm thử:

| Mã | Nội dung | Kiểm ở đâu |
|---|---|---|
| ASSERT-1 | kéo lại cùng ngày không cộng trùng | `cdp_backend` |
| ASSERT-2 | chưa cấp quyền thì số lần gọi API bằng 0 | `mcp_gateway` |
| ASSERT-3 | truy vấn thiếu điều kiện tenant bị từ chối | `cdp_backend` và agent — agent cách ly theo cột `workspaceId`, xem D3 |
| ASSERT-4 | `requires_confirm` mà thiếu `confirmed_by` thì bị từ chối | agent |
| ASSERT-5 | đổi ngân sách vượt ±50% bị chặn | agent |
| ASSERT-6 | dựng được lệnh nghịch đảo từ `from` | agent |
| ASSERT-7 | model lỗi, báo cáo vẫn hiển thị | agent + dashboard |
| ASSERT-8 | kéo một tài khoản P95 dưới 3 phút; bấm nút tới khi TikTok đổi P95 dưới 60 giây | đo trên môi trường thật |

Tám tình huống cảm nhận ở chương 5.1 của đặc tả giữ nguyên, do một người không phải người phát triển
thao tác, phán định có hoặc không.

## 11. Rủi ro

| # | Rủi ro | Xử lý ở đợt này |
|---|---|---|
| 1 | Chọn sai tool trong 246 — dư thì model gọi nhầm, thiếu thì vòng lặp hở | allowlist 17 tool, chặn hai lớp, rà lại sau mỗi mốc |
| 2 | Đề xuất sai của AI gây thiệt hại | luôn là đề xuất kèm người xác nhận; mọi lệnh lưu lý do và người duyệt |
| 3 | Prompt injection từ tên chiến dịch và nội dung quảng cáo | model chỉ điền trường, render bằng template; bộ kiểm thử đối kháng tối thiểu 20 ca |
| 4 | Độ trễ dữ liệu TikTok — số hôm qua còn chỉnh trong 24–48 giờ | kéo bù 7 ngày để tự sửa số cũ |
| 5 | Ngưỡng phát hiện biến động đặt bao nhiêu | tạm ±30% so với trung bình 7 ngày; đủ ba tháng dữ liệu thì chuyển sang phân bố lịch sử |
| 6 | Cách ly tenant tạm ở mức cột | chấp nhận có thời hạn theo D3; refactor sau khi vòng lặp ổn định |

## 12. Cố tình không làm

AI tự thực thi không cần khách xác nhận. Nền tảng quảng cáo ngoài TikTok. Quy kết chuyển đổi đa kênh.
Mô hình phát hiện biến động theo phân bố lịch sử. Quy trình tạo nội dung hoàn chỉnh — đợt này chỉ mở
lối vào. Phần computer và sandbox của Rakazo. Đa tài khoản đa tiền tệ — đợt này một tài khoản một loại
tiền, lược đồ đã để sẵn trường.

Không làm không có nghĩa là không bao giờ làm. Dữ liệu vẫn lưu đủ 13 tháng theo FR-09, hợp đồng vẫn để
sẵn trường, chỉ là chưa bật.

## 13. Giả định cần xác nhận

1. Tài khoản quảng cáo thật có chi tiêu liên tục đủ để nghiệm thu mức lệch dưới 1%.
2. Hạn mức tần suất của TikTok đủ cho lần kéo hằng ngày cộng các lần kéo kiểm chứng.
3. `tiktok-ads-mcp` đã được cấp token có quyền ghi, không chỉ quyền đọc.
4. Mốc thời gian 09:00 lấy theo múi giờ tài khoản quảng cáo, không phải múi giờ máy chủ.
