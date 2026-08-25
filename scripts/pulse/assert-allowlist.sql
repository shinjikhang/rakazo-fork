-- Khẳng định: bot TikTok Ads thấy đúng bộ tool đã chốt, không thiếu không dư,
-- và không server nào của nó mở toàn bộ tool.
--
-- Tham số (psql -v):
--   bot      tên hoặc id của bot            (mặc định 'TikTok Ads')
--   expected 14 lúc này, 18 sau khi bật 4 tool ghi ở H4 (mặc định 14)
-- Ví dụ: psql ... -v bot='TikTok Ads' -v expected=18 -f scripts/pulse/assert-allowlist.sql
\if :{?bot}
\else
  \set bot 'TikTok Ads'
\endif
\if :{?expected}
\else
  \set expected 14
\endif
\set ON_ERROR_STOP on

-- psql không thay biến bên trong chuỗi dollar-quoted, nên đưa tham số vào phiên
-- rồi đọc lại bằng current_setting.
SELECT set_config('pulse.bot', :'bot', false), set_config('pulse.expected', :'expected', false);

DO $$
DECLARE
  bot_ref text := current_setting('pulse.bot');
  expected_count int := current_setting('pulse.expected')::int;
  bot_id text;
  actual text[];
  expected text[];
  missing text[];
  extra text[];
  open_servers int;
BEGIN
  SELECT id INTO bot_id FROM bots WHERE id = bot_ref OR name = bot_ref;
  IF bot_id IS NULL THEN
    RAISE EXCEPTION 'không thấy bot %', bot_ref;
  END IF;

  expected := ARRAY[
    'cluega_tiktok_ad_manager_report_daily_summary',
    'cluega_tiktok_ad_manager_report_daily_trend',
    'cluega_tiktok_ad_manager_report_period_compare',
    'cluega_tiktok_ad_manager_report_creative_fatigue',
    'cluega_tiktok_ad_manager_report_ctr_decay',
    'cluega_tiktok_ad_manager_campaign_list',
    'cluega_tiktok_ad_manager_adgroup_list',
    'cluega_tiktok_ad_manager_ad_list',
    'tiktok_get_authorized_ad_accounts',
    'tiktok_get_campaigns',
    'tiktok_get_ad_groups',
    'tiktok_get_ads',
    'tiktok_get_ad_account_balance',
    'tiktok_recommend_bid'
  ];
  IF expected_count = 18 THEN
    expected := expected || ARRAY[
      'tiktok_update_ad_status',
      'tiktok_update_adgroup',
      'tiktok_update_adgroup_status',
      'tiktok_update_campaign_status'
    ];
  ELSIF expected_count <> 14 THEN
    RAISE EXCEPTION 'expected phải là 14 hoặc 18, không phải %', expected_count;
  END IF;

  SELECT coalesce(array_agg(tool ORDER BY tool), ARRAY[]::text[])
    INTO actual
    FROM bot_mcp_servers s,
         jsonb_array_elements_text(to_jsonb(s."allowedTools")) AS tool
   WHERE s."botId" = bot_id;

  SELECT count(*) INTO open_servers
    FROM bot_mcp_servers WHERE "botId" = bot_id AND "allowAllTools" = true;

  SELECT coalesce(array_agg(t), ARRAY[]::text[]) INTO missing
    FROM unnest(expected) AS t WHERE t <> ALL(actual);
  SELECT coalesce(array_agg(t), ARRAY[]::text[]) INTO extra
    FROM unnest(actual) AS t WHERE t <> ALL(expected);

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'thiếu tool: %', array_to_string(missing, ', ');
  END IF;
  IF array_length(extra, 1) > 0 THEN
    RAISE EXCEPTION 'dư tool: %', array_to_string(extra, ', ');
  END IF;
  IF array_length(actual, 1) <> expected_count THEN
    RAISE EXCEPTION 'allowedTools tổng cộng = %, kỳ vọng %', array_length(actual, 1), expected_count;
  END IF;
  IF open_servers <> 0 THEN
    RAISE EXCEPTION '% server của bot đang mở toàn bộ tool, kỳ vọng 0', open_servers;
  END IF;
  RAISE NOTICE 'allowlist đúng: % tool cho bot %, không server nào mở toàn bộ', expected_count, bot_ref;
END $$;
