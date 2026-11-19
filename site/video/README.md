# AuthDeck promo video

A 31.6-second motion piece (1920x1080, 30 fps, H.264 + AAC) built as code, so it can be changed and re-rendered.

- `scene.html`, `scene.css`: every scene's layout, drawn the way the site and app draw (Graphite tokens, voxel corners, hard shadows, Pixelify Sans and IBM Plex Mono from `../src/fonts`, pixelarticons from `app/node_modules`).
- `scene.js`: the timeline. `promo.render(t)` sets the exact state for time t; nothing animates on its own. Scene times, taps and copy all live here.
- `render.mjs`: serves the scene, drives headless Chrome over CDP, captures every frame, synthesises a key click for each tap and encodes with ffmpeg.

## Render

Needs Node 22, Google Chrome and ffmpeg, and `npm install` in `app/` (for the icons).

```sh
node site/video/render.mjs                     # site/video/out/authdeck-promo.mp4 (about a minute)
node site/video/render.mjs --stills 6.05,14.5  # PNG frames into site/video/out/stills/
node site/video/render.mjs --serve             # preview in a browser: ?play, or ?t=6.05 for one frame
```

Set `CHROME` if Chrome is somewhere else. `site/build.mjs` copies only `site/src/`, so nothing here reaches the website build.

Contact sheet, one frame a second:

```sh
ffmpeg -i site/video/out/authdeck-promo.mp4 -vf "fps=1,scale=480:-1,tile=6x6" -frames:v 1 contact.png
```

## Scenes

| Time | Scene | What happens |
| --- | --- | --- |
| 0 to 5.0 s | Intro | The logo key powers on and presses once; "AuthDeck" and the site's headline. |
| 5.0 to 12.4 s | Keys | "Tap a key on your phone." Command palette opens the palette on the computer; Run tests runs `npm test` and the key turns green. "Your computer does it." |
| 12.4 to 18.2 s | 2FA | A sign-in box waits for a 6-digit code; tapping GitHub in Codes types it in, then "Signed in". |
| 18.2 to 25.6 s | Env sets | `authdeck env run -- npm run dev` asks the phone; "Allow for 15 minutes" releases the secrets and the dev server starts. Terminal lines match the site's env section. |
| 25.6 to 31.6 s | End | "Free. No account. Just your Wi-Fi.", the systems, then the logo, "AuthDeck" and authdeck.in. |

Cuts use a stepped pixel wipe. Clicks play at each tap in `SCENES[].presses`.
