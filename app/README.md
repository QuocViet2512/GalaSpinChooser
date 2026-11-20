# Image-relative stage layout

In Settings → Căn chỉnh theo background, enable **Co giãn cùng ảnh nền** to try an image-relative stage. The reference canvas is 1920px wide, with height derived from the background's aspect ratio (1920 × 1080 without an image). Y percentages and reel width are relative to that canvas; pixel dimensions and text scale together with it. The image is contained, not cropped, so different screen ratios can introduce letterboxing. Preview, save per batch, and reset are supported; existing batches keep their previous layout unless this option is enabled. Waiting and draw backgrounds remain independent. Keep the background and its aspect ratio unchanged when transferring the app and data to another machine.

# Gala Spin — offline browser edition

Open `/media/Data/GitHub/GalaSpinChooser/index.html` in desktop Chrome/Edge, click **Chọn thư mục & bắt đầu**, select `app/` (or another dedicated writable directory), and grant read/write access. No Python, Node runtime, server, build, network, or dependency install is needed by operators. See `HUONG_DAN.md` for Vietnamese instructions.

## Implementation
- Classic local scripts, vanilla JS/CSS; no CDN/modules/fetch at runtime.
- `src/bootstrap.js`: IndexedDB handle memory, automatic restore when permission remains granted, user-gesture permission renewal or alternate directory picker, permission/write probe, same-origin Web Lock, cancellation/unsupported messages. No absolute-path guessing or silent permission requests.
- `src/storage.js`: File System Access persistence, compatible Python-era JSON/JSONL layout, crypto rejection-sampling RNG, swap/pop pool, bounded samples/pages, idempotent draw requests, fail-closed log recovery.
- `src/excel.js`: data-table XLSX ZIP/XML import/export (stored and deflate import), CSV parsing, CRC/size checks. No formulas/macros executed. Not a general-purpose Excel engine; first worksheet only.
- `src/app.js`: retained stage animation, confetti, keyboard shortcuts, per-batch settings, people/history UI.

The selected directory is the data root, not the repository root: select `app` to reuse existing data. Browser writes close before showing a winner. Unlike Python's explicit fsync, browser filesystem durability is managed by the browser/OS; no power-loss guarantee is claimed. Do not use multiple profiles, copies of the page, devices, or sync agents against the same data. Web Locks only protects cooperating same-origin tabs and is not a cross-device lock.

Reload recovery also uses browser localStorage for the pending request ID. Keep the same browser/profile and page location; clearing browser data can lose that pending pointer, though winner logs remain in the selected directory. Back up the full data root after closing the app.

## Verification (developers only)
From this directory, with Node 22+ and Chrome:

```sh
node --test tests/storage.test.mjs tests/confetti.test.mjs
node --check src/excel.js
node --check src/storage.js
node --check src/bootstrap.js
node --check src/app.js
node tests/browser_smoke.mjs
```

Storage tests use an in-memory filesystem. Browser smoke uses a disposable Chrome profile, a test-only loopback static server and actual OPFS handles substituted for the OS picker. OPFS isn't available under file:// in the tested Chrome, so this smoke does **not** certify the native folder picker or file:// disk permissions. Actual selection/read/write under file:// needs manual QA on the gala machine. No production data is touched. Override `CHROME_PATH` if required.

The legacy Python server, installation launchers and Python-only tests have been removed. Existing JSON/JSONL data, including old nested batch directories, remains supported by the browser edition. `requirement.txt` contains the original Vietnamese feature brief, not a Python dependency list.

### Create a batch and replace its roster

In Setup, use **+** beside the batch selector, enter a name and submit **Tạo đợt**. No personnel file is required; drawing remains disabled until a valid roster is imported. Select the batch, choose an XLSX/CSV file and submit **Nhập / thay danh sách** later.

Uploading again replaces the active roster and resets all winners, absences and pending draw recovery for that batch. Existing winners require an explicit confirmation; cancelling preserves the current data. The batch ID/name and stage settings remain unchanged. New files are written into a fresh directory, then the settings file is committed last. Old directories are not automatically deleted and are no longer used by this batch; failed imports leave the active configuration unchanged.

Stage settings support separate **Ảnh màn chờ** and **Ảnh nền quay số** uploads. Save settings after changing or removing either image. Waiting mode uses its own image, then the draw image, then the configured background color. Drawing mode uses only its own image or the background color, never the waiting image. Existing `background` settings remain the draw image; `waitingBackground` defaults to empty for older batches.

### Centered layout controls

The reel and draw button are always horizontally centered; previous X coordinates and separate name-font values are ignored. Y is the center as a percentage of viewport height. Reel width is a viewport percentage; reel height/radius and button width/height/radius use pixels. The button label is configurable (blank hides the visible label while preserving an accessible name). Name/code font size is always the displayed email font size minus 15px; email font has a 26px minimum for readability. Both elements have a thin outline for alignment. Preview, reset and per-batch persistence apply to all these fields. Extremely large dimensions are constrained to the viewport in manual mode.
