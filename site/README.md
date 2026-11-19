# The AuthDeck website

Static pages in `src/` (the home page and the privacy policy), drawn like the app: the Graphite, Paper and Tide colourways, voxel keys
with hard shadows, Pixelify Sans for titles and IBM Plex Mono for text. The hero shows a demo
video; the deck in the keys section is a demo you can tap. Nothing on the page talks to a
computer or makes real codes.

## Build and preview

The build needs the release files in `dist/` (see "Building from source" in the main README) and
`npm install` done in `app/` (the pixel icons come from there).

```sh
node site/build.mjs                                       # writes site/out, downloads included
(cd site/out && python3 -m http.server 8765 --bind 127.0.0.1)   # then open http://127.0.0.1:8765
```

`build.mjs` fills the version, the download table (sizes and SHA-256) and the icon sprite into
`src/index.html`, copies everything else in `src/` as it is, and puts the release files and a
`SHA256SUMS` file in `out/downloads/`. The mark sprite and the footer every page shares live in
`src/partials/` and are filled into each page, not published on their own.

## Privacy policy

`app/store/privacy.md` is the only source of the privacy policy. The build renders it into
`src/privacy/index.html`, published at <https://authdeck.in/privacy/>, which is the URL to give
Google Play and the App Store. Edit the Markdown, never the built page. `markdown.mjs` converts it
and knows only what the policy uses: `#` and `##` headings, paragraphs, `- ` lists, inline code
and `https://` or `mailto:` links. Anything else stops the build with the line it can't handle.
Its tests: `node --test site/markdown.test.mjs`.

## The demo video

The hero plays `src/media/authdeck-promo.mp4` (muted, on a loop) over the poster
`src/media/authdeck-promo-poster.webp`. The page refers to those two names only, so replacing the
video needs no code change:

1. Re-render it with `node site/video/render.mjs` (see `site/video/README.md`) and copy
   `site/video/out/authdeck-promo.mp4` over `site/src/media/authdeck-promo.mp4`. It must be H.264
   and AAC in an MP4 with its index at the front, so it starts before it has fully downloaded. If
   a file doesn't have that, copy it with
   `ffmpeg -i in.mp4 -c copy -movflags +faststart site/src/media/authdeck-promo.mp4`.
2. If the picture changed, make a new poster from a frame where the phone and the computer are
   both mid-action, and keep it under about 150 KB:
   `ffmpeg -ss 10 -i site/src/media/authdeck-promo.mp4 -frames:v 1 /tmp/poster.png && cwebp -q 82 -m 6 /tmp/poster.png -o site/src/media/authdeck-promo-poster.webp`
3. If what the video shows changed, update its description in the `aria-label` on `<video>` in
   `src/index.html`.
4. Deploy with `site/deploy.sh`. `/media/*` is cached for 7 days, by browsers and by Cloudflare,
   so to show the new video at once, purge `https://authdeck.in/media/` in Cloudflare's cache.
   Returning visitors' browsers can still keep the old one for up to a week.

The preview command above uses Python's server, which ignores Range requests; the video still
plays there, but seeking and looping are only reliable on the real host.

The colour switch is in `src/colorway.js`, which every page loads; `src/site.js` is the home
page's demo and only the home page loads it.

The mark in the header and footer is the app icon (`app/assets/icon.png`) drawn as an inline SVG,
one unit per icon voxel. The favicons are a 16-unit version without the drop shadow:
`src/img/favicon.svg`, and `src/favicon.ico` holding 16, 32 and 48 px PNGs rendered from it at
exact sizes. `src/img/icon-192.png` and `icon-512.png` (in `src/site.webmanifest`) and
`icon-180.png` (Apple touch icon) are the full icon.

## Publish

The site is served from a laptop through the Cloudflare Tunnel `authdeck-site`:
<https://authdeck.in/>. The tunnel dials out to Cloudflare, so the laptop needs no open ports, and
Cloudflare provides the HTTPS certificate. `www.authdeck.in` redirects to the bare domain.

```sh
site/deploy.sh      # build, then copy out/ to ~/authdeck-site/www on the host over SSH
```

The host is the SSH alias `authdeck-site` (set `AUTHDECK_SITE_HOST` for another one). The copy
replaces everything on the host, so only the current release's downloads stay published.

The first time on a new host, put the tunnel's token in `~/.config/authdeck-site/tunnel.env` as
`TUNNEL_TOKEN=<token>`, then run `~/authdeck-site/host/start.sh` there as the normal user. It
installs two systemd user services and needs no root:

- `authdeck-site-web.service`: Caddy (`~/.local/bin/caddy`) serving `~/authdeck-site/www` on
  127.0.0.1:8735 only, with the security headers in `host/Caddyfile`. The HTML pages are sent with
  `Cache-Control: no-cache, no-transform`, so Cloudflare leaves them as they are instead of
  injecting its analytics script (which the CSP would block). `/favicon.ico` and
  `/site.webmanifest` are cached for a day. It has no admin API and saves
  no config, so it can't clash with another Caddy on the machine.
- `authdeck-site-tunnel.service`: `cloudflared` (`~/.local/bin/cloudflared`) running the tunnel. It
  reads the token from `tunnel.env`, which `start.sh` keeps readable by the owner only.

Run `start.sh` again after changing the Caddyfile; it restarts both services.

On Cloudflare's side, the domain uses Cloudflare's nameservers, `authdeck.in` and `www.authdeck.in`
are proxied CNAME records to the tunnel, and the tunnel's public hostnames send both to
`http://127.0.0.1:8735`. The token is on the tunnel's page in the Cloudflare dashboard.
