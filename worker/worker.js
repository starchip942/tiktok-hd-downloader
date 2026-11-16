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

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url).searchParams.get("url");
    if (!url) return json({ ok: false, error: "add ?url=<tiktok link> to the address" }, 400);
    if (!/^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(url))
      return json({ ok: false, error: "that is not a TikTok link" }, 400);
    try {
      return json(await musicaldown(url));
    } catch (e) {
      return json({ ok: false, error: String(e) }, 502);
    }
  },
};
