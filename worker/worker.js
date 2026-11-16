// Cloudflare Worker: asks MusicallyDown for a TikTok video's HD (pre-compression) link.
// Usage: GET https://<your-worker>.workers.dev/?url=<tiktok link>
// Returns JSON: { ok, hd, direct, proxied, filename } or { ok: false, error, debug }

const MUSICALDOWN = "https://musicaldown.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

// every attribute of one HTML tag, as an object
function attributes(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  const inner = tag.replace(/^<\s*[a-zA-Z]+/, "").replace(/\/?>$/, "");
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// the hidden + visible inputs of the form that posts to /download
function formFields(html) {
  const form = html.match(/<form[^>]*action=["'][^"']*\/download[^"']*["'][^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  return (form[1].match(/<input\b[^>]*>/gi) || []).map(attributes).filter((a) => a.name);
}

// download buttons, keyed by their data-event (hd_download_click, mp4_download_click, ...)
function buttons(html) {
  const out = {};
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    const a = attributes(tag);
    if (a["data-event"] && a.href) out[a["data-event"]] = decodeEntities(a.href);
  }
  return out;
}

function jwtPayload(token) {
  let part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  part += "=".repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(atob(part));
}

function cookiesFrom(response) {
  const list = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

async function musicaldown(videoUrl) {
  const debug = {};
  const base = { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" };

  const page = await fetch(MUSICALDOWN + "/en", { headers: base });
  debug.formStatus = page.status;
  const pageHtml = await page.text();
  const cookie = cookiesFrom(page);
  const fields = formFields(pageHtml);
  if (!fields || !fields.length) {
    debug.pageStart = pageHtml.slice(0, 300);
    return { ok: false, error: "MusicallyDown's form was not found (it may be blocking Cloudflare)", debug };
  }

  // field names are randomized per visit; the visible text input takes the link
  const body = new URLSearchParams();
  for (const f of fields) body.append(f.name, (f.type || "text") === "text" ? videoUrl : f.value || "");

  const result = await fetch(MUSICALDOWN + "/download", {
    method: "POST",
    body,
    headers: {
      ...base,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: MUSICALDOWN,
      Referer: MUSICALDOWN + "/en",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  debug.downloadStatus = result.status;
  const resultHtml = await result.text();
  const links = buttons(resultHtml);
  const hd = links["hd_download_click"];
  const proxied = hd || links["mp4_download_click"];
  if (!proxied) {
    debug.buttonsFound = Object.keys(links);
    debug.resultStart = resultHtml.slice(0, 300);
    return { ok: false, error: "MusicallyDown gave no video link (private/deleted video, or blocked)", debug };
  }

  // the button goes through MusicallyDown's proxy; the real file URL is inside its token
  let direct = proxied;
  let filename = null;
  const token = proxied.match(/[?&]token=([^&]+)/);
  if (token) {
    try {
      const payload = jwtPayload(decodeURIComponent(token[1]));
      direct = payload.url || proxied;
      filename = payload.filename || null;
    } catch (e) {}
  }
  return { ok: true, hd: Boolean(hd), direct, proxied, filename, debug };
}

// ---------- whole profiles ----------

const TIKTOK = "https://www.tiktok.com";
const IPAD_USER_AGENT =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function randomDeviceId() {
  return "72" + Array.from({ length: 17 }, () => Math.floor(Math.random() * 10)).join("");
}

// find the profile and its secUid (needed to list its posts)
async function profileInfo(username) {
  const tried = [];
  for (const ua of [IPAD_USER_AGENT, USER_AGENT]) {
    const r = await fetch(`${TIKTOK}/@${encodeURIComponent(username)}`, {
      headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9", Referer: TIKTOK + "/" },
    });
    const html = await r.text();
    tried.push(r.status);
    const m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) continue;
    const scope = JSON.parse(m[1]).__DEFAULT_SCOPE__ || {};
    const detail = scope["webapp.user-detail"] || {};
    const info = detail.userInfo || {};
    const secUid = info.user && info.user.secUid;
    if (!secUid) {
      if (detail.statusCode === 10222) return { ok: false, error: `@${username} is a private account` };
      return { ok: false, error: `could not find @${username} (check the username)` };
    }
    return {
      ok: true,
      username,
      nickname: info.user.nickname || username,
      userId: info.user.id || null,
      count: (info.stats && info.stats.videoCount) ?? null,
      secUid,
      cookie: cookiesFrom(r),
      device: randomDeviceId(),
      cursor: Date.now(),
    };
  }
  return { ok: false, error: "TikTok is blocking the profile page right now, try again in a minute", debug: { tried } };
}

// one page (about 15 posts) of a profile, walking back in time like the Python script
async function profilePage(p) {
  const query = new URLSearchParams({
    aid: "1988", app_language: "en", app_name: "tiktok_web", browser_language: "en-US",
    browser_name: "Mozilla", browser_online: "true", browser_platform: "Win32",
    browser_version: "5.0 (Windows)", channel: "tiktok_web", cookie_enabled: "true",
    count: "15", cursor: String(p.cursor), device_id: p.device, device_platform: "web_pc",
    focus_state: "true", from_page: "user", history_len: "2", is_fullscreen: "false",
    is_page_visible: "true", language: "en", os: "windows", priority_region: "",
    referer: "", region: "US", screen_height: "1080", screen_width: "1920",
    secUid: p.secUid, type: "1", tz_name: "UTC",
    verifyFp: "verify_" + Math.random().toString(16).slice(2, 9), webcast_language: "en",
  });
  const r = await fetch(`${TIKTOK}/api/creator/item_list/?${query}`, {
    headers: {
      "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", Referer: TIKTOK + "/",
      ...(p.cookie ? { Cookie: p.cookie } : {}),
    },
  });
  const body = await r.text();
  let page = {};
  try { page = body.trim() ? JSON.parse(body) : {}; } catch (e) {
    return { ok: false, error: "TikTok answered with something unexpected", debug: { status: r.status, start: body.slice(0, 200) } };
  }
  const list = page.itemList || [];
  const items = list.filter((i) => i.id).map((i) => {
    const photo = Boolean(i.imagePost);
    return {
      id: i.id,
      time: Number(i.createTime || 0),
      photo,
      desc: (i.desc || "").slice(0, 120),
      cover: (i.video && (i.video.cover || i.video.originCover)) ||
        (photo && i.imagePost.cover && i.imagePost.cover.imageURL && i.imagePost.cover.imageURL.urlList[0]) || null,
      images: photo ? (i.imagePost.images || []).map((im) => (im.imageURL && im.imageURL.urlList) || []) : [],
    };
  });

  let next = list.length ? Number(list[list.length - 1].createTime || 0) * 1000 : 0;
  if (!next || next === Number(p.cursor)) next = Number(p.cursor) - 7 * 86400000; // empty stretch: jump back a week
  const done = next < 1472706000000 || !page.hasMorePrevious;
  return { ok: true, items, cursor: next, done };
}


// a profile's current stories (TikTok's web story list, the same one gallery-dl uses)
async function storyPage(p) {
  const query = new URLSearchParams({
    aid: "1988", app_language: "en", app_name: "tiktok_web", browser_language: "en-US",
    browser_name: "Mozilla", browser_online: "true", browser_platform: "Win32",
    browser_version: "5.0 (Windows)", channel: "tiktok_web", cookie_enabled: "true",
    device_id: p.device, device_platform: "web_pc", focus_state: "true", from_page: "user",
    history_len: "2", is_fullscreen: "false", is_page_visible: "true", language: "en", os: "windows",
    priority_region: "", referer: "", region: "US", screen_height: "1080", screen_width: "1920",
    tz_name: "UTC", webcast_language: "en", authorId: p.authorId, loadBackward: "false", count: "5",
    cursor: String(p.cursor || 0),
  });
  const r = await fetch(`${TIKTOK}/api/story/item_list/?${query}`, {
    headers: {
      "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", Referer: TIKTOK + "/",
      ...(p.cookie ? { Cookie: p.cookie } : {}),
    },
  });
  const body = await r.text();
  let page = {};
  try { page = body.trim() ? JSON.parse(body) : {}; } catch (e) {
    return { ok: false, error: "TikTok's story list answered with something unexpected", debug: { status: r.status, start: body.slice(0, 200) } };
  }
  const list = page.itemList || page.ItemList || [];
  const items = list.filter((i) => i.id).map((i) => {
    const photo = Boolean(i.imagePost);
    const v = i.video || {};
    // best bitrate first, then the normal play address (both are watermark-free)
    const rates = (v.bitrateInfo || []).slice().sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));
    const videoUrls = [];
    for (const b of rates) for (const u of (b.PlayAddr && b.PlayAddr.UrlList) || []) videoUrls.push(u);
    if (v.playAddr) videoUrls.push(v.playAddr);
    return {
      id: i.id,
      time: Number(i.createTime || 0),
      photo,
      story: true,
      desc: (i.desc || "").slice(0, 120),
      cover: v.cover || v.originCover ||
        (photo && i.imagePost.cover && i.imagePost.cover.imageURL && i.imagePost.cover.imageURL.urlList[0]) || null,
      images: photo ? (i.imagePost.images || []).map((im) => (im.imageURL && im.imageURL.urlList) || []) : [],
      videoUrls: photo ? [] : [...new Set(videoUrls)],
    };
  });
  const more = page.HasMoreAfter ?? page.hasMoreAfter ?? page.hasMore ?? false;
  const cursor = page.MaxCursor ?? page.maxCursor ?? page.cursor ?? 0;
  return { ok: true, items, cursor, done: !more || !items.length, cookie: cookiesFrom(r) || undefined };
}

// stream a TikTok / MusicallyDown file back with CORS, so the page can save it with a proper name
const FILE_HOSTS = /(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|tokcdn\.com|muscdn\.app|ibyteimg\.com|tiktok\.com|byteoversea\.com|musicaldown\.com)$/i;

async function proxyFile(fileUrl, name, cookie) {
  let host;
  try { host = new URL(fileUrl).hostname; } catch (e) { return json({ ok: false, error: "bad file link" }, 400); }
  if (!FILE_HOSTS.test(host)) return json({ ok: false, error: "that host is not allowed" }, 400);
  const sendCookie = cookie && /(^|\.)tiktok\.com$/i.test(host);
  const r = await fetch(fileUrl, { headers: { "User-Agent": USER_AGENT, Referer: TIKTOK + "/", ...(sendCookie ? { Cookie: cookie } : {}) } });
  const type = r.headers.get("Content-Type") || "application/octet-stream";
  if (!r.ok || type.includes("html")) return json({ ok: false, error: `file server said ${r.status}` }, 502);
  const headers = { ...CORS, "Content-Type": type, "Access-Control-Expose-Headers": "Content-Length" };
  const length = r.headers.get("Content-Length");
  if (length) headers["Content-Length"] = length;
  if (name) headers["Content-Disposition"] = `attachment; filename="${name.replace(/[^\w.\-]/g, "_")}"`;
  return new Response(r.body, { headers });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const params = new URL(request.url).searchParams;
    try {
      if (params.get("file")) return await proxyFile(params.get("file"), params.get("name"), params.get("cookie"));
      if (params.get("stories")) {
        return json(await storyPage({
          authorId: params.get("stories"),
          cursor: params.get("cursor") || 0,
          device: params.get("device") || randomDeviceId(),
          cookie: params.get("cookie") || "",
        }));
      }
      if (params.get("profile")) {
        const username = params.get("profile").trim().replace(/^.*tiktok\.com\/@/i, "").replace(/^@/, "").replace(/[/?#].*$/, "");
        if (!/^[\w.]{1,40}$/.test(username)) return json({ ok: false, error: "that doesn't look like a username" }, 400);
        if (!params.get("secUid")) return json(await profileInfo(username));
        return json(await profilePage({
          secUid: params.get("secUid"),
          cursor: params.get("cursor") || Date.now(),
          device: params.get("device") || randomDeviceId(),
          cookie: params.get("cookie") || "",
        }));
      }
    } catch (e) {
      return json({ ok: false, error: String(e) }, 502);
    }
    const url = params.get("url");
    if (!url) return json({ ok: false, error: "add ?url=<tiktok link> or ?profile=<username> to the address" }, 400);
    if (!/^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(url))
      return json({ ok: false, error: "that is not a TikTok link" }, 400);
    try {
      return json(await musicaldown(url));
    } catch (e) {
      return json({ ok: false, error: String(e) }, 502);
    }
  },
};
