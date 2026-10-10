#!/usr/bin/env python3
"""
Download every video from a TikTok profile in max quality (MusicallyDown's HD file),
one by one. Made for the a-Shell app on iPad, so it only uses the Python standard library.

Videos are saved to  a-Shell/TikTok Outputs/<username>/  in the Files app
(~/Documents/TikTok Outputs/<username>/), named <upload date>_<video id>.mp4.
Videos that are already there are skipped, so running it again continues where it
stopped and retries anything that failed.

Usage in a-Shell:
  python3 tiktok_profile_hd.py                (asks for the username)
  python3 tiktok_profile_hd.py someuser
"""

from argparse import ArgumentParser
from base64 import urlsafe_b64decode
from datetime import datetime, timezone
from html.parser import HTMLParser
from http.cookiejar import CookieJar
from json import loads
from os import listdir, makedirs, path, remove, replace
from random import choices, randint, uniform
from re import findall, search, sub
from socket import setdefaulttimeout
from string import hexdigits
from sys import stdout
from time import sleep, time
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
IPAD_USER_AGENT = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
MUSICALDOWN = "https://musicaldown.com"
TIKTOK = "https://www.tiktok.com"
OUTPUTS = path.join("~", "Documents", "TikTok Outputs")


class Browser:
    '''
    tiny urllib wrapper that keeps cookies between requests
    '''

    def __init__(self, user_agent=USER_AGENT):
        self.user_agent = user_agent
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))

    def open(self, url, data=None, headers=None, timeout=60):
        request = Request(url, data=urlencode(data).encode() if data else None,
                          headers={"User-Agent": self.user_agent, "Accept-Language": "en-US,en;q=0.9", **(headers or {})})
        return self.opener.open(request, timeout=timeout)

    def text(self, url, data=None, headers=None):
        with self.open(url, data, headers) as response:
            return response.read().decode("utf-8", "replace")


class MusicalDownPage(HTMLParser):
    '''
    collects the download form fields and the download buttons from a musicaldown page
    '''

    def __init__(self):
        super().__init__()
        self.in_form, self.fields, self.buttons = False, [], {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form" and "/download" in (attrs.get("action") or ""):
            self.in_form = True
        elif tag == "input" and self.in_form and attrs.get("name"):
            self.fields.append(attrs)
        elif tag == "a" and attrs.get("data-event") and attrs.get("href"):
            self.buttons[attrs["data-event"]] = attrs["href"]

    def handle_endtag(self, tag):
        if tag == "form":
            self.in_form = False


def parse(html):
    page = MusicalDownPage()
    page.feed(html)
    return page


def page_data(html):
    '''
    the JSON TikTok embeds in its pages, or None
    '''
    data = search(r'<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', html)
    return loads(data.group(1)).get("__DEFAULT_SCOPE__", {}) if data else None


def tiktok_page(url):
    '''
    get a TikTok page's embedded JSON and the browser that got it. TikTok sometimes
    answers with a bot check page instead, so try as iPad Safari and desktop Chrome
    and wait a bit between rounds
    '''
    for attempt in range(3):
        for user_agent in (IPAD_USER_AGENT, USER_AGENT):
            print("  opening {} ...".format(url))
            browser = Browser(user_agent)
            try:
                data = page_data(browser.text(url, headers={"Referer": TIKTOK + "/"}))
            except Exception as e:
                print("  could not open it: {}".format(e))
                continue
            if data is not None:
                return data, browser
        print("  TikTok is blocking the page, waiting {} seconds...".format(30 * (attempt + 1)))
        sleep(30 * (attempt + 1))
    raise RuntimeError("TikTok keeps blocking the page, try again later")


def jwt_payload(token):
    '''
    decode the (unverified) payload of a JWT
    '''
    part = token.split(".")[1]
    return loads(urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def profile_videos(username):
    '''
    list every post on a profile, newest first, as dicts with id, time and is_photo
    '''
    data, browser = tiktok_page("{}/@{}".format(TIKTOK, username))
    detail = data.get("webapp.user-detail", {})
    user = detail.get("userInfo", {})
    sec_uid = user.get("user", {}).get("secUid")
    if not sec_uid:
        if detail.get("statusCode") == 10222:
            raise RuntimeError("@{} is a private account".format(username))
        raise RuntimeError("could not find @{} (check the username)".format(username))
    print("@{}: TikTok says {} posts".format(username, user.get("stats", {}).get("videoCount", "?")))

    # same paging as yt-dlp: walk back in time using the oldest createTime of each page
    videos, seen = [], set()
    device_id = str(randint(7250000000000000000, 7325099899999994577))
    cursor, repeats = int(time() * 1000), 0
    while True:
        query = {
            "aid": "1988", "app_language": "en", "app_name": "tiktok_web", "browser_language": "en-US",
            "browser_name": "Mozilla", "browser_online": "true", "browser_platform": "Win32",
            "browser_version": "5.0 (Windows)", "channel": "tiktok_web", "cookie_enabled": "true",
            "count": "15", "cursor": cursor, "device_id": device_id, "device_platform": "web_pc",
            "focus_state": "true", "from_page": "user", "history_len": "2", "is_fullscreen": "false",
            "is_page_visible": "true", "language": "en", "os": "windows", "priority_region": "",
            "referer": "", "region": "US", "screen_height": "1080", "screen_width": "1920",
            "secUid": sec_uid, "type": "1", "tz_name": "UTC",
            "verifyFp": "verify_" + "".join(choices(hexdigits, k=7)), "webcast_language": "en",
        }
        body = browser.text(TIKTOK + "/api/creator/item_list/?" + urlencode(query), headers={"Referer": TIKTOK + "/"})
        page = loads(body) if body.strip() else {}
        items = page.get("itemList") or []
        new = [item for item in items if item.get("id") and item["id"] not in seen]
        if items and not new:
            # TikTok keeps sending the same page, a fresh device id usually fixes it
            repeats += 1
            if repeats > 3:
                break
            device_id = str(randint(7250000000000000000, 7325099899999994577))
            continue
        repeats = 0
        for item in new:
            seen.add(item["id"])
            videos.append({"id": item["id"], "time": int(item.get("createTime") or 0), "is_photo": "imagePost" in item})
        print("  found {} so far...".format(len(videos)))

        old_cursor = cursor
        cursor = int(items[-1].get("createTime", 0)) * 1000 if items else 0
        if not cursor or cursor == old_cursor:
            # nothing posted in this stretch, jump back a week
            cursor = old_cursor - 7 * 86400000
        if cursor < 1472706000000 or not page.get("hasMorePrevious"):
            break
        sleep(uniform(1, 2))
    return videos


def musicaldown_link(video_url):
    '''
    submit one video to musicaldown, return (direct HD url, proxied url, is_hd)
    '''
    browser = Browser()
    form = parse(browser.text(MUSICALDOWN + "/en"))
    if not form.fields:
        raise RuntimeError("musicaldown: download form not found")

    # field names are randomized per visit, the visible text input takes the link
    data = {field["name"]: video_url if field.get("type", "text") == "text" else field.get("value", "") for field in form.fields}
    result = parse(browser.text(MUSICALDOWN + "/download", data, {"Origin": MUSICALDOWN, "Referer": MUSICALDOWN + "/en"}))
    href = result.buttons.get("hd_download_click")
    is_hd = bool(href)
    href = href or result.buttons.get("mp4_download_click")
    if not href:
        raise RuntimeError("musicaldown gave no video link (deleted/private video, or the site changed)")

    # the button goes through musicaldown's proxy, the real file URL is inside its token
    direct = href
    token = search(r"[?&]token=([^&]+)", href)
    if token:
        try:
            direct = jwt_payload(token.group(1)).get("url") or href
        except ValueError:
            pass
    return direct, href, is_hd


def save(urls, target):
    '''
    stream the first URL that works into target, return its size in bytes
    '''
    error = None
    for url in dict.fromkeys(urls):
        try:
            with Browser().open(url, headers={"Referer": TIKTOK + "/"}, timeout=120) as response:
                if "html" in response.headers.get("Content-Type", ""):
                    raise RuntimeError("got a web page instead of a video")
                size, temp = 0, target + ".part"
                with open(temp, "wb") as file:
                    while True:
                        chunk = response.read(1024 * 256)
                        if not chunk:
                            break
                        file.write(chunk)
                        size += len(chunk)
                        if size // 10485760 != (size - len(chunk)) // 10485760:
                            print("    {} MB...".format(size // 1048576))
            if size < 10000:
                remove(temp)
                raise RuntimeError("file is too small ({} bytes)".format(size))
            replace(temp, target)
            return size
        except Exception as e:
            error = e
    raise RuntimeError("download failed: {}".format(error))


def download_video(username, video, folder, tries=3):
    '''
    get one video through musicaldown, retrying with growing pauses
    '''
    url = "{}/@{}/video/{}".format(TIKTOK, username, video["id"])
    date = datetime.fromtimestamp(video["time"], timezone.utc).strftime("%Y-%m-%d") if video["time"] else "unknown-date"
    for attempt in range(1, tries + 1):
        try:
            direct, proxied, is_hd = musicaldown_link(url)
            target = path.join(folder, "{}_{}{}.mp4".format(date, video["id"], "" if is_hd else "_noHD"))
            size = save([direct, proxied], target)
            return target, size, is_hd
        except Exception as e:
            print("    attempt {}/{} failed: {}".format(attempt, tries, e))
            if attempt < tries:
                sleep(10 * attempt)
    return None, 0, False


def main():
    parser = ArgumentParser(description="Download every video from a TikTok profile in max quality via MusicallyDown")
    parser.add_argument("username", nargs="?", help="TikTok username (with or without @, or a profile link)")
    parser.add_argument("--out", default=OUTPUTS, help="Folder to save into (default: a-Shell/TikTok Outputs)")
    args = parser.parse_args()

    # a-Shell isn't a real terminal, without this nothing shows up until the script ends
    try:
        stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    setdefaulttimeout(60)

    username = args.username or input("TikTok username: ")
    username = sub(r"^.*tiktok\.com/@", "", username.strip()).lstrip("@").split("/")[0].split("?")[0]
    if not username:
        raise SystemExit("No username given")

    folder = path.join(path.abspath(path.expanduser(args.out)), username)
    makedirs(folder, exist_ok=True)
    have_hd = set(findall(r"_(\d{15,})\.mp4", " ".join(listdir(folder))))

    print("Listing @{}'s videos...".format(username))
    try:
        videos = profile_videos(username)
    except Exception as e:
        raise SystemExit("Could not list videos: {}".format(e))
    photos = [v for v in videos if v["is_photo"]]
    videos = [v for v in videos if not v["is_photo"]]
    todo = [v for v in videos if v["id"] not in have_hd]
    print("{} videos ({} already saved, {} photo slideshows skipped), {} to download -> {}\n".format(
        len(videos), len(videos) - len(todo), len(photos), len(todo), folder))

    done, failed = 0, []
    try:
        for number, video in enumerate(todo, 1):
            print("[{}/{}] {}".format(number, len(todo), video["id"]))
            target, size, is_hd = download_video(username, video, folder)
            if target:
                done += 1
                # a real HD file replaces an older non-HD copy of the same video
                old = path.join(folder, path.basename(target).replace(".mp4", "_noHD.mp4"))
                if is_hd and path.exists(old):
                    remove(old)
                print("    saved {} ({:.1f} MB){}".format(path.basename(target), size / 1048576, "" if is_hd else "  [no HD available]"))
            else:
                failed.append(video["id"])
            if number < len(todo):
                sleep(uniform(2, 4))
    except KeyboardInterrupt:
        print("\nStopped. Run it again to continue where it left off.")

    failed_list = path.join(folder, "failed.txt")
    if failed:
        with open(failed_list, "w") as file:
            file.write("\n".join("{}/@{}/video/{}".format(TIKTOK, username, i) for i in failed) + "\n")
    elif path.exists(failed_list):
        remove(failed_list)
    print("\nDone: {} downloaded, {} failed{}".format(done, len(failed), " (listed in failed.txt, run again to retry)" if failed else ""))


if __name__ == "__main__":
    main()
