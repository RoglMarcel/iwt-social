-- 005: per-post Instagram stats, US posting times, Posted = last 24 hours.

-- Stats collected from Zernio GET /v1/analytics by the tick (every 3 hours per post, first 30 days).
alter table iwt.posts
  add column views int,
  add column likes int,
  add column comments int,
  add column stats_at timestamptz,
  add column stats_error text;

-- Post at US market times. Slot times are New York local time, so DST is handled by the timezone.
update iwt.settings set
  timezone = 'America/New_York',
  slots = '[{"kind":"reel","time":"09:30"},{"kind":"carousel","time":"12:00"},{"kind":"reel","time":"16:00"}]'::jsonb
where id = 1;

create or replace function iwt.snapshot()
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
  select jsonb_build_object(
    'now', now(),
    'local', (
      select jsonb_build_object(
        'date', (now() at time zone s.timezone)::date,
        'time', to_char(now() at time zone s.timezone, 'HH24:MI'),
        'dow', extract(isodow from now() at time zone s.timezone)::int)
      from iwt.settings s where s.id = 1),
    'settings', (
      select jsonb_build_object(
        'timezone', s.timezone, 'slots', s.slots, 'grace_minutes', s.grace_minutes,
        'paused', s.paused, 'ig_username', s.ig_username, 'ig_checked_at', s.ig_checked_at,
        'ig_error', s.ig_error, 'last_tick_at', s.last_tick_at, 'last_tick_note', s.last_tick_note,
        'has_key', k.zernio_key is not null,
        'has_token', k.zernio_key is not null and s.zernio_account_id is not null,
        'has_tiktok', k.zernio_key is not null and s.zernio_tiktok_account_id is not null,
        'tiktok_username', s.tiktok_username, 'tiktok_enabled', s.tiktok_enabled,
        'story_enabled', s.story_enabled)
      from iwt.settings s, iwt.secrets k where s.id = 1 and k.id = 1),
    'posts', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.position), '[]'::jsonb)
      from (
        select id, kind, title, status, position, left(caption, 240) as caption, media,
               jsonb_array_length(media) as media_count, error, publish_now,
               slot_date, slot_index, created_by, created_at, approved_at, tt_status, tt_error,
               story_url is not null as has_story
        from iwt.posts where status <> 'posted') p),
    -- Posted in the last 24 hours.
    'posted', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.posted_at desc), '[]'::jsonb)
      from (
        select id, kind, title, ig_permalink, posted_at, slot_date, slot_index, tt_status, tt_url, tt_error,
               st_status, st_error
        from iwt.posts where status = 'posted' and posted_at > now() - interval '24 hours') p),
    -- Posted on Instagram, but the story or the TikTok copy failed. Kept until fixed, whatever its age.
    'side_failed', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.posted_at desc), '[]'::jsonb)
      from (
        select id, kind, title, ig_permalink, posted_at, tt_status, tt_error, st_status, st_error
        from iwt.posts where status = 'posted' and (tt_status = 'failed' or st_status = 'failed')) p),
    'stats', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.posted_at desc), '[]'::jsonb)
      from (
        select id, kind, title, ig_permalink, posted_at, views, likes, comments, stats_at, stats_error,
               array(select m[1] from regexp_matches(caption, '#(\S+)', 'g') m) as hashtags
        from iwt.posts where status = 'posted' and ig_permalink is not null) p),
    'posted_7d', (
      select jsonb_build_object(
        'reel', count(*) filter (where kind = 'reel'),
        'carousel', count(*) filter (where kind = 'carousel'))
      from iwt.posts where status = 'posted' and posted_at > now() - interval '7 days')
  )
$function$;
