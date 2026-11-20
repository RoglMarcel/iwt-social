// Insider Whale Terminal: Instagram + TikTok queue worker.
// Both networks are reached through Zernio (zernio.com), which holds the logins.
// Instagram publishes on the slot; once it is posted, a separate TikTok copy is
// sent, so a TikTok problem never blocks or repeats an Instagram post.
//
// Actions (JSON body): tick, status, set_key, connect_url, refresh_link,
// sign_upload, add_post. Caller is either the timer / CLI (header
// x-iwt-secret) or a signed-in, allow-listed website user (Authorization).
//
// Rule that shapes this file: a post must never go out twice. Every publish
// carries an Idempotency-Key, so a repeat of the same attempt cannot create a
// second post. A publish whose outcome stays unknown stops as `failed`.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const Z = "https://zernio.com/api/v1";
const SITE_ORIGINS = ["https://roglmarcel.github.io/iwt-social/", "http://localhost:4173/"];
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20 });

class ZError extends Error { // Zernio answered with an error.
  constructor(message: string, public status: number, public code: string, public body: any) { super(message); }
}
class ZNetworkError extends Error {} // No answer: the call may or may not have run.

async function z(method: string, path: string, key: string, opts: { body?: unknown; idem?: string; timeout?: number } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idem) headers["Idempotency-Key"] = opts.idem;
  let res: Response;
  try {
    res = await fetch(`${Z}${path}`, {
      method, headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeout ?? 25000),
    });
  } catch (_e) {
    throw new ZNetworkError("The posting service did not answer (network error or timeout)");
  }
  const text = await res.text();
  let j: any = {};
  try { j = JSON.parse(text); } catch (_e) { /* non-JSON body */ }
  if (!res.ok) {
    const msg = typeof j.error === "string" ? j.error : `HTTP ${res.status}`;
    throw new ZError(`Zernio: ${msg}`, res.status, String(j.code ?? ""), j);
  }
  return { status: res.status, data: j };
}

async function getKey(): Promise<string | null> {
  const [k] = await sql`select zernio_key from iwt.secrets where id = 1`;
  return k?.zernio_key ?? null;
}

const pickId = (o: any) => o?._id ?? o?.id ?? o?.accountId ?? null;

// Find the Instagram account connected at Zernio and remember it.
async function refreshLink(key: string, force = false): Promise<string | null> {
  const [s] = await sql`select zernio_account_id, zernio_profile_id, ig_checked_at from iwt.settings where id = 1`;
  const fresh = s.ig_checked_at && Date.now() - new Date(s.ig_checked_at).getTime() < 6 * 36e5;
  if (s.zernio_account_id && fresh && !force) return s.zernio_account_id;
  try {
    await refreshTikTok(key).catch(() => null);
    const { data } = await z("GET", "/accounts?platform=instagram", key);
    const list: any[] = (Array.isArray(data.accounts) ? data.accounts : []).filter((a: any) =>
      (a.platform ?? "instagram") === "instagram" && a.isActive !== false && a.status !== "disconnected");
    const prof = (a: any) => (typeof a.profileId === "object" ? pickId(a.profileId) : a.profileId);
    const acc = list.find((a) => s.zernio_profile_id && prof(a) === s.zernio_profile_id) ?? list[0];
    if (!acc) {
      await sql`update iwt.settings set zernio_account_id = null, ig_username = null, ig_checked_at = now(), ig_error = null where id = 1`;
      return null;
    }
    const id = String(pickId(acc));
    await sql`update iwt.settings set zernio_account_id = ${id},
              ig_username = ${acc.username ?? acc.displayName ?? acc.name ?? null},
              ig_checked_at = now(), ig_error = null where id = 1`;
    return id;
  } catch (e) {
    const msg = e instanceof ZError && e.status === 401
      ? "Zernio rejected the API key. Enter a new key."
      : (e as Error).message;
    await sql`update iwt.settings set ig_error = ${msg}, ig_checked_at = now() where id = 1`;
    throw new Error(msg);
  }
}

// Find the TikTok account connected at Zernio (same profile) and remember it.
async function refreshTikTok(key: string): Promise<string | null> {
  const [s] = await sql`select zernio_profile_id from iwt.settings where id = 1`;
  const { data } = await z("GET", "/accounts?platform=tiktok", key);
  const prof = (a: any) => (typeof a.profileId === "object" ? pickId(a.profileId) : a.profileId);
  const list: any[] = (Array.isArray(data.accounts) ? data.accounts : []).filter((a: any) =>
    a.platform === "tiktok" && a.isActive !== false && a.status !== "disconnected");
  const acc = list.find((a) => s.zernio_profile_id && prof(a) === s.zernio_profile_id) ?? list[0];
  const id = acc ? String(pickId(acc)) : null;
  await sql`update iwt.settings set zernio_tiktok_account_id = ${id},
            tiktok_username = ${acc ? (acc.username ?? acc.displayName ?? acc.name ?? null) : null} where id = 1`;
  return id;
}

// ---- TikTok copy: its own Zernio post, so a TikTok problem never blocks Instagram ----
function tiktokBody(post: any, accountId: string) {
  const media: string[] = Array.isArray(post.media) ? post.media : [];
  const base = { privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true,
                 content_preview_confirmed: true, express_consent_given: true };
  if (post.kind === "reel") {
    return { content: String(post.caption).slice(0, 2200),
             mediaItems: [{ type: "video", url: media[0] }],
             platforms: [{ platform: "tiktok", accountId }],
             tiktokSettings: { ...base, allow_duet: true, allow_stitch: true }, publishNow: true };
  }
  const hook = String(post.caption).split("\n")[0].replace(/#\S+/g, "").replace(/https?:\/\/\S+/g, "").trim();
  return { content: (hook || String(post.title).replace(/^C\d+\s*·\s*/, "")).slice(0, 90),
           mediaItems: media.map((url) => ({ type: "image", url })),
           platforms: [{ platform: "tiktok", accountId }],
           tiktokSettings: { ...base, media_type: "photo", photo_cover_index: 0,
                             description: String(post.caption).slice(0, 4000), auto_add_music: true },
           publishNow: true };
}

async function ttSettle(id: string, zpost: any): Promise<State> {
  const plat = (zpost?.platforms ?? []).find((p: any) => p.platform === "tiktok") ?? {};
  const url = typeof plat.platformPostUrl === "string" ? plat.platformPostUrl : null;
  if (plat.status === "published" || zpost?.status === "published") {
    await sql`update iwt.posts set tt_status = 'posted', tt_posted_at = coalesce(tt_posted_at, now()),
              tt_url = coalesce(${url}, tt_url), tt_error = null where id = ${id}`;
    return "posted";
  }
  if (["failed", "cancelled"].includes(plat.status) || ["failed", "cancelled"].includes(zpost?.status)) {
    await sql`update iwt.posts set tt_status = 'failed',
              tt_error = ${`TikTok refused the post: ${plat.errorMessage ?? "no reason given"}`} where id = ${id}`;
    return "failed";
  }
  return "processing";
}

async function ttStep(post: any, key: string, accountId: string): Promise<State> {
  if (post.tt_status === "queued") {
    await sql`update iwt.posts set tt_status = 'publishing', tt_started_at = now() where id = ${post.id}`;
    post.tt_started_at = new Date();
  }
  const ageMin = (Date.now() - new Date(post.tt_started_at).getTime()) / 6e4;
  if (post.tt_provider_id) {
    try {
      const { data } = await z("GET", `/posts/${post.tt_provider_id}`, key);
      const st = await ttSettle(post.id, data.post ?? data);
      if (st === "processing" && ageMin > 60) {
        await sql`update iwt.posts set tt_status = 'failed', tt_error = 'TikTok outcome unknown after 60 minutes. Check TikTok before you retry.' where id = ${post.id}`;
        return "failed";
      }
      return st;
    } catch (_e) { return "processing"; }
  }
  if (ageMin > 30) {
    await sql`update iwt.posts set tt_status = 'failed', tt_error = 'TikTok outcome unknown. Check TikTok before you retry.' where id = ${post.id}`;
    return "failed";
  }
  const idem = `tt-${post.id}-${new Date(post.tt_started_at).getTime()}`;
  try {
    const { data } = await z("POST", "/posts", key, { body: tiktokBody(post, accountId), idem, timeout: 55000 });
    const zpost = data.post ?? {};
    const pid = pickId(zpost);
    if (pid) await sql`update iwt.posts set tt_provider_id = ${String(pid)} where id = ${post.id}`;
    return await ttSettle(post.id, zpost);
  } catch (e) {
    if (e instanceof ZNetworkError) return "processing";
    const err = e as ZError;
    if (err.status >= 500 || err.status === 429 || err.code === "idempotency_conflict") return "processing";
    await sql`update iwt.posts set tt_status = 'failed', tt_error = ${err.message + ". Nothing was posted to TikTok."} where id = ${post.id}`;
    return "failed";
  }
}

async function tiktokPass(key: string, deadline: number) {
  const [s] = await sql`select zernio_tiktok_account_id, tiktok_enabled from iwt.settings where id = 1`;
  if (!s?.zernio_tiktok_account_id || !s.tiktok_enabled) return "";
  const counts = { posted: 0, processing: 0, failed: 0 };
  const work = await sql`select * from iwt.posts where tt_status in ('publishing', 'queued')
                         order by (tt_status = 'publishing') desc, posted_at limit 3`;
  for (const p of work) {
    if (Date.now() > deadline) break;
    counts[await ttStep(p, key, s.zernio_tiktok_account_id)]++;
  }
  // TikTok exposes the post link some minutes after publishing: fill it in later.
  const missing = await sql`select id, tt_provider_id from iwt.posts where tt_status = 'posted' and tt_url is null
                            and tt_provider_id is not null and tt_posted_at > now() - interval '3 hours' limit 3`;
  for (const p of missing) {
    if (Date.now() > deadline) break;
    try { const { data } = await z("GET", `/posts/${p.tt_provider_id}`, key); await ttSettle(p.id, data.post ?? data); } catch (_e) { /* later */ }
  }
  return work.length ? ` · TikTok: posted ${counts.posted}, processing ${counts.processing}, failed ${counts.failed}` : "";
}

// ---- Story: the post itself, posted as an Instagram Story after the post is live ----
// Instagram stories take video up to 60 seconds. A reel of 60s or less goes up as itself;
// a longer reel uses its 9:16 teaser image. A carousel uses its first slide.
const STORY_MAX_SECONDS = 60;

// Length of an MP4 in seconds, read from moov/mvhd.
async function mp4Seconds(url: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Could not read the reel video (HTTP ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = (at: number) => String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
  const box = (from: number, to: number, want: string) => {
    for (let at = from; at + 8 <= to;) {
      let size = dv.getUint32(at), head = 8;
      if (size === 1) { size = Number(dv.getBigUint64(at + 8)); head = 16; }
      else if (size === 0) size = to - at;
      if (size < head) throw new Error("Reel video has a broken MP4 box");
      if (type(at + 4) === want) return { at, head, end: at + size };
      at += size;
    }
    return null;
  };
  const moov = box(0, buf.length, "moov");
  if (!moov) throw new Error("Reel video has no moov box");
  const mvhd = box(moov.at + moov.head, moov.end, "mvhd");
  if (!mvhd) throw new Error("Reel video has no mvhd box");
  const v = mvhd.at + mvhd.head;
  return buf[v] === 1
    ? Number(dv.getBigUint64(v + 24)) / dv.getUint32(v + 20)
    : dv.getUint32(v + 16) / dv.getUint32(v + 12);
}

async function storyMedia(post: any): Promise<{ type: "image" | "video"; url: string }> {
  const media: string[] = post.media;
  if (post.kind === "carousel") return { type: "image", url: media[0] };
  const secs = await mp4Seconds(media[0]);
  if (secs <= STORY_MAX_SECONDS) return { type: "video", url: media[0] };
  if (!post.story_url) throw new Error(`The reel is ${Math.round(secs)}s, over the ${STORY_MAX_SECONDS}s story limit, and has no teaser image`);
  return { type: "image", url: post.story_url };
}

async function stSettle(id: string, zpost: any): Promise<State> {
  const plat = (zpost?.platforms ?? []).find((p: any) => p.platform === "instagram") ?? {};
  if (plat.status === "published" || zpost?.status === "published") {
    await sql`update iwt.posts set st_status = 'posted', st_posted_at = coalesce(st_posted_at, now()), st_error = null where id = ${id}`;
    return "posted";
  }
  if (["failed", "cancelled"].includes(plat.status) || ["failed", "cancelled"].includes(zpost?.status)) {
    await sql`update iwt.posts set st_status = 'failed',
              st_error = ${`Instagram refused the story: ${plat.errorMessage ?? "no reason given"}`} where id = ${id}`;
    return "failed";
  }
  return "processing";
}

async function stStep(post: any, key: string, accountId: string): Promise<State> {
  if (post.st_status === "queued") {
    await sql`update iwt.posts set st_status = 'publishing', st_started_at = now() where id = ${post.id}`;
    post.st_started_at = new Date();
  }
  const ageMin = (Date.now() - new Date(post.st_started_at).getTime()) / 6e4;
  if (post.st_provider_id) {
    try {
      const { data } = await z("GET", `/posts/${post.st_provider_id}`, key);
      const st = await stSettle(post.id, data.post ?? data);
      if (st === "processing" && ageMin > 60) {
        await sql`update iwt.posts set st_status = 'failed', st_error = 'Story outcome unknown after 60 minutes.' where id = ${post.id}`;
        return "failed";
      }
      return st;
    } catch (_e) { return "processing"; }
  }
  if (ageMin > 30) {
    await sql`update iwt.posts set st_status = 'failed', st_error = 'Story outcome unknown. Check Instagram before you retry.' where id = ${post.id}`;
    return "failed";
  }
  try {
    const body = { mediaItems: [await storyMedia(post)],
                   platforms: [{ platform: "instagram", accountId, platformSpecificData: { contentType: "story" } }],
                   publishNow: true };
    const { data } = await z("POST", "/posts", key, { body, idem: `st-${post.id}-${new Date(post.st_started_at).getTime()}`, timeout: 80000 });
    const zpost = data.post ?? {};
    const pid = pickId(zpost);
    if (pid) await sql`update iwt.posts set st_provider_id = ${String(pid)} where id = ${post.id}`;
    return await stSettle(post.id, zpost);
  } catch (e) {
    if (e instanceof ZNetworkError) return "processing";
    const err = e as ZError;
    if (err.status >= 500 || err.status === 429 || err.code === "idempotency_conflict") return "processing";
    await sql`update iwt.posts set st_status = 'failed', st_error = ${err.message + ". No story was posted."} where id = ${post.id}`;
    return "failed";
  }
}

async function storyPass(key: string, accountId: string, deadline: number) {
  const [s] = await sql`select story_enabled from iwt.settings where id = 1`;
  if (!s?.story_enabled) return "";
  const counts = { posted: 0, processing: 0, failed: 0 };
  const work = await sql`select * from iwt.posts where st_status in ('publishing', 'queued')
                         order by (st_status = 'publishing') desc, posted_at limit 3`;
  for (const p of work) {
    if (Date.now() > deadline) break;
    counts[await stStep(p, key, accountId)]++;
  }
  return work.length ? ` · Story: posted ${counts.posted}, processing ${counts.processing}, failed ${counts.failed}` : "";
}

// ---- Stats: views, likes and comments per post from Zernio analytics ----
// Each post is refreshed at most every 3 hours during its first 30 days (Zernio caches for 60 minutes).
async function statsPass(key: string, deadline: number) {
  const due = await sql`select id, provider_post_id from iwt.posts
                        where status = 'posted' and provider_post_id is not null and ig_permalink is not null
                          and posted_at > now() - interval '30 days'
                          and (stats_at is null or stats_at < now() - interval '3 hours')
                        order by stats_at nulls first, posted_at desc limit 5`;
  const counts = { updated: 0, failed: 0 };
  for (const p of due) {
    if (Date.now() > deadline) break;
    try {
      const { data } = await z("GET", `/analytics?postId=${encodeURIComponent(p.provider_post_id)}`, key);
      const a = data.analytics;
      if (typeof a?.views !== "number") throw new Error("Zernio analytics returned no view count");
      await sql`update iwt.posts set views = ${a.views}, likes = ${a.likes ?? null}, comments = ${a.comments ?? null},
                stats_at = now(), stats_error = null where id = ${p.id}`;
      counts.updated++;
    } catch (e) {
      await sql`update iwt.posts set stats_at = now(), stats_error = ${(e as Error).message} where id = ${p.id}`;
      counts.failed++;
    }
  }
  return due.length ? ` · Stats: updated ${counts.updated}, failed ${counts.failed}` : "";
}

async function fail(id: string, message: string) {
  await sql`update iwt.posts set status = 'failed', error = ${message}, publish_now = false where id = ${id}`;
}

type State = "posted" | "processing" | "failed";
const UNKNOWN = "Publish outcome unknown. Check Instagram for this post before you retry.";

// Read a Zernio post object and settle our row if it is final.
async function settle(id: string, zpost: any): Promise<State> {
  const plat = (zpost?.platforms ?? []).find((p: any) => p.platform === "instagram") ?? zpost?.platforms?.[0] ?? {};
  if (zpost?.status === "published" || plat.status === "published") {
    const url = typeof plat.platformPostUrl === "string" ? plat.platformPostUrl : null;
    await sql`update iwt.posts set status = 'posted', posted_at = now(), ig_media_id = ${String(pickId(zpost) ?? "")},
              ig_permalink = ${url}, error = null,
              tt_status = coalesce(tt_status, (select case when tiktok_enabled and zernio_tiktok_account_id is not null
                                                   then 'queued' else 'skipped' end from iwt.settings where id = 1)),
              st_status = coalesce(st_status, (select case when story_enabled then 'queued' else 'skipped' end
                                               from iwt.settings where id = 1))
              where id = ${id}`;
    return "posted";
  }
  if (["failed", "cancelled"].includes(plat.status) || (!plat.status && ["failed", "cancelled", "partial"].includes(zpost?.status))) {
    await fail(id, `Instagram refused the post: ${plat.errorMessage ?? "no reason given"}. Nothing was published.`);
    return "failed";
  }
  return "processing";
}

// Send one claimed post to Zernio. Safe to call again for the same claim:
// the Idempotency-Key is fixed per claim, so a repeat returns the first result.
async function publish(post: any, key: string, accountId: string): Promise<State> {
  const media: string[] = Array.isArray(post.media) ? post.media : [];
  if (!media.length || media.some((u) => typeof u !== "string" || !u.startsWith("https://"))) {
    await fail(post.id, "Media must be public https URLs. Nothing was published.");
    return "failed";
  }
  const idem = `iwt-${post.id}-${new Date(post.publishing_started_at).getTime()}`;
  await sql`update iwt.posts set publish_attempted_at = coalesce(publish_attempted_at, now()) where id = ${post.id}`;
  const body = {
    content: post.caption,
    mediaItems: media.map((url) => ({ type: /\.(mp4|mov)(\?|$)/i.test(url) ? "video" : "image", url })),
    platforms: [{ platform: "instagram", accountId }],
    publishNow: true,
  };
  let res: { status: number; data: any };
  try {
    res = await z("POST", "/posts", key, { body, idem, timeout: 80000 });
  } catch (e) {
    if (e instanceof ZNetworkError) return "processing"; // retried next pass with the same key
    const err = e as ZError;
    if (err.status >= 500 || err.status === 429 || err.code === "idempotency_conflict") return "processing";
    if (err.status === 409) {
      await fail(post.id, "Zernio refused a duplicate: this caption and media already went out in the last 24 hours. Check Instagram before you retry.");
    } else if (err.status === 401) {
      await sql`update iwt.settings set ig_error = 'Zernio rejected the API key. Enter a new key.' where id = 1`;
      await fail(post.id, "The Zernio API key was rejected. Nothing was published. Safe to retry after you fix the key.");
    } else if (err.code === "ACCOUNT_DISCONNECTED") {
      await sql`update iwt.settings set ig_error = 'Instagram is disconnected. Connect it again.' where id = 1`;
      await fail(post.id, "Instagram is disconnected. Reconnect it, then put this post back in the queue. Nothing was published.");
    } else {
      await fail(post.id, `${err.message}. Nothing was published. Safe to retry.`);
    }
    return "failed";
  }
  const zpost = res.data.post ?? {};
  const pid = pickId(zpost);
  if (pid) await sql`update iwt.posts set provider_post_id = ${String(pid)} where id = ${post.id}`;
  return await settle(post.id, zpost);
}

// Move one `publishing` post forward.
async function step(id: string, key: string, accountId: string): Promise<State> {
  const [post] = await sql`select * from iwt.posts where id = ${id}`;
  if (!post || post.status !== "publishing") return "failed";
  const ageMin = (Date.now() - new Date(post.publishing_started_at).getTime()) / 6e4;
  if (ageMin > 30) { await fail(id, UNKNOWN); return "failed"; }
  if (!post.provider_post_id) return await publish(post, key, accountId);
  try {
    const { data } = await z("GET", `/posts/${post.provider_post_id}`, key);
    return await settle(id, data.post ?? data);
  } catch (_e) {
    return "processing";
  }
}

const mins = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

async function tick() {
  const [lock] = await sql`update iwt.settings set tick_lock_until = now() + interval '3 minutes'
    where id = 1 and (tick_lock_until is null or tick_lock_until < now()) returning 1 as ok`;
  if (!lock) return { ok: true, note: "Another pass is running" };
  const began = Date.now();
  const counts = { posted: 0, processing: 0, failed: 0 };
  let note = "";
  try {
    const key = await getKey();
    if (!key) { note = "Instagram is not connected yet"; return { ok: false, note }; }
    const accountId = await refreshLink(key);
    if (!accountId) { note = "Instagram is not connected yet"; return { ok: false, note }; }
    const [s] = await sql`select * from iwt.settings where id = 1`;

    // 1. Posts already in flight.
    const flying = await sql`select id from iwt.posts where status = 'publishing' order by publishing_started_at`;
    for (const p of flying) {
      if (Date.now() - began > 30000) { counts.processing++; continue; }
      counts[await step(p.id, key, accountId)]++;
    }

    // 2. Claim new work: "post now" first, then due slots unless paused.
    const claimed: any[] = [...await sql`
      update iwt.posts set status = 'publishing', publishing_started_at = now(), publish_now = false,
             provider_post_id = null, publish_attempted_at = null
      where id in (select id from iwt.posts where status = 'approved' and publish_now order by position limit 2)
      returning *`];
    if (!s.paused) {
      const [loc] = await sql`select (now() at time zone ${s.timezone})::date::text as d,
                                     to_char(now() at time zone ${s.timezone}, 'HH24:MI') as hm`;
      for (const [i, slot] of (s.slots as any[]).entries()) {
        const late = mins(loc.hm) - mins(slot.time);
        if (late < 0 || late > s.grace_minutes) continue;
        claimed.push(...await sql`
          update iwt.posts set status = 'publishing', slot_date = ${loc.d}::date, slot_index = ${i},
                 publishing_started_at = now(), provider_post_id = null, publish_attempted_at = null
          where id = (select id from iwt.posts where status = 'approved' and kind = ${slot.kind}
                      order by position limit 1 for update skip locked)
            and not exists (select 1 from iwt.posts where slot_date = ${loc.d}::date and slot_index = ${i})
          returning *`);
      }
    }

    // 3. Publish. A publish can take a minute, so late ones wait for the next pass.
    for (const post of claimed) {
      if (Date.now() - began > 30000) { counts.processing++; continue; }
      counts[await publish(post, key, accountId)]++;
    }
    note = `posted ${counts.posted}, processing ${counts.processing}, failed ${counts.failed}`;
    note += await storyPass(key, accountId, began + 50000).catch((e) => ` · Story error: ${(e as Error).message}`);
    note += await tiktokPass(key, began + 70000).catch((e) => ` · TikTok error: ${(e as Error).message}`);
    note += await statsPass(key, began + 85000).catch((e) => ` · Stats error: ${(e as Error).message}`);
    return { ok: true, note, counts };
  } catch (e) {
    note = (e as Error).message;
    return { ok: false, note };
  } finally {
    await sql`update iwt.settings set tick_lock_until = null, last_tick_at = now(), last_tick_note = ${note} where id = 1`;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-iwt-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const service = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function allowed(req: Request): Promise<boolean> {
  const [k] = await sql`select cron_secret from iwt.secrets where id = 1`;
  const given = req.headers.get("x-iwt-secret");
  if (k && given && given === k.cron_secret) return true;
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const { data, error } = await service().auth.getUser(m[1]);
  const u = data?.user;
  if (error || !u?.email || !u.email_confirmed_at) return false;
  const [row] = await sql`select 1 as ok from iwt.admins where lower(email) = lower(${u.email})`;
  return !!row;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await allowed(req))) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));

  switch (body.action) {
    case "tick":
      return json(await tick());

    case "set_key": {
      const key = String(body.key ?? "").trim();
      if (!/^sk_[A-Za-z0-9_-]{16,200}$/.test(key)) return json({ error: "That does not look like a Zernio API key. It starts with sk_." }, 400);
      try {
        await z("GET", "/profiles", key);
      } catch (e) {
        if (e instanceof ZError && e.status === 401) return json({ error: "Zernio rejected this key. Copy it again from your Zernio dashboard." }, 400);
        return json({ error: (e as Error).message }, 502);
      }
      await sql`update iwt.secrets set zernio_key = ${key} where id = 1`;
      await sql`update iwt.settings set zernio_profile_id = null, zernio_account_id = null, ig_username = null,
                ig_checked_at = null, ig_error = null where id = 1`;
      const accountId = await refreshLink(key, true).catch(() => null);
      return json({ ok: true, connected: !!accountId });
    }

    case "connect_url": {
      const key = await getKey();
      if (!key) return json({ error: "Save your Zernio API key first." }, 400);
      const platform = body.platform === "tiktok" ? "tiktok" : "instagram";
      const back = String(body.redirect_url ?? "");
      if (!SITE_ORIGINS.some((o) => back === o || back.startsWith(o))) return json({ error: "Bad return address" }, 400);
      try {
        const [s] = await sql`select zernio_profile_id from iwt.settings where id = 1`;
        let profileId: string | null = s.zernio_profile_id;
        if (!profileId) {
          const { data } = await z("GET", "/profiles", key);
          const list: any[] = Array.isArray(data.profiles) ? data.profiles : [];
          const p = list.find((x) => x.isDefault) ?? list[0] ??
            (await z("POST", "/profiles", key, { body: { name: "Insider Whale Terminal" } })).data.profile;
          profileId = String(pickId(p));
          await sql`update iwt.settings set zernio_profile_id = ${profileId} where id = 1`;
        }
        const q = new URLSearchParams({ profileId, redirect_url: back });
        const { data } = await z("GET", `/connect/${platform}?${q}`, key);
        if (typeof data.authUrl !== "string" || !data.authUrl.startsWith("https://")) return json({ error: "Zernio gave no login address" }, 502);
        return json({ authUrl: data.authUrl });
      } catch (e) {
        return json({ error: (e as Error).message }, 502);
      }
    }

    case "refresh_link":
    case "status": {
      const key = await getKey();
      if (!key) return json({ connected: false, note: "No Zernio key saved" });
      try {
        const accountId = await refreshLink(key, true);
        const [s] = await sql`select ig_username, tiktok_username, zernio_tiktok_account_id from iwt.settings where id = 1`;
        return json({ connected: !!accountId, username: s.ig_username,
                      tiktok: !!s.zernio_tiktok_account_id, tiktok_username: s.tiktok_username });
      } catch (e) {
        return json({ connected: false, note: (e as Error).message });
      }
    }

    // Comment-to-DM automations (Zernio). op: list | logs | create | update | delete.
    case "automation": {
      const key = await getKey();
      if (!key) return json({ error: "No Zernio key saved" }, 400);
      const [s] = await sql`select zernio_profile_id, zernio_account_id from iwt.settings where id = 1`;
      const id = encodeURIComponent(String(body.automationId ?? ""));
      try {
        switch (String(body.op ?? "list")) {
          case "list":
            return json((await z("GET", `/comment-automations?profileId=${encodeURIComponent(s.zernio_profile_id)}`, key)).data);
          case "logs":
            return json((await z("GET", `/comment-automations/${id}/logs${body.status ? `?status=${encodeURIComponent(String(body.status))}` : ""}`, key)).data);
          case "create":
            return json((await z("POST", "/comment-automations", key, {
              body: { ...(body.config ?? {}), profileId: s.zernio_profile_id, accountId: s.zernio_account_id },
              idem: body.idem ? String(body.idem) : undefined })).data);
          case "update":
            return json((await z("PATCH", `/comment-automations/${id}`, key, { body: body.config ?? {} })).data);
          case "delete":
            return json((await z("DELETE", `/comment-automations/${id}`, key)).data);
          default:
            return json({ error: "Unknown op" }, 400);
        }
      } catch (e) {
        const err = e as ZError;
        return json({ error: err.message, status: err.status, details: err.body }, 502);
      }
    }

    case "sign_upload": {
      const path = String(body.path ?? "");
      if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/.test(path) || path.includes("..")) {
        return json({ error: "Bad path" }, 400);
      }
      const { data, error } = await service().storage.from("media").createSignedUploadUrl(path);
      if (error) return json({ error: error.message }, 400);
      return json({ signedUrl: data.signedUrl, publicUrl: `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/media/${path}` });
    }

    case "add_post": {
      const kind = body.kind;
      const media = Array.isArray(body.media) ? body.media.map(String) : [];
      if (kind !== "reel" && kind !== "carousel") return json({ error: "kind must be reel or carousel" }, 400);
      if (!body.title) return json({ error: "title is required" }, 400);
      const [row] = await sql`
        insert into iwt.posts (kind, title, caption, media, cover_url, evidence_note, created_by)
        values (${kind}, ${String(body.title)}, ${String(body.caption ?? "")}, ${sql.json(media)},
                ${body.cover_url ?? null}, ${body.evidence_note ?? null}, ${String(body.created_by ?? "claude")})
        returning id, status`;
      return json(row);
    }

    default:
      return json({ error: "Unknown action" }, 400);
  }
});
