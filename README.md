# TikTok HD Downloader

Downloads TikTok videos in max quality through MusicallyDown's HD link (a large
`*_original.mp4`, not TikTok's compressed stream).

## tiktok_profile_hd.py: whole profile, made for a-Shell on iPad

Lists every video on a profile and downloads each one, one by one, into
`On My iPad › a-Shell › TikTok Outputs › <username>`. It only uses the Python standard
library, so nothing needs to be installed. Running it again skips videos already saved,
so it continues where it stopped and retries failed ones. Photo posts are saved too,
as full size JPEGs (one file per slide).

Install (in a-Shell, one line at a time; a-Shell skips commands chained with `&&`):

```
cd ~/Documents
python3 -c "import urllib.request as u; open('tiktok_profile_hd.py','wb').write(u.urlopen('https://raw.githubusercontent.com/starchip942/tiktok-hd-downloader/main/tiktok_profile_hd.py', timeout=30).read()); print('saved')"
```

Run:

```
cd ~/Documents
python3 -u tiktok_profile_hd.py
```

## tiktok_hd.py: single links, desktop

```
pip install requests beautifulsoup4 lxml
python tiktok_hd.py https://vt.tiktok.com/XXXX/
```

Falls back to tikwm.com if MusicallyDown fails (lower quality).

## Notes

- Both MusicallyDown and TikTok's listing API are undocumented and can change at any time.
- Downloading this way is against TikTok's Terms of Service; respect creators' rights.
