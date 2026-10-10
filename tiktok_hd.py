#!/usr/bin/env python
"""
Download TikTok videos in the highest quality available.

Sources, tried in order:
  musicaldown - submits the link to musicaldown.com and takes its "HD" link, which
                points to a large *_original.mp4 copy (not TikTok's compressed stream)
  tikwm       - tikwm.com public API with hd=1 (TikTok's own higher-bitrate copy)

Both are undocumented third-party services and can break or change at any time.

Usage:
  python tiktok_hd.py https://vt.tiktok.com/XXXX/ [more links...] [--out DIR] [--source auto|musicaldown|tikwm]
"""

from argparse import ArgumentParser
from base64 import urlsafe_b64decode
from json import loads
from os import makedirs, path, replace
from re import search, sub

from bs4 import BeautifulSoup
from requests import Session

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
MUSICALDOWN = "https://musicaldown.com"
TIKWM_API = "https://www.tikwm.com/api/"


def new_session():
    '''
    requests session that looks like a normal browser
    '''
    session = Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})
    return session


def jwt_payload(token):
    '''
    decode the (unverified) payload of a JWT
    '''
    part = token.split(".")[1]
    return loads(urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def from_musicaldown(session, url):
    '''
    submit the link to musicaldown and return (direct_url, name) for its HD download
    '''
    page = session.get(MUSICALDOWN + "/en", timeout=30)
    page.raise_for_status()
    form = BeautifulSoup(page.text, "lxml").find("form")
    if form is None:
        raise RuntimeError("musicaldown: download form not found")

    # field names are randomized per session, the visible text input takes the link
    data = {}
    for field in form.find_all("input"):
        if not field.get("name"):
            continue
        data[field["name"]] = url if field.get("type", "text") == "text" else field.get("value", "")

    result = session.post(MUSICALDOWN + "/download", data=data, timeout=60,
                          headers={"Origin": MUSICALDOWN, "Referer": MUSICALDOWN + "/en"})
    result.raise_for_status()
    links = {a.get("data-event"): a["href"] for a in BeautifulSoup(result.text, "lxml").select("a.download[href]")}
    href = links.get("hd_download_click") or links.get("mp4_download_click")
    if not href:
        raise RuntimeError("musicaldown: no video link in the response (bad link, private video, or the site changed)")

    # the button goes through musicaldown's proxy, the real file URL is inside its token
    direct, name = href, None
    token = search(r"[?&]token=([^&]+)", href)
    if token:
        try:
            payload = jwt_payload(token.group(1))
            direct, name = payload.get("url") or href, payload.get("filename")
        except ValueError:
            pass
    return direct, name, href


def from_tikwm(session, url):
    '''
    ask the tikwm API and return (direct_url, name) for its best video
    '''
    response = session.post(TIKWM_API, data={"url": url, "hd": 1}, timeout=60)
    response.raise_for_status()
    body = response.json()
    if body.get("code") != 0:
        raise RuntimeError("tikwm: " + str(body.get("msg")))
    data = body["data"]
    return data.get("hdplay") or data["play"], data.get("id"), None


def video_id(session, url, fallback):
    '''
    numeric TikTok video id from the link (short links are followed), or the fallback name
    '''
    found = search(r"/(?:video|photo)/(\d+)", url) or search(r"(\d{15,})_original", fallback or "")
    if not found:
        try:
            found = search(r"/(?:video|photo)/(\d+)", session.head(url, allow_redirects=True, timeout=30).url)
        except Exception:
            found = None
    if found:
        return found.group(1)
    return sub(r"[^\w\-\[\]]+", "_", fallback or "tiktok").strip("_")


def save(session, urls, target):
    '''
    stream the first URL that works into target, return its size in bytes
    '''
    error = None
    for url in urls:
        if not url:
            continue
        try:
            with session.get(url, stream=True, timeout=60, headers={"Referer": "https://www.tiktok.com/"}) as response:
                response.raise_for_status()
                if "html" in response.headers.get("Content-Type", ""):
                    raise RuntimeError("got a web page instead of a video")
                temp = target + ".part"
                size = 0
                with open(temp, "wb") as file:
                    for chunk in response.iter_content(1024 * 256):
                        file.write(chunk)
                        size += len(chunk)
            replace(temp, target)
            return size
        except Exception as e:
            error = e
    raise RuntimeError("download failed: " + str(error))


def download(url, out_dir, source):
    '''
    download one TikTok link, return the saved file path
    '''
    session = new_session()
    sources = {"musicaldown": from_musicaldown, "tikwm": from_tikwm}
    order = ["musicaldown", "tikwm"] if source == "auto" else [source]
    for name in order:
        try:
            direct, label, proxied = sources[name](session, url)
            target = path.join(out_dir, "{}_{}.mp4".format(video_id(session, url, label or direct.rsplit("/", 1)[-1]), name))
            size = save(session, [direct, proxied], target)
            print("[{}] {} -> {} ({:.2f} MB)".format(name, url, target, size / 1048576))
            return target
        except Exception as e:
            print("[{}] {} failed: {}".format(name, url, e))
    return None


def main():
    parser = ArgumentParser(description="Download TikTok videos in the highest quality available")
    parser.add_argument("urls", nargs="+", help="TikTok video links")
    parser.add_argument("--out", default=path.join("~", "Documents", "TikTok Outputs"), help="Folder to save videos in")
    parser.add_argument("--source", choices=["auto", "musicaldown", "tikwm"], default="auto", help="Where to get the video from (auto tries musicaldown, then tikwm)")
    args = parser.parse_args()

    out_dir = path.abspath(path.expanduser(args.out))
    makedirs(out_dir, exist_ok=True)
    failed = [url for url in args.urls if not download(url, out_dir, args.source)]
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
