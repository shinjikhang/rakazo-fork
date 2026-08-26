# mcp_gateway — router gộp `/gateway/cluega/mcp`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một endpoint duy nhất, `/gateway/cluega/mcp`, trả `tools/list` hợp nhất của mọi upstream đang sống và định tuyến `tools/call` về đúng upstream — để Rakazo chỉ cần đăng ký **một** MCP server thay vì mười ba.

**Architecture:** Một tiền tố ảo (`/gateway/cluega`) không có upstream riêng. `tools/list` fan-out qua `state.GetTransports()`, gộp, khử trùng lặp, cache 60 giây, và **dựng chỉ mục `toolName → prefix` từ chính kết quả fan-out**. `tools/call` trên phiên gộp tra chỉ mục đó trước, rơi về `resolveToolPrefix` sau. Không thêm bảng định tuyến thứ ba; không đổi tiền tố cũ; không đổi tên tool.

**Tech Stack:** Go, gin, `internal/core`, `go test ./internal/core/...`

**Spec:** `docs/superpowers/specs/2026-08-26-cluega-mcp-connector-design.md` (§4.1, §4.2, §4.3)

## Ba phát hiện đã đo ngày 26/08 — đọc trước khi bắt đầu

1. **`tools/call` đã định tuyến chéo tiền tố.** `resolveToolPrefix` (`internal/core/tool_prefix.go:36`) đã ghi đè tiền tố phiên bằng tiền tố sở hữu tool. Router gộp **không cần** xây định tuyến mới cho lời gọi — chỉ cần một chỉ mục để phủ những tool mà hai bảng tên không biết (`cluega_tiktok_ad_manager_*`).
2. **Bảng định tuyến và cấu hình đã lệch nhau.** `platformToolRoutes` trỏ `google_` → `/gateway/google-mcp`, nhưng mọi config đặt tiền tố là `/gateway/google-ads-mcp`. Vì thế chỉ mục dựng từ fan-out là **bắt buộc**, không phải tối ưu: nó lấy tiền tố thật đã đăng ký, nên miễn nhiễm với lệch bảng. Không sửa `platformToolRoutes` trong plan này — sửa nó là thay đổi hành vi của `ai_agent`.
3. **`callGatewayTool` bị kiểm tra sau `GetProtoType`** (`streamable_dispatch.go:153-161`). Với tiền tố ảo, `GetProtoType` trả `""`, nên `ask_clarification` sẽ chết ở đó trước khi tới nhánh gateway-tool. Task 3 nhấc lời kiểm tra đó lên trước — thứ tự này vô hại với mọi tiền tố hiện có, vì gateway-tool xử lý y hệt ở cả hai vị trí.

## Global Constraints

- Tiền tố ảo, đúng chuỗi: `/gateway/cluega`. Endpoint đầy đủ: `/gateway/cluega/mcp`.
- **Không đổi hành vi của tiền tố cũ.** `/gateway/tiktok-mcp/mcp` vẫn phải trả đúng 249 tool sau mọi task.
- Chỉ chạm đường streamable-HTTP (`internal/core/streamable_dispatch.go`, `server_routes.go`). Đường SSE cũ (`internal/core/sse_message.go`) **ngoài phạm vi** — Rakazo dùng streamable-http; ghi rõ giới hạn này ở Task 4.
- Không sao chép `platformToolRoutes` / `ownerToolRoutes`. Không sửa nội dung hai bảng.
- Ba tool cấp gateway (`ask_clarification`, `recommend_ad_creatives`, `search_knowledge_base`) xuất hiện **đúng một lần** trong danh sách gộp.
- Một upstream chết chỉ mất tool của nó; danh sách gộp vẫn trả về.
- TTL cache: 60 giây. Cache **không** chứa dữ liệu theo tenant (khoá cache không có tenant, nên không được cache thứ gì phụ thuộc tenant).
- `__forwardHeaders` giữ nguyên ngữ nghĩa server-owned (`forward_stdio.go:32`) — plan này không chạm vào nó.
- Test: `go test ./internal/core/...`. Build: `go build ./...`.

---

### Task 1: Chấp nhận tiền tố ảo

**Files:**
- Create: `internal/core/aggregate.go`
- Modify: `internal/core/server_routes.go:134-139`
- Test: `internal/core/aggregate_test.go`

**Interfaces:**
- Produces: `const AggregatePrefix = "/gateway/cluega"` và `func isAggregatePrefix(prefix string) bool` trong package `core` — Task 2 và 3 dùng cả hai.

- [ ] **Step 1: Viết test thất bại**

Tạo `internal/core/aggregate_test.go`:

```go
package core

import "testing"

func TestIsAggregatePrefix(t *testing.T) {
	if !isAggregatePrefix(AggregatePrefix) {
		t.Fatalf("expected %q to be the aggregate prefix", AggregatePrefix)
	}
	if isAggregatePrefix("/gateway/tiktok-mcp") {
		t.Fatal("a real upstream prefix must not be treated as the aggregate")
	}
}
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `go test ./internal/core/ -run TestIsAggregatePrefix`
Expected: FAIL — `undefined: isAggregatePrefix`.

- [ ] **Step 3: Tạo `internal/core/aggregate.go`**

```go
package core

// AggregatePrefix is a virtual gateway prefix with no upstream of its own.
// A session opened here sees the union of every registered upstream's tools,
// so a client needs one MCP registration instead of one per platform.
const AggregatePrefix = "/gateway/cluega"

func isAggregatePrefix(prefix string) bool {
	return prefix == AggregatePrefix
}
```

- [ ] **Step 4: Chạy test**

Run: `go test ./internal/core/ -run TestIsAggregatePrefix`
Expected: PASS.

- [ ] **Step 5: Cho router qua cửa 404**

Trong `internal/core/server_routes.go`, khối kiểm `protoType` (dòng ~134) hiện trả 404 cho mọi tiền tố không có runtime. Tiền tố ảo không có runtime, nên phải qua trước:

```go
	protoType := currentState.GetProtoType(prefix)
	if protoType == "" && !isAggregatePrefix(prefix) {
		s.logger.Warn("invalid prefix",
			zap.String("prefix", prefix),
			zap.String("remote_addr", c.Request.RemoteAddr))
		s.sendProtocolError(c, nil, "Invalid prefix", http.StatusNotFound, mcp.ErrorCodeInvalidRequest)
		return
	}
```

- [ ] **Step 6: Build và chạy toàn bộ test của package**

Run: `go build ./... && go test ./internal/core/...`
Expected: PASS, không hồi quy.

- [ ] **Step 7: Kiểm bằng tay — handshake phải mở được**

Chạy gateway (`PORT 5235`), rồi:

```bash
curl -sS -X POST http://127.0.0.1:5235/gateway/cluega/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

Expected: kết quả `initialize` kèm header `mcp-session-id`, **không phải** `Invalid prefix`. Nếu vẫn 404, chỗ chặn nằm ở một cửa khác trên đường request — tìm nó bằng `grep -rn 'Invalid prefix' internal/` rồi mở đúng cửa đó theo cùng khuôn, không nới rộng hơn.

- [ ] **Step 8: Commit**

```bash
git add internal/core/aggregate.go internal/core/aggregate_test.go internal/core/server_routes.go
git commit -m "feat: accept the virtual /gateway/cluega prefix"
```

---

### Task 2: `tools/list` hợp nhất, có cache và chỉ mục

**Files:**
- Modify: `internal/core/aggregate.go`
- Modify: `internal/core/streamable_dispatch.go:84-138`
- Test: `internal/core/aggregate_test.go`

**Interfaces:**
- Consumes: `AggregatePrefix`, `isAggregatePrefix` (Task 1).
- Produces:
  - `func mergeUpstreamTools(fetched map[string][]mcp.ToolSchema, gatewayTools []mcp.ToolSchema) ([]mcp.ToolSchema, map[string]string)` — thuần, không I/O, trả (danh sách đã gộp, chỉ mục `toolName → prefix`). Tool cấp gateway có mặt đúng một lần và **không** vào chỉ mục (chúng do gateway tự phục vụ).
  - `func (s *Server) aggregateTools(ctx context.Context) ([]mcp.ToolSchema, map[string]string)` — fan-out + cache 60 giây.

- [ ] **Step 1: Viết test thất bại cho hàm gộp**

Thêm vào `internal/core/aggregate_test.go` (thêm `"github.com/amoylab/Cluega/pkg/mcp"` vào import của file test):

```go
func tool(name string) mcp.ToolSchema { return mcp.ToolSchema{Name: name} }

func TestMergeUpstreamToolsDeduplicatesGatewayTools(t *testing.T) {
	gatewayTools := []mcp.ToolSchema{tool("ask_clarification"), tool("search_knowledge_base")}
	fetched := map[string][]mcp.ToolSchema{
		"/gateway/tiktok-mcp": {tool("tiktok_get_campaigns"), tool("ask_clarification"), tool("search_knowledge_base")},
		"/gateway/utm-mcp":    {tool("build_utm_url"), tool("ask_clarification"), tool("search_knowledge_base")},
	}

	merged, index := mergeUpstreamTools(fetched, gatewayTools)

	counts := map[string]int{}
	for _, tl := range merged {
		counts[tl.Name]++
	}
	if counts["ask_clarification"] != 1 {
		t.Fatalf("ask_clarification appears %d times, want 1", counts["ask_clarification"])
	}
	if counts["search_knowledge_base"] != 1 {
		t.Fatalf("search_knowledge_base appears %d times, want 1", counts["search_knowledge_base"])
	}
	if counts["tiktok_get_campaigns"] != 1 || counts["build_utm_url"] != 1 {
		t.Fatal("upstream-owned tools must survive the merge exactly once")
	}
	if index["tiktok_get_campaigns"] != "/gateway/tiktok-mcp" {
		t.Fatalf("index routed tiktok_get_campaigns to %q", index["tiktok_get_campaigns"])
	}
	if index["build_utm_url"] != "/gateway/utm-mcp" {
		t.Fatalf("index routed build_utm_url to %q", index["build_utm_url"])
	}
	if _, ok := index["ask_clarification"]; ok {
		t.Fatal("gateway-level tools must not be routed to an upstream")
	}
}

func TestMergeUpstreamToolsIsDeterministicOnCollision(t *testing.T) {
	gatewayTools := []mcp.ToolSchema{}
	fetched := map[string][]mcp.ToolSchema{
		"/gateway/b-mcp": {tool("shared_tool")},
		"/gateway/a-mcp": {tool("shared_tool")},
	}
	for i := 0; i < 20; i++ {
		merged, index := mergeUpstreamTools(fetched, gatewayTools)
		if len(merged) != 1 {
			t.Fatalf("collision produced %d tools, want 1", len(merged))
		}
		if index["shared_tool"] != "/gateway/a-mcp" {
			t.Fatalf("collision resolved to %q, want the lexicographically first prefix", index["shared_tool"])
		}
	}
}
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `go test ./internal/core/ -run TestMergeUpstreamTools`
Expected: FAIL — `undefined: mergeUpstreamTools`.

- [ ] **Step 3: Viết hàm gộp**

Thêm vào `internal/core/aggregate.go` (thêm `"sort"` và `"github.com/amoylab/Cluega/pkg/mcp"` vào import):

```go
// mergeUpstreamTools unions every upstream's tools into one list and builds the
// name → prefix index used to route calls on an aggregate session.
//
// The index comes from the fan-out, not from platformToolRoutes: the tables key
// on tool-name prefixes and have already drifted from the configured prefixes
// (google_ → /gateway/google-mcp, while every config says google-ads-mcp). What
// an upstream actually advertised is the only routing fact that cannot drift.
//
// Gateway-level tools are injected into every upstream's list, so a naive union
// would repeat them once per upstream. They are dropped here and appended once,
// and never enter the index — the gateway serves them itself.
func mergeUpstreamTools(
	fetched map[string][]mcp.ToolSchema,
	gatewayTools []mcp.ToolSchema,
) ([]mcp.ToolSchema, map[string]string) {
	gatewayOwned := make(map[string]struct{}, len(gatewayTools))
	for _, tl := range gatewayTools {
		gatewayOwned[tl.Name] = struct{}{}
	}

	// Map iteration order is random; a stable order makes collision resolution
	// reproducible instead of a coin flip that changes per process.
	prefixes := make([]string, 0, len(fetched))
	for prefix := range fetched {
		prefixes = append(prefixes, prefix)
	}
	sort.Strings(prefixes)

	merged := make([]mcp.ToolSchema, 0, 512)
	index := make(map[string]string, 512)
	for _, prefix := range prefixes {
		for _, tl := range fetched[prefix] {
			if _, ok := gatewayOwned[tl.Name]; ok {
				continue
			}
			if owner, ok := index[tl.Name]; ok {
				aggregateLogCollision(tl.Name, owner, prefix)
				continue
			}
			index[tl.Name] = prefix
			merged = append(merged, tl)
		}
	}
	return append(merged, gatewayTools...), index
}
```

Và stub ghi log để test không cần logger:

```go
// aggregateLogCollision records a duplicate tool name. Silently overwriting one
// upstream's tool with another's is the hardest class of bug to trace back.
var aggregateLogCollision = func(name, keptPrefix, droppedPrefix string) {}
```

- [ ] **Step 4: Chạy test**

Run: `go test ./internal/core/ -run TestMergeUpstreamTools`
Expected: PASS cả hai test.

- [ ] **Step 5: Commit hàm thuần**

```bash
git add internal/core/aggregate.go internal/core/aggregate_test.go
git commit -m "feat: merge upstream tool lists with a routing index"
```

- [ ] **Step 6: Viết fan-out có cache**

Thêm vào `internal/core/aggregate.go` (import thêm `"context"`, `"sync"`, `"time"`, `"go.uber.org/zap"`):

```go
const aggregateCacheTTL = 60 * time.Second

type aggregateSnapshot struct {
	tools   []mcp.ToolSchema
	index   map[string]string
	fetched time.Time
}

var (
	aggregateMu    sync.Mutex
	aggregateCache *aggregateSnapshot
)

// aggregateTools fans out tools/list to every registered upstream and caches the
// union for aggregateCacheTTL. Without the cache, one bot start-up would mean a
// tools/list to every upstream — the single largest fragility in this design.
//
// The cache holds no tenant-scoped data: tool schemas are static per binary, so
// one snapshot is correct for every caller. Anything tenant-scoped must never be
// added here without keying the cache by tenant first.
func (s *Server) aggregateTools(ctx context.Context) ([]mcp.ToolSchema, map[string]string) {
	aggregateMu.Lock()
	cached := aggregateCache
	aggregateMu.Unlock()
	if cached != nil && time.Since(cached.fetched) < aggregateCacheTTL {
		return cached.tools, cached.index
	}

	fetched := make(map[string][]mcp.ToolSchema)
	for prefix, transport := range s.getState().GetTransports() {
		if isAggregatePrefix(prefix) {
			continue
		}
		tools, err := transport.FetchTools(ctx)
		if err != nil {
			// Partial degradation, matching mcp-connector.ts:71 on the Rakazo
			// side: one dead upstream hides its own tools, never anyone else's.
			s.logger.Warn("aggregate: upstream tools/list failed",
				zap.String("prefix", prefix), zap.Error(err))
			continue
		}
		fetched[prefix] = tools
	}

	tools, index := mergeUpstreamTools(fetched, s.gatewayToolSchemas())

	// A fan-out where every upstream failed is a blip, not a new truth: keep the
	// last good snapshot rather than caching an empty list for 60 seconds.
	if len(fetched) == 0 && cached != nil {
		return cached.tools, cached.index
	}

	aggregateMu.Lock()
	aggregateCache = &aggregateSnapshot{tools: tools, index: index, fetched: time.Now()}
	aggregateMu.Unlock()
	return tools, index
}
```

Nối log thật vào stub, trong cùng file:

```go
func (s *Server) initAggregateLogging() {
	aggregateLogCollision = func(name, keptPrefix, droppedPrefix string) {
		s.logger.Warn("aggregate: duplicate tool name",
			zap.String("tool", name),
			zap.String("kept", keptPrefix),
			zap.String("dropped", droppedPrefix))
	}
}
```

Gọi `s.initAggregateLogging()` ở cuối hàm khởi tạo `Server` — tìm bằng `grep -n "func NewServer" internal/core/server.go` và đặt ngay trước lệnh `return`.

- [ ] **Step 7: Nối vào `tools/list`**

Trong `internal/core/streamable_dispatch.go`, ngay đầu `case mcp.ToolsList:` (dòng ~84), **trước** `protoType := ...`:

```go
	case mcp.ToolsList:
		if isAggregatePrefix(conn.Meta().Prefix) {
			tools, _ := s.aggregateTools(c.Request.Context())
			s.sendSuccessResponse(c, conn, req, mcp.ListToolsResult{Tools: tools}, false)
			return
		}
		protoType := s.getState().GetProtoType(conn.Meta().Prefix)
```

- [ ] **Step 8: Build và chạy toàn bộ test**

Run: `go build ./... && go test ./internal/core/...`
Expected: PASS.

- [ ] **Step 9: Kiểm bằng tay — đếm tool**

Với gateway đang chạy và các upstream đã đăng ký:

```bash
node /Users/khanghuynh/Documents/Dev/cluega/rakazo-pulse/scripts/pulse/probe-mcp.mjs http://127.0.0.1:5235/gateway/cluega/mcp
node /Users/khanghuynh/Documents/Dev/cluega/rakazo-pulse/scripts/pulse/probe-mcp.mjs http://127.0.0.1:5235/gateway/tiktok-mcp/mcp
```

Expected: endpoint gộp trả nhiều tool hơn bất kỳ upstream đơn lẻ nào; `ask_clarification` xuất hiện đúng một lần; `/gateway/tiktok-mcp/mcp` vẫn ra 249 tool.

- [ ] **Step 10: Commit**

```bash
git add internal/core/aggregate.go internal/core/streamable_dispatch.go internal/core/server.go
git commit -m "feat: serve an aggregated tools/list on /gateway/cluega"
```

---

### Task 3: `tools/call` trên phiên gộp

**Files:**
- Modify: `internal/core/streamable_dispatch.go:140-175`
- Test: `internal/core/aggregate_test.go`

**Interfaces:**
- Consumes: `aggregateTools` (Task 2) cho chỉ mục; `resolveToolPrefix` (`tool_prefix.go:36`) làm đường lui.
- Produces: `func (s *Server) resolveAggregateToolPrefix(ctx context.Context, sessionPrefix, toolName string) string`.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `internal/core/aggregate_test.go`:

```go
func TestAggregateRoutePrefersTheIndex(t *testing.T) {
	index := map[string]string{"cluega_tiktok_ad_manager_report_daily_summary": "/gateway/cluega-tiktok-ad-manager-mcp"}
	got := routeFromAggregateIndex(index, "cluega_tiktok_ad_manager_report_daily_summary")
	if got != "/gateway/cluega-tiktok-ad-manager-mcp" {
		t.Fatalf("routed to %q, want the indexed prefix", got)
	}
	if routeFromAggregateIndex(index, "tiktok_get_campaigns") != "" {
		t.Fatal("an unindexed tool must fall through to resolveToolPrefix")
	}
}
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `go test ./internal/core/ -run TestAggregateRoute`
Expected: FAIL — `undefined: routeFromAggregateIndex`.

- [ ] **Step 3: Viết hàm tra chỉ mục**

Thêm vào `internal/core/aggregate.go`:

```go
// routeFromAggregateIndex returns the prefix that advertised toolName, or ""
// when the tool is not in the index (gateway-level tools, or a stale snapshot).
func routeFromAggregateIndex(index map[string]string, toolName string) string {
	return index[toolName]
}

// resolveAggregateToolPrefix routes a call made on the aggregate session. The
// fan-out index is authoritative because it records what an upstream actually
// advertised; resolveToolPrefix is the fallback for a tool that appeared after
// the last snapshot.
func (s *Server) resolveAggregateToolPrefix(ctx context.Context, sessionPrefix, toolName string) string {
	if !isAggregatePrefix(sessionPrefix) {
		return resolveToolPrefix(s.getState(), sessionPrefix, toolName)
	}
	_, index := s.aggregateTools(ctx)
	if prefix := routeFromAggregateIndex(index, toolName); prefix != "" {
		return prefix
	}
	return resolveToolPrefix(s.getState(), sessionPrefix, toolName)
}
```

- [ ] **Step 4: Chạy test**

Run: `go test ./internal/core/ -run TestAggregateRoute`
Expected: PASS.

- [ ] **Step 5: Nối vào `tools/call`, và nhấc kiểm tra gateway-tool lên trước**

Trong `internal/core/streamable_dispatch.go`, `case mcp.ToolsCall:`, thay khối từ `toolPrefix := resolveToolPrefix(...)` tới hết lời kiểm `callGatewayTool` (dòng ~152-166) bằng:

```go
		// Gateway-level tools are served here, so they must be checked before any
		// upstream lookup. On the aggregate prefix GetProtoType is empty by
		// design, and the old order failed these calls before reaching this line.
		if gwResult, handled := s.callGatewayTool(c.Request.Context(), params); handled {
			s.sendSuccessResponse(c, conn, req, gwResult, false)
			return
		}

		toolPrefix := s.resolveAggregateToolPrefix(c.Request.Context(), conn.Meta().Prefix, params.Name)
		protoType := s.getState().GetProtoType(toolPrefix)
		if protoType == "" {
			s.sendProtocolError(c, req.Id, "Server configuration not found", http.StatusInternalServerError, mcp.ErrorCodeInternalError)
			return
		}
```

- [ ] **Step 6: Build và chạy toàn bộ test**

Run: `go build ./... && go test ./internal/core/...`
Expected: PASS, không hồi quy trên các tiền tố cũ.

- [ ] **Step 7: Kiểm bằng tay — hai tool khác upstream, cùng một endpoint**

```bash
node /Users/khanghuynh/Documents/Dev/cluega/rakazo-pulse/scripts/pulse/call-tool.mjs \
  http://127.0.0.1:5235/gateway/cluega/mcp tiktok_get_campaigns
node /Users/khanghuynh/Documents/Dev/cluega/rakazo-pulse/scripts/pulse/call-tool.mjs \
  http://127.0.0.1:5235/gateway/cluega/mcp cluega_tiktok_ad_manager_report_daily_summary
```

Expected: cả hai trả dữ liệu thật (nghiệm thu #4). Nếu một cái trả `Server configuration not found`, tool đó không có trong chỉ mục **và** không khớp bảng tên — kiểm tra upstream của nó có đăng ký transport không.

- [ ] **Step 8: Kiểm bằng tay — danh tính không giả mạo được**

Gọi một tool qua endpoint gộp, nhét `__forwardHeaders` với tenant khác vào `arguments`, và xác nhận kết quả vẫn thuộc tenant của header HTTP (nghiệm thu #5). Đây là hành vi có sẵn của `injectForwardHeadersIntoToolParams`; bước này chỉ chứng minh router gộp không phá nó.

- [ ] **Step 9: Commit**

```bash
git add internal/core/aggregate.go internal/core/aggregate_test.go internal/core/streamable_dispatch.go
git commit -m "feat: route tools/call on the aggregate session"
```

---

### Task 4: Ghi lại hợp đồng và giới hạn

**Files:**
- Create: `docs/aggregate-prefix.md`

- [ ] **Step 1: Viết tài liệu**

```markdown
# `/gateway/cluega` — tiền tố gộp

Một tiền tố ảo, không có upstream riêng. `tools/list` trả hợp nhất tool của mọi upstream đang
đăng ký; `tools/call` định tuyến về upstream đã quảng cáo tool đó. Client (Rakazo) đăng ký một
MCP server thay vì mười ba.

## Điều cần biết

- **Chỉ streamable-HTTP.** Đường SSE cũ (`internal/core/sse_message.go`) không hỗ trợ tiền tố này.
- **Cache 60 giây**, tiến trình cục bộ. Tool mới của upstream xuất hiện chậm nhất sau 60 giây.
  Cache không chứa dữ liệu theo tenant; nếu về sau thêm lọc theo tenant, phải khoá cache theo
  tenant trước.
- **Suy giảm từng phần.** Upstream chết chỉ mất tool của nó. Nếu *mọi* upstream cùng hỏng, ảnh
  chụp tốt gần nhất được giữ lại thay vì cache một danh sách rỗng.
- **Định tuyến theo chỉ mục fan-out**, không theo `platformToolRoutes`. Hai bảng tên vẫn dùng cho
  các phiên gắn với một tiền tố cụ thể, và cho tool xuất hiện sau ảnh chụp gần nhất.
- **Trùng tên**: giữ upstream đầu tiên theo thứ tự tiền tố xếp chữ cái, và ghi log cảnh báo. Đo
  ngày 26/08: 371 tên tool của các upstream, không trùng cái nào. Ba tool cấp gateway
  (`ask_clarification`, `recommend_ad_creatives`, `search_knowledge_base`) có mặt ở mọi upstream
  và được khử trùng lặp thành một.
- **Tiền tố cũ không đổi.** `/gateway/tiktok-mcp/mcp` giữ nguyên hành vi; `ai_agent` không bị ảnh hưởng.

## Danh tính

Client gửi `x-tenant-id` / `x-user-id` bằng header HTTP. `__forwardHeaders` trong tham số tool vẫn
bị bỏ và dựng lại từ request đã xác thực (`forward_stdio.go:32`) — tiền tố gộp không nới lỏng điều này.
```

- [ ] **Step 2: Commit**

```bash
git add docs/aggregate-prefix.md
git commit -m "docs: describe the /gateway/cluega aggregate prefix"
```
