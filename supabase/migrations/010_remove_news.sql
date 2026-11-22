-- 010: a failed or expired news brief can be removed from the dashboard.
-- 'remove' hides it at once; the tick then deletes its files from storage and the row.
alter table iwt.posts add column removed_at timestamptz;

create or replace function iwt.act(p_action text, p_id uuid default null::uuid)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare
  me iwt.posts;
  nb iwt.posts;
  n  int;
begin
  if p_id is not null then
    select * into me from iwt.posts where id = p_id for update;
    if not found then raise exception 'Post % not found', p_id; end if;
  end if;

  case p_action
    when 'approve' then
      if me.status <> 'draft' then raise exception 'Only a draft can be approved (this one is %)', me.status; end if;
      n := jsonb_array_length(me.media);
      if me.kind = 'reel' and n <> 1 then raise exception 'A reel needs exactly 1 video, this one has %', n; end if;
      if me.kind = 'carousel' and (n < 2 or n > 10) then raise exception 'A carousel needs 2 to 10 slides, this one has %', n; end if;
      if btrim(me.caption) = '' then raise exception 'Add a caption before approving'; end if;
      update iwt.posts set status = 'approved', approved_at = now(), error = null where id = p_id;
    when 'unapprove' then
      if me.status <> 'approved' then raise exception 'Only a queued post can go back to drafts'; end if;
      if me.lane = 'news' then raise exception 'A news brief cannot go back to drafts'; end if;
      update iwt.posts set status = 'draft', approved_at = null, publish_now = false where id = p_id;
    when 'retry' then
      if me.status <> 'failed' then raise exception 'Only a failed post can be retried'; end if;
      if me.lane = 'news' then raise exception 'A news brief is only valid on its day and cannot be retried'; end if;
      update iwt.posts set status = 'approved', error = null, slot_date = null, slot_index = null,
             container_id = null, publish_attempted_at = null, publishing_started_at = null,
             publish_now = false
      where id = p_id;
    when 'remove' then
      if me.lane <> 'news' or me.status <> 'failed' then raise exception 'Only an expired or failed news brief can be removed'; end if;
      update iwt.posts set removed_at = now() where id = p_id;
    when 'tiktok_retry' then
      if me.tt_status is distinct from 'failed' then raise exception 'Only a failed TikTok copy can be retried'; end if;
      if me.media_purged_at is not null then raise exception 'The files of this post were deleted 2 days after posting, so TikTok cannot be retried'; end if;
      update iwt.posts set tt_status = 'queued', tt_error = null, tt_provider_id = null, tt_started_at = null where id = p_id;
    when 'up', 'down' then
      select * into nb from iwt.posts p
      where p.kind = me.kind and p.status = me.status and p.lane = me.lane
        and case when p_action = 'up' then p.position < me.position else p.position > me.position end
      order by case when p_action = 'up' then -p.position else p.position end
      limit 1 for update;
      if found then
        update iwt.posts set position = nb.position where id = me.id;
        update iwt.posts set position = me.position where id = nb.id;
      end if;
    when 'post_now' then
      if me.status <> 'approved' then raise exception 'Only an approved post can be posted now'; end if;
      update iwt.posts set publish_now = true where id = p_id;
      perform iwt.tick();
    when 'pause' then update iwt.settings set paused = true where id = 1;
    when 'resume' then update iwt.settings set paused = false where id = 1;
    when 'tiktok_on' then update iwt.settings set tiktok_enabled = true where id = 1;
    when 'tiktok_off' then update iwt.settings set tiktok_enabled = false where id = 1;
    when 'tick' then perform iwt.tick();
    else raise exception 'Unknown action %', p_action;
  end case;

  return iwt.snapshot();
end $function$;


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
        'story_enabled', s.story_enabled, 'news_fetched_at', s.news_fetched_at,
        'news_error', s.news_error, 'news_error_date', s.news_error_date)
      from iwt.settings s, iwt.secrets k where s.id = 1 and k.id = 1),
    'posts', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.position), '[]'::jsonb)
      from (
        select id, kind, lane, news_date, title, status, position, left(caption, 240) as caption, media,
               jsonb_array_length(media) as media_count, error, publish_now,
               slot_date, slot_index, created_by, created_at, approved_at, tt_status, tt_error,
               story_url is not null as has_story
        from iwt.posts where status <> 'posted' and removed_at is null) p),
    -- Posted in the last 24 hours.
    'posted', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.posted_at desc), '[]'::jsonb)
      from (
        select id, kind, lane, title, ig_permalink, posted_at, slot_date, slot_index, tt_status, tt_url, tt_error,
               st_status, st_error
        from iwt.posts where status = 'posted' and posted_at > now() - interval '24 hours') p),
    -- Posted on Instagram, but the story or the TikTok copy failed. Kept until fixed, whatever its age.
    'side_failed', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.posted_at desc), '[]'::jsonb)
      from (
        select id, kind, lane, title, ig_permalink, posted_at, tt_status, tt_error, st_status, st_error,
               media_purged_at is not null as purged
        from iwt.posts where status = 'posted' and (tt_status = 'failed' or st_status = 'failed')) p),
    'stats', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.views desc nulls last, p.posted_at desc), '[]'::jsonb)
      from (
        select id, kind, lane, title, ig_permalink, posted_at, views, likes, comments, stats_at, stats_error,
               array(select m[1] from regexp_matches(caption, '#(\S+)', 'g') m) as hashtags
        from iwt.posts where status = 'posted' and ig_permalink is not null
        order by views desc nulls last, posted_at desc limit 15) p),
    'posted_7d', (
      select jsonb_build_object(
        'reel', count(*) filter (where kind = 'reel'),
        'carousel', count(*) filter (where kind = 'carousel' and lane = 'regular'),
        'news', count(*) filter (where lane = 'news'))
      from iwt.posts where status = 'posted' and posted_at > now() - interval '7 days')
  )
$function$;
