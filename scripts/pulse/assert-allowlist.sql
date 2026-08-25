-- Khẳng định: bot chỉ thấy đúng 14 tool (tạm thời; thành 18 sau Task 3 khi bật 4 tool ghi), và không server nào mở toàn bộ tool.
\set ON_ERROR_STOP on

DO $$
DECLARE
  total int;
  open_servers int;
BEGIN
  SELECT coalesce(sum(jsonb_array_length(to_jsonb("allowedTools"))), 0)
    INTO total FROM bot_mcp_servers;
  SELECT count(*) INTO open_servers FROM bot_mcp_servers WHERE "allowAllTools" = true;

  IF total <> 14 THEN
    RAISE EXCEPTION 'allowedTools tổng cộng = %, kỳ vọng 14', total;
  END IF;
  IF open_servers <> 0 THEN
    RAISE EXCEPTION '% server đang mở toàn bộ tool, kỳ vọng 0', open_servers;
  END IF;
  RAISE NOTICE 'allowlist đúng: 14 tool, không server nào mở toàn bộ';
END $$;
