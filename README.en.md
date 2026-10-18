# vesky

*[Version française](README.md)*

Hide the faces in a video or photo before posting it, right in the phone's browser.
Nothing is sent to a server: no account, no analytics, no third-party file loaded from another site.

Live at [vesky.fr](https://vesky.fr) (French interface). Also available as an Android app.

## Why

Videos of protests and blockades are used to identify the people filmed. A blur or a mosaic
can be undone by AI. A solid box cannot: there is no image left underneath.

## What it does

1. You pick a video or a photo.
2. The video is analysed 30 times per second, and a black box (or an emoji on a black box) is placed on every face, on every frame.
3. You check: add a mask where a face was missed, remove one placed by mistake.
4. The file is fully re-encoded: the location, date and phone model stored in the original file are gone.

## What it does not do

- It does not hide clothes, tattoos, voices or places.
- It can miss a face. Checking by eye before posting is still required.
- It does not promise complete protection.

## How to verify it

You don't have to take our word for it. Each point below can be checked without special tools.

- **Android app: no permissions, not even internet.** In the phone settings, Apps → vesky → Permissions:
  the list is empty. Without the internet permission, Android itself prevents the app from sending anything.
  The file that declares it: `android/app/src/main/AndroidManifest.xml`.
- **Website: airplane mode.** Open vesky.fr once with a connection, switch to airplane mode, then process a video:
  everything works. With no network, nothing can leave.
- **Website: the browser's Network tab.** On a computer, open the developer tools (F12), Network tab, then process a video.
  Once the page has loaded, no request appears during analysis or export.
- **Website: the security policy.** Every file is served with a `Content-Security-Policy` header (`_headers`),
  visible in the Network tab. `connect-src 'self'` forbids the browser from connecting to any other site.
  vesky.fr itself only serves static files: there is no server-side code that could receive a video.
- **The automated test** (see "Testing") fails if a single request goes out after the page has loaded.
- **The code is public.** Network calls can be found in seconds: `grep -rn "fetch(" app.js sw.js`.
- **The website serves this code.** `bash outils/verifier-site.sh` downloads every file from vesky.fr and compares it,
  byte for byte, with the latest commit of the repository (see "Testing").

## How it works

- Static site, no build step for the code: `index.html`, `style.css`, `app.js`.
- Face detection: the YuNet_n model, retrained to see better at night (`models/README.md`), run by ONNX Runtime Web (`detector.js`, `detect-worker.js`),
  on several cores in parallel. Very dark frames are analysed twice, as is and brightened, and the results are merged.
- Tracking: one box per face from frame to frame, enlarged by 30%, extended a few frames before and after.
- Fast export: the original file is decoded frame by frame, each frame is masked then re-encoded
  by the phone's encoder (WebCodecs, through Mediabunny). Faster than real time.
- Fallback export, when the browser cannot do the fast one: the masked image is recorded while it plays
  (canvas + MediaRecorder). Add `?lent` to the URL to force this mode.
- Photos: JPEG.
- Installable on the home screen (`manifest.webmanifest`) and usable offline: `sw.js` keeps a copy
  of the site's files on the phone. With a connection, the online version is always served.
- Everything is served by the site itself, and a security policy (`_headers`) forbids the browser
  from connecting to any other site.

## Layout

- At the root: the website itself (`index.html`, `app.js`, `style.css`…), with `models/` (the detection model),
  `vendor/` (libraries and fonts) and `icons/`.
- `outils/`: build the published site, serve it locally, check that vesky.fr serves this repository.
- `test/`: the website tests.
- `entrainement/`: measuring and training the detection model.
- `android/` and `fastlane/`: the Android app and its store listing texts.

## Deploying

Hosted on Cloudflare (Workers, static assets only, settings in `wrangler.jsonc`).

```bash
node outils/build.mjs
npx wrangler deploy
```

## Android app

Folder `android/`: the whole site packaged in an app, displayed by a WebView (`MainActivity.java`).
The app has no permissions, not even internet. It does what the browser did on its own: pick a file,
save the result to the gallery (Movies/vesky, Pictures/vesky), share it, keep the screen on, and open
a video shared from the gallery. The site files are copied into the app at each build,
from the same list as `outils/build.mjs`. Store listing texts: `fastlane/metadata/android/`.

Build (JDK 17 or later, Android SDK 36):

```bash
cd android && ./gradlew assembleRelease
```

The APK lands in `android/app/build/outputs/apk/release/`. It is signed only if the key description file
exists (`~/.vesky-signature/keystore.properties`, or the path given by `VESKY_KEYSTORE`).
The debug build (`assembleDebug`) bundles two videos from `test/` and opens the page with `?debug`,
so the app can be driven from a computer (`adb forward`, then the same protocol as `test/run-test.mjs`).

Distribution: APK on GitHub releases, picked up by IzzyOnDroid. Not on the main F-Droid repository
for now: it rejects prebuilt `.wasm` files, such as ONNX Runtime's.

## Running locally

```bash
node outils/dev-server.mjs
```

Then open http://localhost:5173.

## Testing

```bash
python test/make-test-video.py
node test/run-test.mjs
```

The test opens headless Chrome, analyses a video whose face positions are known, exports it,
then checks in the output file, frame by frame and on 25 points of each face, that no face
is visible, that the metadata is gone and that no request went out after the page loaded.
It fails (exit code 1) on the slightest defect.

### No trace of the face in the file

```bash
python test/make-faces-pair.py
node test/test-sans-trace.mjs
```

Two videos identical to the pixel, except inside the faces. The second one gets exactly the same
masks as the first, then both are exported: the output files must be byte-for-byte identical.
The result therefore does not depend on the original face, and no watermark could be used to
recover it. The black box is painted on the frame before it reaches the encoder, which never sees the face.

### No date in the file, even a long one

```bash
node test/test-metadonnees.mjs
```

No browser needed. Writes MP4 files the way the fast export does, including a 20-minute video at 60 frames
per second (its headers exceed 1 MB) and named tracks, then checks that after cleaning no creation date,
track name or track language is left, and that the file reads back the same.

### Third-party files

```bash
bash test/verifier-tiers.sh
```

Downloads ONNX Runtime and Mediabunny from npm and checks that the files in the repository are
byte-for-byte identical to the originals. One edit, redone by the script: the `sourceMappingURL` line of
`ort.wasm.min.mjs` is emptied. The model was retrained for vesky: its recipe is in `entrainement/entrainer-nuit.sh`.

### The live website

```bash
bash outils/verifier-site.sh
```

Downloads every file served by vesky.fr (the same list as `outils/build.mjs`) and compares it, byte for byte,
with its version in the latest commit. Also checks that the `Content-Security-Policy` header received is the one in `_headers`.
Other address: `SITE=https://… bash outils/verifier-site.sh`.

### Detection accuracy

`entrainement/eval-faces.py` measures missed faces and false masks on two annotated datasets:
WIDER FACE (validation set, daytime) and DARK FACE (night). `entrainement/eval-centerface.py` compares
the same rule with CenterFace, the model used by [deface](https://github.com/ORB-HD/deface).

## Known limitations

- With the fallback export, exporting takes as long as the video.
- Analysis is slow on long videos.
- Automated test on desktop Chrome. Tested by hand on Android and iPhone.

## Third-party components

- [YuNet_n](https://github.com/ShiqiYu/libfacedetection.train), BSD-3 licence, retrained on WIDER FACE and DARK FACE (`models/`).
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), MIT licence (`vendor/ort/`).
- [Mediabunny](https://github.com/Vanilagy/mediabunny), MPL-2.0 licence (`vendor/mediabunny/`).
- Archivo and JetBrains Mono fonts, SIL OFL 1.1 licence (`vendor/fonts/`).

## Contributing

Before opening a PR, read [CONTRIBUTING.md](CONTRIBUTING.md) (in French; you can write in English).

## Licence

Code under the [AGPL-3.0](LICENSE). You may copy, modify and host it,
as long as you publish the code of your version under the same licence, even if it is only served as a website.

### Hosting your own copy

The official version is https://vesky.fr. If you put your own copy online:

1. **Say it is an unofficial copy,** on the home page, with a link to this repository.
2. **Put a visible link to the code of your version** on the site itself. If you changed a single file,
   even the stylesheet or a text page, it is your code you must publish, not a link to this repository (AGPL, section 13).
3. **State in each modified file** that you modified it, and when (AGPL, section 5, a).
4. **Keep the licence** (`LICENSE`) and the third-party notices.
5. **Protect yourself in the legal notice.** French law lets an individual stay anonymous
   by giving their details only to the host. Do not publish your home address there.

**Do not load anything from another site.** People use this tool to protect faces, sometimes at protests.
A Google Fonts stylesheet, an analytics script or an image hosted elsewhere is enough to send their IP address
to a third party as soon as they open the page. Keep everything on your own server, as in `vendor/`,
and do not loosen the security policy in `_headers`. If you change `app.js`, `sw.js` or `_headers`, say so clearly.
