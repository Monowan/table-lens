# 📋 Table Lens

**Turns photos of tables into ready-to-use data — CSV for Excel, Sheets, or any system.**

Load a snapshot of a paper table, a screenshot, or a scan — and in four steps get structured data. Grid detection, text recognition via Google Gemini, format validation with masks, and export. Everything runs right in the browser.

**[▶ Open the app](https://monowan.github.io/table-lens/)** · no sign-up, no installation

---

## Contents

- [Features](#features)
  - [Image preparation](#1-image-preparation)
  - [Cell detection and editing](#2-cell-detection-and-editing)
  - [Text recognition](#3-text-recognition)
  - [Validation masks](#4-validation-masks)
  - [Result correction](#5-result-correction)
  - [Export](#6-export)
  - [Batch mode](#7-batch-mode)
  - [Interface](#8-interface)
- [Tech stack](#tech-stack)
- [Running locally](#running-locally)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [Author](#author)
- [License](#license)

---

## Features

### 1. Image preparation

| Feature | Description |
|---|---|
| **File upload** | Pick files with a button or drop images anywhere on the page |
| **Multiple files at once** | Each image becomes a separate frame |
| **Frame naming** | Taken from the file name (without extension), not "Frame 1", "Frame 2" |
| **Demo image** | One button generates a 5×4 test table |
| **90° rotation** | Left and right, no quality loss |
| **Free angle** | Slider from −45° to 45° with live recomputation and current value readout |
| **Crop box** | 8 handles (corners + edge midpoints), the box never leaves the image bounds |
| **Perspective correction** | Mark four document corners → trapezoid is straightened into a rectangle |
| **Revert to original** | Reset all frame transformations with one click |

### 2. Cell detection and editing

| Feature | Description |
|---|---|
| **Automatic detection** | Finds closed contours, assigns rows and columns |
| **Detection tuning** | Min/max cell area, morphology kernel size, adaptive threshold block size |
| **Live sliders** | Changing a parameter re-runs detection immediately |
| **A1, B3 numbering** | Every cell is labelled the Excel way |
| **Cell selection** | Click a cell → highlighted with a red outline and corner handles |
| **Geometry editing** | Drag corners (free quadrilateral) or the whole cell |
| **Automatic renumbering** | Rows and columns are recalculated after a cell moves |
| **Manual drawing** | "Draw" button → drag a rectangle to add a missed cell |
| **Deletion** | Button or `Delete` / `Backspace` key |
| **Lighting correction** | Brightness normalization with an adjustable level — for photos with shadows |

### 3. Text recognition

| Feature | Description |
|---|---|
| **Google Gemini** | Recognition via the Google AI Studio API, handles Ukrainian and English |
| **Row batching** | Cells of one row are stitched into a single image — fewer requests, higher speed |
| **ID binding** | Each cell's number is drawn above it, the model returns `id:::text` — swapping values is physically impossible |
| **Rate limiter** | Max 9 requests per minute to stay within the free tier |
| **Retries** | On `429` / `503` — automatic backoff (1 → 2 → 4 → 8 s), plus honoring `Retry-After` |
| **Real-time progress** | Row number, cell count, model name, request size in KB |
| **Recognize all frames** | Sequential batch processing with one click |

### 4. Validation masks

A mask is a set of format rules for individual cells. It lets you catch OCR errors automatically.

| Feature | Description |
|---|---|
| **Visual editor** | Table rendered over the canvas — select a cell by click or drag a range |
| **Character-class checkboxes** | Digits / Letters / Signs / Anything → automatic regex construction |
| **Manual regex** | For complex formats: `\d{2}\.\d{2}\.\d{4}` for dates |
| **Full-match validation** | The expression checks the value from start to end — `\d{2}` won't accept `1234` |
| **Character replacements** | Automatic fixing of typical OCR mistakes: `O→0`, `l→1`, `,→.`, `№→N` |
| **Violation highlighting** | Cells that don't match the mask are outlined in orange |
| **JSON import / export** | Save masks to a file and move them between devices |
| **Browser storage** | Masks persist in `localStorage`, no server involved |

### 5. Result correction

| Feature | Description |
|---|---|
| **Metrics** | Total cells, correctly recognized, problematic |
| **Problem list** | Card with an image fragment, coordinates, and an input field |
| **Problem type** | "empty" or "does not match mask" — visually distinguished |
| **Inline fixing** | Typing updates the overlay text live, `Enter` confirms |
| **Cell editor** | Click a cell on the image → modal with a magnified fragment |
| **Re-recognize cell** | Targeted repeat request to Gemini for a single cell |
| **Three view modes** | Original / Processed / Recognized text |

### 6. Export

| Format | Description |
|---|---|
| **CSV** | UTF-8 with BOM — Excel and Numbers open Cyrillic without tricks. File name = frame name |
| **PNG** | Image with the recognized text overlaid (red font with a white outline) |
| **Mask JSON** | Export the validation schema as a separate file |

### 7. Batch mode

| Feature | Description |
|---|---|
| **Frame gallery** | Thumbnails of every loaded image below the canvas |
| **Frame switching** | Click a thumbnail — each frame keeps its own state independently |
| **Isolated pipeline** | Its own cells, results, mask, and transformations per frame |
| **"Recognize all"** | Batch processing of every frame with progress |

### 8. Interface

| Feature | Description |
|---|---|
| **Two languages** | English and Ukrainian, switchable right in the settings menu |
| **Language persistence** | The choice is remembered across sessions |
| **Full localization** | Over 200 strings — including dynamic statuses, toasts, and tooltips |
| **Step tabs** | 1 → Prepare → 2 → Cells → 3 → Recognize → 4 → Export |
| **Parameter tooltips** | A `?` icon next to every slider, auto-positioned near screen edges |
| **Toasts** | Non-intrusive notifications for every action |
| **Responsive** | Works on laptops and tablets |

---

## Tech stack

| Component | What is used |
|---|---|
| Language | Vanilla JavaScript (ES6+), no frameworks, no build step |
| Computer vision | [OpenCV.js 4.9](https://docs.opencv.org/4.9.0/opencv.js) — contours, morphology, perspective transform |
| Recognition | Google Gemini API (`generativelanguage.googleapis.com`) |
| Styling | Plain CSS with custom properties, no preprocessors |
| Localization | Custom module built on `data-i18n` attributes |
| Storage | `localStorage` for masks and preferences |

**No backend.** No server, database, or build step — everything executes in the browser. The app deploys as a static site.

---

## Running locally

Only Python (or any static server) is required:

```bash
git clone https://github.com/Monowan/table-lens.git
cd table-lens
python3 -m http.server 8090
```

Open [http://localhost:8090](http://localhost:8090).

> `file://` works too, but `http://` is more reliable — some browsers restrict APIs for local files.

### API key for recognition

1. Open [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **Create API key**
3. Paste the key into the field on step 3

The free tier provides more than enough requests for personal use. The key is stored only in your browser.

---

## Project structure

```
table-lens/
├── index.html                # page markup, 4 step tabs, modals
├── css/
│   └── style.css             # styling, custom properties, responsiveness
└── js/
    ├── app.js                # app state, steps, OCR, export, settings menu
    ├── image-processing.js   # rotation, lighting correction, grid detection
    ├── perspective.js        # four-point perspective correction
    ├── crop.js               # interactive crop box
    ├── cell-editor.js        # cell selection, moving, drawing
    ├── mask.js               # mask editor, validation, replacements
    └── i18n.js               # English and Ukrainian dictionaries
```

---

## Deployment

The app is deployed on GitHub Pages: **[monowan.github.io/table-lens](https://monowan.github.io/table-lens/)**

Updates are published automatically on every push to `main`. See the [GitHub Pages docs](https://docs.github.com/pages) for details.

To deploy your own copy:

1. Fork the repository
2. **Settings → Pages → Source: Deploy from a branch**
3. Select the `main` branch, the `/ (root)` folder, click **Save**

---

## Author

**Monowan** — [github.com/Monowan](https://github.com/Monowan)

---

## License

[MIT](LICENSE) — use it, change it, share it.
