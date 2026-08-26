# CDP — endpoint liệt kê kết nối cho Rakazo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hai endpoint internal cho phép Rakazo hỏi "có những tenant nào" và "tenant này đang nối những gì", để Rakazo tự tạo bot mà không cần CDP đẩy.

**Architecture:** Một repository đọc hợp nhất bằng `UNION ALL` qua các bảng kết nối trong schema của tenant, một usecase mỏng, một handler internal theo đúng khuôn `TikTokInternalHandler`. Không sửa bảng, không migration — cột `connected_by_user_id` đã có trên mọi model.

**Tech Stack:** Go, gin, gorm, hexagonal (`adapter/http/handler` → `usecase` → `adapter/repository/postgres`)

**Spec:** `docs/superpowers/specs/2026-08-26-cdp-connection-sync-design.md` (§5.1)

Repo: `~/Documents/Dev/cluega/cdp_backend`, nhánh hiện tại `feat/pulse-module`.

## Global Constraints

- **Không migration, không sửa bảng.** Cột `connected_by_user_id` đã có trên `model_tiktok.go:26`, `model_facebook.go`, `model_google_ads.go`, `model_tiktok_shop.go`, `model_composio.go`.
- Đường dẫn: `GET /internal/v1/tenants` và `GET /internal/v1/tenants/:tenant_id/connections`.
- Scope service auth mới: `tenants:connections:read`. Đăng ký bằng `d.ServiceAuthFor("tenants:connections:read")`, giống `router.go:2234`.
- Handler nhận resolver **có thể nil** và trả 503 khi nil — đúng khuôn `NewTikTokInternalHandler` (`handler/tiktok_internal.go:47-56`), để router đăng ký route được vô điều kiện lúc khởi động.
- Bảng trong phạm vi: `tiktok_connections`, `tiktok_shop_connections`, `facebook_connections`, `google_ads_connections`, `composio_connections`. **Ngoài phạm vi:** `line_connections`, `telegram_connections`.
- Không trả token, không trả secret. Chỉ id, loại, khoá, chủ, trạng thái.
- Không trả email — CDP không tra được email theo id (`usecase/auth/port.go:11` chỉ có `VerifyToken`). Rakazo tự sinh.
- Test: `go test ./...`. Build: `go build ./...`.

---

### Task 1: Repository đọc hợp nhất

**Files:**
- Create: `internal/adapter/repository/postgres/connection_inventory_repository.go`
- Test: `internal/adapter/repository/postgres/connection_inventory_repository_test.go`

**Interfaces:**
- Produces:
```go
package postgres

// ConnectionInventoryRow là một kết nối, đã chuẩn hoá qua mọi nền tảng.
type ConnectionInventoryRow struct {
    Kind              string    // "ads" | "composio"
    Key               string    // "tiktok" | "tiktok-shop" | "facebook" | "google-ads" | toolkit_key
    ConnectionID      uuid.UUID
    ConnectedByUserID uuid.UUID
    Status            string
}

func NewConnectionInventoryRepository(db *gorm.DB) *ConnectionInventoryRepository
func (r *ConnectionInventoryRepository) ListRows(ctx context.Context) ([]ConnectionInventoryRow, error)
```

- [ ] **Step 1: Viết test thất bại**

Tạo `internal/adapter/repository/postgres/connection_inventory_repository_test.go`. Test chỉ kiểm câu SQL được dựng đúng hình, không cần Postgres thật — dùng `gorm` với `DryRun: true`:

```go
package postgres

import (
    "strings"
    "testing"

    "gorm.io/gorm"
)

func TestConnectionInventoryQueryCoversEveryPlatformTable(t *testing.T) {
    sql := connectionInventoryQuery()
    for _, table := range []string{
        "tiktok_connections",
        "tiktok_shop_connections",
        "facebook_connections",
        "google_ads_connections",
        "composio_connections",
    } {
        if !strings.Contains(sql, table) {
            t.Fatalf("query does not read %s", table)
        }
    }
    for _, out := range []string{"line_connections", "telegram_connections"} {
        if strings.Contains(sql, out) {
            t.Fatalf("query reads %s, which is out of scope", out)
        }
    }
    if strings.Contains(strings.ToLower(sql), "token") {
        t.Fatal("inventory query must never select a token column")
    }
    if n := strings.Count(strings.ToUpper(sql), "UNION ALL"); n != 4 {
        t.Fatalf("expected 4 UNION ALL joins for 5 tables, got %d", n)
    }
    var _ *gorm.DB
}
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `go test ./internal/adapter/repository/postgres/ -run TestConnectionInventoryQuery`
Expected: FAIL — `undefined: connectionInventoryQuery`.

- [ ] **Step 3: Viết repository**

Tạo `internal/adapter/repository/postgres/connection_inventory_repository.go`:

```go
package postgres

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "gorm.io/gorm"
)

// ConnectionInventoryRow là một kết nối, đã chuẩn hoá qua mọi nền tảng.
type ConnectionInventoryRow struct {
    Kind              string
    Key               string
    ConnectionID      uuid.UUID
    ConnectedByUserID uuid.UUID
    Status            string
}

// ConnectionInventoryRepository đọc danh sách kết nối của tenant hiện tại.
//
// Vì sao là một câu UNION ALL chứ không phải năm lời gọi usecase: các
// ConnectionSummary của từng nền tảng có hình dạng khác nhau (so
// usecase/tiktokone/graph_types.go:95 với usecase/composio/port.go:106) và
// không cái nào đưa ra chủ sở hữu. Đọc thẳng năm bảng cho một hình dạng duy
// nhất, và không phải sửa năm usecase đang có người dùng khác.
type ConnectionInventoryRepository struct {
    db *gorm.DB
}

func NewConnectionInventoryRepository(db *gorm.DB) *ConnectionInventoryRepository {
    return &ConnectionInventoryRepository{db: db}
}

// connectionInventoryQuery không nhận tham số: schema của tenant do
// transaction hiện tại đặt (search_path), giống mọi repository khác ở đây.
func connectionInventoryQuery() string {
    return `
        SELECT 'ads' AS kind, 'tiktok' AS key, id AS connection_id,
               connected_by_user_id, status FROM tiktok_connections
        UNION ALL
        SELECT 'ads', 'tiktok-shop', id, connected_by_user_id, status
               FROM tiktok_shop_connections
        UNION ALL
        SELECT 'ads', 'facebook', id, connected_by_user_id, status
               FROM facebook_connections
        UNION ALL
        SELECT 'ads', 'google-ads', id, connected_by_user_id, status
               FROM google_ads_connections
        UNION ALL
        SELECT 'composio', toolkit_key, id, connected_by_user_id, status
               FROM composio_connections
    `
}

func (r *ConnectionInventoryRepository) ListRows(ctx context.Context) ([]ConnectionInventoryRow, error) {
    var rows []ConnectionInventoryRow
    if err := r.db.WithContext(ctx).Raw(connectionInventoryQuery()).Scan(&rows).Error; err != nil {
        return nil, fmt.Errorf("list connection inventory: %w", err)
    }
    return rows, nil
}
```

- [ ] **Step 4: Chạy test**

Run: `go test ./internal/adapter/repository/postgres/ -run TestConnectionInventoryQuery`
Expected: PASS.

- [ ] **Step 5: Kiểm câu SQL trên DB thật, chỉ đọc**

Lấy DSN từ `.env` của `cdp_backend`, rồi với một schema tenant có thật:

```bash
psql "$DSN" -c 'set search_path to "tenant_019e4394f597783983c95910622cb951"; ' -c "$(printf '%s' 'SELECT count(*) FROM tiktok_connections')"
```

Expected: chạy được. Nếu một bảng không tồn tại trong schema đó, ghi lại tên bảng đó — Task 2 phải chịu được bảng thiếu (xem Step 3 của Task 2). **Không** chạy lệnh ghi nào.

- [ ] **Step 6: Commit**

```bash
git add internal/adapter/repository/postgres/connection_inventory_repository.go internal/adapter/repository/postgres/connection_inventory_repository_test.go
git commit -m "feat: read a tenant's connections across every platform table"
```

---

### Task 2: Usecase, handler, route cho `/connections`

**Files:**
- Create: `internal/usecase/inventory/service.go`
- Create: `internal/adapter/http/handler/inventory_internal.go`
- Create: `internal/adapter/http/dto/inventory.go`
- Modify: `internal/adapter/http/router.go`
- Test: `internal/adapter/http/handler/inventory_internal_test.go`

**Interfaces:**
- Consumes: `postgres.ConnectionInventoryRow`, `postgres.ConnectionInventoryRepository.List` (Task 1).
- Produces:
```go
package inventory
type Connection struct {
    Kind, Key, Status string
    ConnectionID, ConnectedByUserID uuid.UUID
}
type Service struct{ /* transactor + repo */ }
func (s *Service) ListConnections(ctx context.Context) ([]Connection, error)
```

- [ ] **Step 1: Viết test thất bại**

Tạo `internal/adapter/http/handler/inventory_internal_test.go`. Theo khuôn `router_facebook_internal_test.go:123` dùng `middleware.MockServiceAuth`:

```go
package handler_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/gin-gonic/gin"
    "github.com/google/uuid"

    "cluega-cdp-backend/internal/adapter/http/handler"
    "cluega-cdp-backend/internal/adapter/http/middleware"
    "cluega-cdp-backend/internal/usecase/inventory"
)

type stubInventory struct {
    rows    []inventory.Connection
    tenants []uuid.UUID
    err     error
}

func (s stubInventory) ListConnections(_ context.Context) ([]inventory.Connection, error) {
    return s.rows, s.err
}

func (s stubInventory) ListTenants(_ context.Context) ([]uuid.UUID, error) {
    return s.tenants, s.err
}

func TestListConnectionsReturnsNoTokenField(t *testing.T) {
    gin.SetMode(gin.TestMode)
    owner := uuid.New()
    h := handler.NewInventoryInternalHandler(stubInventory{rows: []inventory.Connection{
        {Kind: "ads", Key: "tiktok", ConnectionID: uuid.New(), ConnectedByUserID: owner, Status: "active"},
    }})

    r := gin.New()
    g := r.Group("/internal/v1")
    g.Use(middleware.MockServiceAuth("rakazo", []string{"tenants:connections:read"}))
    g.GET("/tenants/:tenant_id/connections", h.ListConnections)

    w := httptest.NewRecorder()
    r.ServeHTTP(w, httptest.NewRequest(http.MethodGet,
        "/internal/v1/tenants/"+uuid.New().String()+"/connections", nil))

    if w.Code != http.StatusOK {
        t.Fatalf("status %d, body %s", w.Code, w.Body.String())
    }
    var body map[string]any
    if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
        t.Fatal(err)
    }
    raw := w.Body.String()
    for _, forbidden := range []string{"token", "secret", "access_token"} {
        if stringsContainsFold(raw, forbidden) {
            t.Fatalf("response leaks %q: %s", forbidden, raw)
        }
    }
    if !stringsContainsFold(raw, "connected_by_user_id") {
        t.Fatalf("response lacks connected_by_user_id: %s", raw)
    }
}

func TestListConnectionsReturns503WithoutResolver(t *testing.T) {
    gin.SetMode(gin.TestMode)
    h := handler.NewInventoryInternalHandler(nil)
    r := gin.New()
    r.GET("/internal/v1/tenants/:tenant_id/connections", h.ListConnections)
    w := httptest.NewRecorder()
    r.ServeHTTP(w, httptest.NewRequest(http.MethodGet,
        "/internal/v1/tenants/"+uuid.New().String()+"/connections", nil))
    if w.Code != http.StatusServiceUnavailable {
        t.Fatalf("status %d, want 503", w.Code)
    }
}

```

Thêm helper và import `context`, `strings`:

```go
func stringsContainsFold(haystack, needle string) bool {
    return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}
```


- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `go test ./internal/adapter/http/handler/ -run TestListConnections`
Expected: FAIL — `undefined: handler.NewInventoryInternalHandler`.

- [ ] **Step 3: Viết usecase**

Tạo `internal/usecase/inventory/service.go`. Sao khuôn `usecase/tiktokone/service.go:23` — `requireTenant` rồi `withinTx`:

```go
package inventory

import (
    "context"
    "fmt"

    "github.com/google/uuid"
)

type Connection struct {
    Kind              string
    Key               string
    ConnectionID      uuid.UUID
    ConnectedByUserID uuid.UUID
    Status            string
}

// Repository là cửa duy nhất ra Postgres.
type Repository interface {
    List(ctx context.Context) ([]Connection, error)
}

type Transactor interface {
    WithinTransaction(ctx context.Context, fn func(context.Context) error) error
}

type Service struct {
    transactor Transactor
    repo       Repository
}

func NewService(transactor Transactor, repo Repository) *Service {
    return &Service{transactor: transactor, repo: repo}
}

// ListConnections trả mọi kết nối của tenant trong ctx. Một bảng thiếu trong
// schema của tenant là lỗi cấu hình, không phải "không có kết nối": trả lỗi để
// Rakazo bỏ qua tenant đó thay vì thu hồi sạch bot của nó (nghiệm thu #9).
func (s *Service) ListConnections(ctx context.Context) ([]Connection, error) {
    var out []Connection
    err := s.transactor.WithinTransaction(ctx, func(txCtx context.Context) error {
        rows, err := s.repo.List(txCtx)
        if err != nil {
            return err
        }
        out = rows
        return nil
    })
    if err != nil {
        return nil, fmt.Errorf("list tenant connections: %w", err)
    }
    return out, nil
}
```

`postgres.ConnectionInventoryRepository` phải **thoả** `inventory.Repository`, nên method của nó
phải tên `List` và trả `[]inventory.Connection`. Thêm vào
`internal/adapter/repository/postgres/connection_inventory_repository.go`:

```go
// List thoả inventory.Repository.
func (r *ConnectionInventoryRepository) List(ctx context.Context) ([]inventory.Connection, error) {
    rows, err := r.ListRows(ctx)
    if err != nil {
        return nil, err
    }
    out := make([]inventory.Connection, 0, len(rows))
    for _, row := range rows {
        out = append(out, inventory.Connection{
            Kind:              row.Kind,
            Key:               row.Key,
            ConnectionID:      row.ConnectionID,
            ConnectedByUserID: row.ConnectedByUserID,
            Status:            row.Status,
        })
    }
    return out, nil
}
```

- [ ] **Step 4: Viết DTO và handler**

Tạo `internal/adapter/http/dto/inventory.go`:

```go
package dto

import "cluega-cdp-backend/internal/usecase/inventory"

type ConnectionItem struct {
    Kind              string `json:"kind"`
    Key               string `json:"key"`
    ConnectionID      string `json:"connection_id"`
    ConnectedByUserID string `json:"connected_by_user_id"`
    Status            string `json:"status"`
}

func NewConnectionItems(in []inventory.Connection) []ConnectionItem {
    out := make([]ConnectionItem, 0, len(in))
    for _, c := range in {
        out = append(out, ConnectionItem{
            Kind:              c.Kind,
            Key:               c.Key,
            ConnectionID:      c.ConnectionID.String(),
            ConnectedByUserID: c.ConnectedByUserID.String(),
            Status:            c.Status,
        })
    }
    return out
}
```

Tạo `internal/adapter/http/handler/inventory_internal.go`, theo đúng khuôn `tiktok_internal.go:47-100` (resolver nil → 503, `response.FromError`, `response.JSON`):

```go
package handler

import (
    "context"
    "net/http"

    "github.com/gin-gonic/gin"

    "cluega-cdp-backend/internal/adapter/http/dto"
    "cluega-cdp-backend/internal/adapter/http/response"
    "cluega-cdp-backend/internal/domain"
    "cluega-cdp-backend/internal/usecase/inventory"
)

// ConnectionLister là thứ handler cần từ usecase.
type ConnectionLister interface {
    ListConnections(ctx context.Context) ([]inventory.Connection, error)
}

type InventoryInternalHandler struct {
    lister ConnectionLister
}

// NewInventoryInternalHandler nhận nil được: mọi handler trả 503, để router
// đăng ký route vô điều kiện lúc khởi động.
func NewInventoryInternalHandler(lister ConnectionLister) *InventoryInternalHandler {
    return &InventoryInternalHandler{lister: lister}
}

// ListConnections godoc
// @Summary      List a tenant's active integration connections
// @Description  Metadata only: never a token. Consumed by Rakazo to provision bots.
// @Tags         inventory-internal
// @Produce      json
// @Param        tenant_id  path  string  true  "Tenant UUID"
// @Success      200  {object}  response.Success{data=[]dto.ConnectionItem}
// @Failure      400  {object}  response.Error
// @Failure      401  {object}  response.Error
// @Failure      503  {object}  response.Error
// @Security     ServiceBearerAuth
// @Router       /internal/v1/tenants/{tenant_id}/connections [get]
func (h *InventoryInternalHandler) ListConnections(c *gin.Context) {
    if h.lister == nil {
        response.FromError(c, domain.ErrServiceUnavailable)
        return
    }
    ctx, ok := tenantContextFromPath(c)
    if !ok {
        return
    }
    rows, err := h.lister.ListConnections(ctx)
    if err != nil {
        response.FromError(c, err)
        return
    }
    response.JSON(c, http.StatusOK, dto.NewConnectionItems(rows))
}
```

`tenantContextFromPath` phải dùng lại cách `tikTokTenantContext` (`handler/tiktok_internal.go`, tìm bằng `grep -n "func tikTokTenantContext" -A 20`) dựng context có tenant từ `:tenant_id`. Nếu hàm đó không tái dùng được vì gắn với TikTok, tách phần dựng tenant context ra một helper chung trong `handler` và cho cả hai dùng — **đừng sao chép nó**.

- [ ] **Step 5: Đăng ký route**

Trong `internal/adapter/http/router.go`, cạnh chỗ đăng ký `tiktokGroup` (~dòng 2233), thêm:

```go
	inventoryInternal := d.InventoryInternal
	if inventoryInternal == nil {
		inventoryInternal = handler.NewInventoryInternalHandler(nil)
	}
	inventoryGroup := r.Group("/internal/v1")
	inventoryGroup.Use(d.ServiceAuthFor("tenants:connections:read"))
	inventoryGroup.GET("/tenants/:tenant_id/connections", inventoryInternal.ListConnections)
```

Thêm `InventoryInternal *handler.InventoryInternalHandler` vào struct dependency của router (cùng chỗ khai báo `TikTokInternal`), và nối nó ở chỗ dựng ứng dụng (`grep -rn "TikTokInternal:" --include='*.go' internal/ cmd/` để tìm).

- [ ] **Step 6: Chạy test và build**

Run: `go build ./... && go test ./internal/adapter/http/... ./internal/usecase/inventory/...`
Expected: PASS.

- [ ] **Step 7: Kiểm bằng tay**

Với `cdp_backend` đang chạy ở cổng 8080 và khoá internal trong `.env`:

```bash
K=$(grep -E "^CDP_INTERNAL_API_KEY=" .env | cut -d= -f2- | tr -d "'\"")
TEN=019e4394-f597-7839-83c9-5910622cb951
curl -s "http://127.0.0.1:8080/internal/v1/tenants/$TEN/connections" -H "X-Internal-Key: $K" | head -c 600
```

Expected: JSON có `kind`, `key`, `connected_by_user_id`, `status`; **không** có chuỗi `token` ở bất kỳ đâu. Nếu 401, kiểm scope mới đã được cấp cho khoá đó chưa.

- [ ] **Step 8: Commit**

```bash
git add internal/usecase/inventory internal/adapter/http/handler/inventory_internal.go internal/adapter/http/handler/inventory_internal_test.go internal/adapter/http/dto/inventory.go internal/adapter/http/router.go internal/adapter/repository/postgres/connection_inventory_repository.go
git commit -m "feat: internal endpoint listing a tenant's connections"
```

---

### Task 3: `GET /internal/v1/tenants`

Rakazo kéo nên phải biết kéo cho ai. CDP đã có câu truy vấn liệt kê schema tenant — `app/app.go` dòng ~2430 dùng `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant\_%'`. Dùng lại đúng nguồn đó.

**Files:**
- Modify: `internal/adapter/repository/postgres/connection_inventory_repository.go`
- Modify: `internal/usecase/inventory/service.go`
- Modify: `internal/adapter/http/handler/inventory_internal.go`
- Modify: `internal/adapter/http/dto/inventory.go`
- Modify: `internal/adapter/http/router.go`
- Test: `internal/adapter/http/handler/inventory_internal_test.go`

**Interfaces:**
- Produces: `func (s *Service) ListTenants(ctx context.Context) ([]uuid.UUID, error)`; handler `ListTenants`.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `internal/adapter/http/handler/inventory_internal_test.go`:

```go
func TestListTenantsReturnsIDs(t *testing.T) {
    gin.SetMode(gin.TestMode)
    id := uuid.New()
    h := handler.NewInventoryInternalHandler(stubInventory{tenants: []uuid.UUID{id}})
    r := gin.New()
    r.GET("/internal/v1/tenants", h.ListTenants)
    w := httptest.NewRecorder()
    r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/internal/v1/tenants", nil))
    if w.Code != http.StatusOK {
        t.Fatalf("status %d, body %s", w.Code, w.Body.String())
    }
    if !stringsContainsFold(w.Body.String(), id.String()) {
        t.Fatalf("response lacks the tenant id: %s", w.Body.String())
    }
}
```

Thêm trường `tenants []uuid.UUID` vào `stubInventory` và một method `ListTenants(context.Context) ([]uuid.UUID, error)` trả nó.

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `go test ./internal/adapter/http/handler/ -run TestListTenants`
Expected: FAIL — `h.ListTenants` chưa tồn tại.

- [ ] **Step 3: Thêm repository, usecase, handler**

Repository — thêm vào `connection_inventory_repository.go`:

```go
// ListTenants đọc danh sách schema tenant. Nguồn sự thật là schema, giống
// vòng nền trong app.go — không có bảng đăng ký tenant nào khác.
func (r *ConnectionInventoryRepository) ListTenants(ctx context.Context) ([]uuid.UUID, error) {
    var names []string
    err := r.db.WithContext(ctx).Raw(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant\_%' ORDER BY schema_name
    `).Scan(&names).Error
    if err != nil {
        return nil, fmt.Errorf("list tenant schemas: %w", err)
    }
    out := make([]uuid.UUID, 0, len(names))
    for _, name := range names {
        raw := strings.TrimPrefix(name, "tenant_")
        id, err := uuid.Parse(raw)
        if err != nil {
            // Schema không mang UUID hợp lệ: bỏ qua, không làm hỏng cả danh sách.
            continue
        }
        out = append(out, id)
    }
    return out, nil
}
```

Lưu ý: schema thật là `tenant_019e4394f597783983c95910622cb951` — **không có dấu gạch ngang**. `uuid.Parse` nhận cả dạng 32 ký tự không gạch, nên đoạn trên chạy đúng; test Step 4 chứng minh điều đó.

Usecase — thêm `ListTenants` gọi thẳng repo, không cần transaction vì không phụ thuộc schema tenant nào:

```go
func (s *Service) ListTenants(ctx context.Context) ([]uuid.UUID, error) {
    return s.repo.ListTenants(ctx)
}
```

và thêm `ListTenants(ctx context.Context) ([]uuid.UUID, error)` vào interface `Repository` (định nghĩa ở Task 2 Step 3) — `ConnectionInventoryRepository` phải thoả cả hai method.

Handler:

```go
// ListTenants godoc
// @Summary      List tenant ids
// @Tags         inventory-internal
// @Produce      json
// @Success      200  {object}  response.Success{data=[]string}
// @Failure      503  {object}  response.Error
// @Security     ServiceBearerAuth
// @Router       /internal/v1/tenants [get]
func (h *InventoryInternalHandler) ListTenants(c *gin.Context) {
    if h.lister == nil {
        response.FromError(c, domain.ErrServiceUnavailable)
        return
    }
    ids, err := h.lister.ListTenants(c.Request.Context())
    if err != nil {
        response.FromError(c, err)
        return
    }
    out := make([]string, 0, len(ids))
    for _, id := range ids {
        out = append(out, id.String())
    }
    response.JSON(c, http.StatusOK, out)
}
```

Thêm `ListTenants` vào interface `ConnectionLister`.

Route — trong `router.go`, cạnh route ở Task 2:

```go
	inventoryGroup.GET("/tenants", inventoryInternal.ListTenants)
```

- [ ] **Step 4: Thêm test cho việc phân tích tên schema**

Thêm vào `internal/adapter/repository/postgres/connection_inventory_repository_test.go`:

```go
func TestTenantSchemaNameParsesWithoutDashes(t *testing.T) {
    id, err := uuid.Parse(strings.TrimPrefix("tenant_019e4394f597783983c95910622cb951", "tenant_"))
    if err != nil {
        t.Fatalf("a real tenant schema name must parse: %v", err)
    }
    if id.String() != "019e4394-f597-7839-83c9-5910622cb951" {
        t.Fatalf("parsed to %s", id.String())
    }
}
```

- [ ] **Step 5: Chạy test và build**

Run: `go build ./... && go test ./internal/adapter/... ./internal/usecase/inventory/...`
Expected: PASS.

- [ ] **Step 6: Kiểm bằng tay**

```bash
curl -s http://127.0.0.1:8080/internal/v1/tenants -H "X-Internal-Key: $K" | head -c 300
```

Expected: mảng UUID có dấu gạch ngang, chứa `019e4394-f597-7839-83c9-5910622cb951`.

- [ ] **Step 7: Commit**

```bash
git add internal/adapter internal/usecase/inventory
git commit -m "feat: internal endpoint listing tenant ids"
```

---

### Task 4: Ghi lại hợp đồng

**Files:**
- Create: `docs/internal-connection-inventory.md`

- [ ] **Step 1: Viết tài liệu**

```markdown
# Kiểm kê kết nối — endpoint internal cho Rakazo

    GET /internal/v1/tenants                        scope tenants:connections:read
    GET /internal/v1/tenants/{tenant}/connections   scope tenants:connections:read

Rakazo kéo hai endpoint này để tự tạo bot cho mỗi kết nối. CDP không đẩy gì sang Rakazo.

## Ràng buộc

- **Không bao giờ trả token hay secret.** Chỉ metadata. Có test chặn việc này
  (`inventory_internal_test.go`), vì đây là endpoint dễ bị "thêm một trường cho tiện".
- `connected_by_user_id` là người đã bấm OAuth, ghi lúc callback
  (`usecase/tiktokone/callback.go`). Kết nối quảng cáo thuộc **tenant**, nhưng cột này cho biết
  ai đã nối — Rakazo dùng nó làm chủ bot.
- Nguồn danh sách tenant là schema `tenant_%`, không phải một bảng đăng ký. Tên schema không có
  dấu gạch ngang; endpoint trả UUID có gạch.
- Bảng ngoài phạm vi: `line_connections`, `telegram_connections`. Thêm sau là thêm một nhánh
  `UNION ALL`, không phải một endpoint mới.
- Một bảng thiếu trong schema tenant là **lỗi**, không phải danh sách rỗng. Rakazo phải bỏ qua
  tenant đó chứ không thu hồi bot của nó.
```

- [ ] **Step 2: Commit**

```bash
git add docs/internal-connection-inventory.md
git commit -m "docs: describe the internal connection inventory endpoints"
```
