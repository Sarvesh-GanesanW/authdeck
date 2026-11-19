# AuthDeck promo video

A 31.6-second motion piece (1920x1080, 30 fps, H.264 + AAC; 32 to 34 s in the music versions) built as code, so it can be changed and re-rendered.

- `scene.html`, `scene.css`: every scene's layout, drawn the way the site and app draw (Graphite tokens, voxel corners, hard shadows, Pixelify Sans and IBM Plex Mono from `../src/fonts`, pixelarticons from `app/node_modules`).
- `scene.js`: the timeline. `promo.render(t)` sets the exact state for time t; nothing animates on its own. Scene times, taps and copy all live here.
- `render.mjs`: serves the scene, drives headless Chrome over CDP, captures every frame and encodes with ffmpeg. With `--music` it cuts the video to that track's beat.
- `beat-sync.mjs`: fits the story timeline onto a beat grid. Cuts, taps and the three success moments move onto beats (cuts onto bar lines when that costs under 0.3 s), the end-card logo press lands on a bar line, story time stretches linearly between them (0.7x to 1.4x), and every caption keeps at least 0.3 s a word plus 1 s on screen.
- `sound.mjs`: the effects, synthesised from code: key clicks for taps, soft ticks for typing and the 2FA digits, a pixel swish on each wipe, a two-note blip when tests pass, on "Signed in" and on the green "allowed" line.
- `soundtrack.mjs`: cuts the music bed, mixes the effects over it (the taps duck the music), normalises to -14 LUFS in two passes and encodes AAC 192k, stepping the limiter down until the encoded file's true peak is at or below -1 dBTP.
- `compose.mjs`: "Keys Up", an original chiptune (D major, 132 BPM) written in code for this video; we own it outright.

## Render

Needs Node 22, Google Chrome and ffmpeg, and `npm install` in `app/` (for the icons).

```sh
node site/video/render.mjs                     # effects only: site/video/out/authdeck-promo.mp4 (about a minute)
node site/video/render.mjs --stills 6.05,14.5  # PNG frames into site/video/out/stills/
node site/video/render.mjs --serve             # preview in a browser: ?play, or ?t=6.05 for one frame
```

Set `CHROME` if Chrome is somewhere else. `site/build.mjs` copies only `site/src/`, so nothing here reaches the website build.

### With music

Three versions, each into `site/video/out/authdeck-promo-<name>.mp4`:

```sh
# Chiptune: "It Takes A Hero" by Zane Little Music (CC0)
node site/video/render.mjs --music site/video/music/it_takes_a_hero.wav --bpm 140 --offset 0 --ending 56.566 --key B --out chiptune

# Electronic: "Slampe - Synthwave House" by Fupi (CC0)
node site/video/render.mjs --music site/video/music/slampe.wav --bpm 114 --offset 10.600 --ending 152.712 --key C --out electronic

# Original chiptune, composed in code
node site/video/compose.mjs
node site/video/render.mjs --music site/video/out/authdeck-original-chiptune.wav --bpm 132 --offset 0 --key D --fade 0 --out original
```

- `--bpm`: the track's tempo; cuts and taps follow its beat grid.
- `--offset`: the track time (seconds) of the bar line that plays at 0 s.
- `--ending`: the track time of a hit to jump to so it lands on the end-card logo press (leave it out to play straight through).
- `--key`: the key the success blips are pitched in.
- `--fade`: the closing fade in seconds (default 1; 0 when the music ends by itself).
- `--stills` takes output times, so add the same music options to see frames as the music version shows them.

The renderer prints where each cut and tap landed (beat and bar) and the soundtrack's loudness and true peak.

### Music files and licences

Downloaded tracks live in `site/video/music/`, which is git-ignored: some free licences (Pixabay's, for one) forbid redistributing the audio, so music files are never committed. `site/video/music/LICENSES.md` records each track's source page, artist, licence and attribution line, with saved copies of the source pages. The original chiptune's code (`compose.mjs`) is committed; its WAV is rendered into `site/video/out/`. No attribution text goes in the video itself.

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

Times are story times; a music version shifts them by up to about half a beat. Cuts use a stepped pixel wipe. Clicks play at each tap in `SCENES[].presses`.
