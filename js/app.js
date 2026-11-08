/**
 * Головна логіка застосунку: стан, кроки, OCR, експорт.
 */

// ---------- Глобальний стан (пакетний режим) ----------
// Кожен кадр — окремий повний конвеєр обробки. Активний кадр вибирається
// кліком по мініатюрі в галереї. Поля нижче (original/working/...) проксіюються
// на активний кадр через accessor'и, тому весь наявний код, що працює з
// `state.working`, `state.cells` тощо, лишається коректним.
const state = {
  frames: [],        // масив кадрів (див. createFrame)
  activeIndex: -1,   // індекс активного кадру
  step: 1,           // поточний етап (1..4)
  view: "processed", // original | processed | overlay
};

// Поля кадру, які проксіюються на активний кадр.
const FRAME_FIELDS = [
  "original", "working", "base", "angle",
  "preprocessed", "cells", "gridNodes", "results", "overlay", "overlayTexts",
];

// Безпечні значення «за замовчуванням» для полів кадру, коли кадру ще немає.
// Масиви → порожній масив (щоб `.length` не падало), решта → null.
const FRAME_DEFAULTS = {
  cells: [],
  results: [],
  overlayTexts: [],
};

function activeFrame() {
  return state.frames[state.activeIndex] || null;
}

for (const f of FRAME_FIELDS) {
  Object.defineProperty(state, f, {
    get() {
      const fr = activeFrame();
      if (fr) return fr[f];
      return (f in FRAME_DEFAULTS) ? FRAME_DEFAULTS[f] : null;
    },
    set(v) { const fr = activeFrame(); if (fr) fr[f] = v; },
    configurable: true,
  });
}

// Створює новий порожній кадр з усіма полями конвеєра.
function createFrame(id) {
  return {
    id,                     // унікальний id кадру
    name: "",               // підпис («Кадр N» або ім'я файлу)
    original: null,         // оригінальний cv.Mat (RGBA)
    working: null,          // поточне робоче cv.Mat
    base: null,             // база для повороту
    angle: 0,               // поточний кут (градуси)
    preprocessed: null,     // після попередньої обробки
    cells: [],              // [{ row, col, x, y, w, h }]
    gridNodes: null,        // адаптивні вузли сітки nodes[r][c] = {x,y}
    results: [],            // [{ row, col, text, confidence }]
    overlay: null,          // накладене зображення (cv.Mat)
    overlayTexts: [],       // [{ x, y, text }] для малювання тексту поверх overlay
    thumbDataUrl: null,     // кеш мініатюри (для галереї)
  };
}

let __frameIdCounter = 0;
function nextFrameId() { return ++__frameIdCounter; }

const canvas = document.getElementById("mainCanvas");
const ctx = canvas.getContext("2d");
const cropBox = new CropBox(canvas);
cropBox.onChange = () => { render(); };
// Інструмент «Обрізка» вимкнений за замовчуванням — вмикається кнопкою ✂️
// біля кнопок повороту. Вимкнена рамка не обробляє мишу і не малюється.
let cropToolOn = false;

// Вмикає/вимикає інструмент «Обрізка» (рамка + довільний кут).
// Увімкнення можливе лише на кроці 1 і коли є зображення.
function setCropTool(on) {
  cropToolOn = !!on && state.step === 1 && !!activeFrame();
  const btn = document.getElementById("cropToolBtn");
  const panel = document.getElementById("cropToolPanel");
  if (btn) {
    btn.classList.toggle("active", cropToolOn);
    btn.setAttribute("aria-pressed", cropToolOn ? "true" : "false");
  }
  if (panel) panel.style.display = cropToolOn ? "flex" : "none";
  if (cropToolOn) {
    cropBox.enable();
    cropBox.resetToFull();
  } else {
    cropBox.disable();
  }
  render();
}

const perspPicker = new PerspectivePicker(canvas);
let manualPerspPoints = null; // 4 точки [TL,TR,BR,BL] після кліків

const cellEditor = new CellEditor(canvas);
cellEditor.onChange = () => {
  render();
  updateCellEditorUI();
};
cellEditor.onStructureChange = () => {
  // CellEditor вже перерахував row/col на місці (у тому ж масиві state.cells).
  // Лише перемальовуємо та оновлюємо лічильник.
  render();
};

let opencvReady = false;

// Безпечне видалення cv.Mat: ігнорує вже видалені матриці.
function safeDelete(mat) {
  if (mat && !mat.isDeleted()) mat.delete();
}

// ---------- Toast ----------
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- OpenCV ready ----------
function waitForOpenCV() {
  return new Promise((resolve) => {
    if (window.cv && cv.Mat) return resolve();
    const check = () => {
      if (window.cv && cv.Mat) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}

// ---------- Завантаження зображення ----------
function loadImageToCanvas(fileOrUrl) {
  return new Promise(async (resolve, reject) => {
    await waitForOpenCV();
    const img = new Image();
    img.onload = () => {
      const mat = cv.imread(img);
      if (!mat || mat.empty()) { reject(new Error("empty")); return; }
      // imread вже повертає RGBA (4 канали); додаткова конвертація не потрібна.
      resolve(mat);
    };
    img.onerror = reject;
    if (typeof fileOrUrl === "string") {
      img.src = fileOrUrl;
    } else {
      const url = URL.createObjectURL(fileOrUrl);
      const done = () => URL.revokeObjectURL(url);
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
      img.src = url;
    }
  });
}

// Заглушка має бути не ширшою за чорне полотно під нею.
// Враховує CSS-масштаб canvas (він може бути зменшений через max-width/height).
function syncPlaceholderSize() {
  const ph = document.getElementById("placeholder");
  if (!ph) return;
  const r = canvas.getBoundingClientRect();
  // На початку canvas ще не має розмірів (0) — не перезаписуємо змінні,
  // щоб заглушка не розтягувалась на всю область.
  // Заглушка трохи вужча за чорне полотно (з відступом 8px з кожного боку).
  if (r.width > 40 && r.height > 40) {
    ph.style.setProperty("--ph-w", Math.max(180, Math.round(r.width * 0.88)) + "px");
    ph.style.setProperty("--ph-h", Math.max(100, Math.round(r.height * 0.6)) + "px");
  }
}

// ---------- Рендер полотна ----------
function render(resetCropBox) {
  const src = currentViewMat();
  if (!src) return;
  canvas.width = src.cols;
  canvas.height = src.rows;
  cv.imshow(canvas, src);
  syncPlaceholderSize();
  const isOriginal = state.view === "original";
  // Якщо активний режим overlay — малюємо розпізнаний текст поверх зображення
  // через ctx.fillText (підтримує кирилицю, на відміну від cv.putText).
  if (state.view === "overlay" && state.overlayTexts.length) {
    const ctxText = ctx;
    ctxText.save();
    ctxText.fillStyle = "#d22";
    ctxText.strokeStyle = "#fff";
    ctxText.lineWidth = 3;
    ctxText.font = "bold 16px sans-serif";
    ctxText.textBaseline = "alphabetic";
    for (const t of state.overlayTexts) {
      ctxText.strokeText(t.text, t.x, t.y);
      ctxText.fillText(t.text, t.x, t.y);
    }
    ctxText.restore();
  }
  // Скидаємо рамку на весь canvas (після встановлення правильних розмірів).
  if (resetCropBox) {
    cropBox.resetToFull();
  }
  // «Оригінал» — чисте зображення: жодних рамок, сітки, виділень та оверлеїв.
  if (isOriginal) {
    document.getElementById("placeholder").style.display = "none";
    return;
  }
  cropBox.drawOverlay();
  perspPicker.draw();
  drawCellsGrid();
  drawMaskInvalidHighlights();
  cellEditor.cells = state.cells;
  cellEditor.draw();
  document.getElementById("placeholder").style.display = "none";
}

// Малює знайдені комірки як напівпрозорі залиті прямокутники/чотирикутники
// (замість тонких ліній-рамок), щоб добре бачити зони розпізнавання.
function drawCellsGrid() {
  if (!state.cells.length) return;
  const ctx2 = ctx;
  ctx2.fillStyle = "rgba(0, 200, 83, 0.28)"; // зелений, напівпрозорий
  for (const c of state.cells) {
    if (c.quad && c.quad.length === 4) {
      ctx2.beginPath();
      ctx2.moveTo(c.quad[0].x, c.quad[0].y);
      ctx2.lineTo(c.quad[1].x, c.quad[1].y);
      ctx2.lineTo(c.quad[2].x, c.quad[2].y);
      ctx2.lineTo(c.quad[3].x, c.quad[3].y);
      ctx2.closePath();
      ctx2.fill();
    } else {
      ctx2.fillRect(c.x, c.y, c.w, c.h);
    }
  }

  // Нумерація комірок: буква стовпця + цифра рядка (напр. A1, B3).
  ctx2.font = "bold 12px system-ui, sans-serif";
  ctx2.textAlign = "left";
  ctx2.textBaseline = "top";
  for (const c of state.cells) {
    const label = colLetter(c.col) + (c.row + 1);
    const tx = c.x + 3;
    const ty = c.y + 3;
    // Тінь для читабельності на будь-якому фоні.
    ctx2.fillStyle = "rgba(0,0,0,0.7)";
    ctx2.fillText(label, tx + 1, ty + 1);
    ctx2.fillStyle = "#ffffff";
    ctx2.fillText(label, tx, ty);
  }
}

// Номер стовпця (0-based) → букви у стилі Excel (0→A, 1→B, 26→AA).
function colLetter(col) {
  let n = col;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

// Підсвічує комірки, що НЕ відповідають активній масці (помаранчевим).
function drawMaskInvalidHighlights() {
  if (!state.results.length) return;
  let problems;
  try {
    problems = MaskManager.validateResults(state.results);
  } catch (e) {
    return;
  }
  if (!problems.length) return;
  const ctx2 = ctx;
  ctx2.strokeStyle = "#f5a623";
  ctx2.lineWidth = 3;
  for (const p of problems) {
    ctx2.strokeRect(p.x, p.y, p.w, p.h);
  }
}

function currentViewMat() {
  // «Після обробки» — результат попередньої обробки (колір/контраст/deskew),
  // ФАБРИЧНИЙ режим. Якщо обробка не ввімкнена — показуємо робоче зображення.
  if (state.view === "processed") return state.preprocessed || state.working || state.original;
  // «Оригінал» — зберігає всі геометричні трансформації (поворот, обрізка,
  // перспектива), але БЕЗ обробки кольору й без накладень.
  if (state.view === "original") return state.working || state.original;
  if (state.view === "overlay") return state.overlay || state.working || state.original;
  return state.preprocessed || state.working || state.original;
}

// ---------- Знімки для редактора маски ----------
// Редактор маски (mask.js) бере поточне зображення таблиці та комірки
// через ці хуки, щоб намалювати таблицю і дозволити вибір комірок.
window.__maskSnapshotImage = function () {
  // Використовуємо ту саму базу, на якій розпізнавались комірки
  // (та сама система координат, що й у state.cells/state.results).
  const src = state.preprocessed || state.working;
  if (!src) return null;
  return matToDataUrl(src);
};

window.__maskSnapshotCells = function () {
  // Комірки для маски: використовуємо state.cells (їх геометрію row/col/x/y/w/h).
  // Якщо вже є results (після OCR) — беремо геометрію з них (та сама).
  const cells = state.results.length ? state.results : state.cells;
  return cells.map((c) => ({
    row: c.row, col: c.col,
    x: c.x, y: c.y, w: c.w, h: c.h,
    text: c.text || "",
    colLetter: colLetter(c.col),
  }));
};

function applyAngle() {
  if (!state.base) return;
  if (Math.abs(state.angle) > 0.01) {
    safeDelete(state.working);
    state.working = rotateImage(state.base, state.angle);
  } else {
    safeDelete(state.working);
    state.working = state.base.clone();
  }
}

// ---------- Кроки ----------
function setStep(n) {
  state.step = n;
  document.querySelectorAll(".step-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.step === String(n));
  });
  for (let i = 1; i <= 4; i++) {
    const panel = document.getElementById("step" + i);
    panel.classList.toggle("hidden", i !== n);
  }
  // Інструмент «Обрізка» активний лише на кроці «Підготовка» (1).
  // При виході з крону 1 він вимикається; при поверненні — лишається вимкненим.
  if (n !== 1 && cropToolOn) setCropTool(false);
  // Редактор комірок активний лише на кроці «Комірки» (2).
  // cells передаються через проксі активного кадру (state.cells), тому
  // обов'язково перев'язуємо масив при кожному перемиканні етапу.
  if (n === 2) {
    cellEditor.cells = activeFrame() ? activeFrame().cells : [];
    cellEditor.enable();
  } else {
    cellEditor.disable();
  }
  updateCellEditorUI();
  updateStepLockUI();
  render();
}

document.querySelectorAll(".step-btn").forEach((b) => {
  b.addEventListener("click", () => setStep(Number(b.dataset.step)));
});

// ---------- Перемикач режиму перегляду ----------
document.querySelectorAll(".view-btn").forEach((b) => {
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    document.querySelectorAll(".view-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    render();
  });
});

// ---------- Крок 1: Завантаження / демо / поворот / обрізка ----------
// Спільна обробка вибраних файлів: перший — у поточний кадр, решта — нові.
async function importFiles(files) {
  files = Array.from(files || []).filter((f) => !f.type || /^image\//.test(f.type));
  if (!files.length) { toast(t("t.imagesOnly")); return; }
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const mat = await loadImageToCanvas(f);
      if (i === 0 && !activeFrame()) setImage(mat, f.name);
      else addFrame(mat, f.name);
    }
    toast(files.length > 1 ? t("t.loadedMany", {n: files.length}) : t("t.loadedOne"));
  } catch (err) {
    toast(t("t.loadError", {e: err.message}));
  }
}

// Підпис на кнопці вибору файлів: показуємо, скільки файлів вибрано.
function updateFilePickLabel(count) {
  const el = document.getElementById("filePickLabel");
  if (!el) return;
  el.textContent = count
    ? t("s1.filesChosen", { n: count })
    : t("s1.chooseFiles");
  el.dataset.count = count || 0;
}

document.getElementById("fileInput").addEventListener("change", async (e) => {
  const picked = Array.from(e.target.files || []);
  updateFilePickLabel(picked.length);
  await importFiles(picked);
  e.target.value = ""; // щоб можна було обрати ті самі файли знову
  // Підпис повертається до базового, бо файли вже імпортовано в кадри.
  setTimeout(() => updateFilePickLabel(0), 1200);
});

document.getElementById("demoBtn").addEventListener("click", async () => {
  await waitForOpenCV();
  // Генеруємо просте демо-зображення таблиці.
  const rows = 5, cols = 4, cw = 220, ch = 80;
  const w = cols * cw + 1, h = rows * ch + 1;
  const mat = new cv.Mat(h, w, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255));
  // лінії сітки
  for (let r = 0; r <= rows; r++) {
    const y = r * ch;
    cv.line(mat, new cv.Point(0, y), new cv.Point(w, y), new cv.Scalar(0, 0, 0, 255), 2);
  }
  for (let c = 0; c <= cols; c++) {
    const x = c * cw;
    cv.line(mat, new cv.Point(x, 0), new cv.Point(x, h), new cv.Scalar(0, 0, 0, 255), 2);
  }
  // текст
  const texts = [
    ["12.05.2024", "AB-123", "1500.50", "Іванов"],
    ["13.05.2024", "CD-456", "2300.00", "Петров"],
    ["14.05.2024", "EF-789", "999.99", "Сидоров"],
    ["15.05.2024", "GH-012", "4500.75", "Коваль"],
    ["16.05.2024", "IJ-345", "1200.10", "Мельник"],
  ];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cv.putText(
        mat, texts[r][c],
        new cv.Point(c * cw + 20, r * ch + 50),
        cv.FONT_HERSHEY_SIMPLEX, 0.8, new cv.Scalar(20, 20, 20, 255), 2
      );
    }
  }
  setImage(mat);
  toast(t("t.demo"));
});

// Прибирає розширення файлу та службовий хвіст ("IMG_1234 copy"), але зберігає
// саму назву як в оригінального файлу.
function cleanFileName(name) {
  if (!name) return null;
  const base = String(name).replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  return base || null;
}

function setImage(mat, name) {
  // Якщо кадру ще немає — створюємо активний.
  if (!activeFrame()) {
    const fr = createFrame(nextFrameId());
    state.frames.push(fr);
    state.activeIndex = state.frames.length - 1;
  }
  const fr = activeFrame();
  // очищаємо попереднє
  [fr.original, fr.working, fr.base, fr.preprocessed, fr.overlay].forEach((m) => {
    safeDelete(m);
  });
  fr.name = cleanFileName(name) || ("Кадр " + (state.activeIndex + 1));
  fr.original = mat.clone();
  fr.base = mat.clone();
  fr.working = mat.clone();
  fr.angle = 0;
  fr.preprocessed = null;
  fr.cells = [];
  fr.gridNodes = null;
  fr.results = [];
  fr.overlay = null;
  fr.overlayTexts = [];
  fr.thumbDataUrl = matToDataUrl(fr.working);
  // Вхідна матриця вже склонована в original/base/working — звільняємо її,
  // інакше кожне завантаження тече на весь розмір зображення (RGBA).
  safeDelete(mat);
  // Фабричний режим перегляду — «після обробки».
  state.view = "processed";
  document.getElementById("angleSlider").value = 0;
  document.getElementById("angleVal").textContent = "0°";
  if (cropToolOn) cropBox.resetToFull();
  syncViewButtons();
  render();
  resetResultsUI();
  renderGallery();
  updateStepLockUI();
}

// Додає новий кадр із готовою матрицею та робить його активним.
function addFrame(mat, name) {
  const fr = createFrame(nextFrameId());
  fr.name = cleanFileName(name) || ("Кадр " + (state.frames.length + 1));
  fr.original = mat.clone();
  fr.base = mat.clone();
  fr.working = mat.clone();
  fr.thumbDataUrl = matToDataUrl(fr.working);
  safeDelete(mat); // склоновано вище — вхідний Mat звільняємо
  state.frames.push(fr);
  state.activeIndex = state.frames.length - 1;
  // Нові кадри та перемикання кадрів починаємо з режиму «після обробки».
  state.view = "processed";
  document.getElementById("angleSlider").value = 0;
  document.getElementById("angleVal").textContent = "0°";
  if (cropToolOn) cropBox.resetToFull();
  syncViewButtons();
  render();
  resetResultsUI();
  renderGallery();
  updateStepLockUI();
}

// Синхронізує підсвічування кнопок режиму перегляду зі state.view.
function syncViewButtons() {
  document.querySelectorAll(".view-btn").forEach((x) =>
    x.classList.toggle("active", x.dataset.view === state.view));
}

// Вибирає кадр за індексом і синхронізує UI (canvas, editor, слайдери).
function selectFrame(index) {
  if (index < 0 || index >= state.frames.length) return;
  state.activeIndex = index;
  const fr = activeFrame();
  state.view = "processed";
  // Синхронізуємо перемикач режиму перегляду.
  syncViewButtons();
  // Синхронізуємо слайдер кута.
  document.getElementById("angleSlider").value = fr.angle || 0;
  document.getElementById("angleVal").textContent = (fr.angle || 0) + "°";
  // Синхронізуємо редактор комірок (посилання на cells активного кадру).
  cellEditor.cells = fr.cells;
  cellEditor.selected = -1;
  // Показуємо лічильник комірок поточного кадру.
  if (fr.cells.length) {
    const nRows = Math.max(...fr.cells.map(c => c.row)) + 1;
    const nCols = Math.max(...fr.cells.map(c => c.col)) + 1;
    document.getElementById("gridInfo").textContent =
      t("s2.gridFound", {rows: nRows, cols: nCols, cells: fr.cells.length});
  } else {
    document.getElementById("gridInfo").textContent = "";
  }
  // Якщо є результати цього кадру — показуємо список проблем, інакше ховаємо.
  if (fr.results.length) {
    renderResults();
  } else {
    resetResultsUI();
  }
  render(true);
  renderGallery();
  updateStepLockUI();
}

// Перемальовує галерею мініатюр кадрів (показує, якщо кадрів > 1).
function renderGallery() {
  const bar = document.getElementById("frameGallery");
  const gal = document.getElementById("frameList");
  if (!bar || !gal) return;
  const show = state.frames.length > 1;
  bar.style.display = show ? "flex" : "none";
  if (!show) { gal.innerHTML = ""; return; }
  gal.innerHTML = "";
  state.frames.forEach((fr, i) => {
    const t = document.createElement("div");
    t.className = "frame-thumb" + (i === state.activeIndex ? " active" : "");
    t.title = fr.name;
    const img = document.createElement("img");
    img.src = fr.thumbDataUrl || "";
    img.alt = fr.name;
    const lbl = document.createElement("div");
    lbl.className = "frame-thumb-label";
    lbl.textContent = fr.name;
    t.appendChild(img);
    t.appendChild(lbl);
    t.addEventListener("click", () => selectFrame(i));
    gal.appendChild(t);
  });
}

// Показує кнопку «Розпізнати всі» лише в пакетному режимі (>1 кадру).
function updateStepLockUI() {
  const visible = state.frames.length > 1;
  const ocrAllBtn = document.getElementById("ocrAllBtn");
  if (ocrAllBtn) ocrAllBtn.style.display = visible ? "inline-block" : "none";
}

// Оновлює мініатюру активного кадру з його поточного робочого зображення.
// Викликається після операцій, що ЗМІНЮЮТЬ зображення (поворот/обрізка/перспектива).
function updateActiveThumb() {
  const fr = activeFrame();
  if (!fr || !fr.working) return;
  fr.thumbDataUrl = matToDataUrl(fr.working);
  renderGallery();
}

document.getElementById("rotLeftBtn").addEventListener("click", () => {
  if (!state.base) return;
  const r = rotate90(state.base, -1);
  safeDelete(state.base);
  state.base = r;
  state.angle = 0;
  document.getElementById("angleSlider").value = 0;
  document.getElementById("angleVal").textContent = "0°";
  applyAngle();
  render(true);
  updateActiveThumb();
});

document.getElementById("rotRightBtn").addEventListener("click", () => {
  if (!state.base) return;
  const r = rotate90(state.base, 1);
  safeDelete(state.base);
  state.base = r;
  state.angle = 0;
  document.getElementById("angleSlider").value = 0;
  document.getElementById("angleVal").textContent = "0°";
  applyAngle();
  render(true);
  updateActiveThumb();
});

// ---------- Інструмент «Обрізка» (рамка + довільний кут) ----------
document.getElementById("cropToolBtn").addEventListener("click", () => {
  if (!activeFrame() || !state.working) {
    toast(t("t.needImage"));
    return;
  }
  if (cropToolOn) {
    setCropTool(false);
    toast(t("t.cropOff"));
    return;
  }
  // Одночасно вимикаємо ручну перспективу, якщо вона була активна.
  if (perspPicker.isActive()) {
    perspPicker.disable();
    manualPerspPoints = null;
    document.getElementById("manualPerspBtn").textContent = t("s1.perspBtn");
    document.getElementById("applyManualPerspBtn").style.display = "none";
  }
  setCropTool(true);
});

document.getElementById("angleSlider").addEventListener("input", (e) => {
  // Без зображення поворот нічого не робить — не змінюємо стан даремно.
  if (!state.base) return;
  state.angle = parseFloat(e.target.value);
  document.getElementById("angleVal").textContent = state.angle + "°";
  applyAngle();
  render();
});

document.getElementById("applyCropBtn").addEventListener("click", async () => {
  if (!state.working) return;
  await waitForOpenCV();
  const b = cropBox.getBox();
  const x = Math.round(b.x);
  const y = Math.round(b.y);
  const w = Math.round(b.w);
  const h = Math.round(b.h);
  if (w < 2 || h < 2) { toast(t("t.frameTooSmall")); return; }

  const rect = new cv.Rect(x, y, w, h);
  const cropped = state.working.roi(rect).clone();
  safeDelete(state.working);
  state.working = cropped;
  // оновлюємо базу
  safeDelete(state.base);
  state.base = cropped.clone();
  state.angle = 0;
  document.getElementById("angleSlider").value = 0;
  document.getElementById("angleVal").textContent = "0°";
  state.preprocessed = null;
  state.cells = [];
  state.gridNodes = null;
  state.results = [];
  state.overlay = null;
  render(true);
  resetResultsUI();
  updateActiveThumb();
  toast(t("t.cropped"));
});

document.getElementById("resetCropBtn").addEventListener("click", () => {
  render(true);
});

// Скидання поточного кадру: повертає вихідне зображення й чистить обробку.
// Діє ЛИШЕ на активний кадр — інші кадри в пакетному режимі не зачіпає.
document.getElementById("resetBtn").addEventListener("click", () => {
  const fr = activeFrame();
  if (!fr || !fr.original) {
    toast(t("t.nothingToReset"));
    return;
  }
  const many = state.frames.length > 1;
  const name = fr.name || "кадр";
  const msg = many
    ? t("confirm.resetFrame", {name: name, n: state.frames.length - 1})
    : t("confirm.resetSingle", {name: name});
  if (!window.confirm(msg)) return;
  setImage(fr.original.clone(), fr.name);
  toast(many ? t("t.frameReset", {name: name}) : t("t.reset"));
});

// ---------- Крок 2: Обробка + детекція ----------
// Реактивна попередня обробка: при ввімкненні/вимкненні чекбокса чи зміні
// рівня — перераховуємо result на основі поточного робочого зображення.
function getPreprocessOptions() {
  return {
    doDeskew: false,
    doPersp: false,
    doLight: document.getElementById("lightChk").checked,
    lightLevel: parseInt(document.getElementById("lightLevel").value, 10),
  };
}

function anyPreprocessActive() {
  const o = getPreprocessOptions();
  return o.doLight;
}

async function applyPreprocess() {
  if (!state.working) return;
  await waitForOpenCV();
  const o = getPreprocessOptions();
  safeDelete(state.preprocessed);
  if (!anyPreprocessActive()) {
    state.preprocessed = null;
  } else {
    state.preprocessed = preprocessImage(
      state.working, o.doDeskew, o.doPersp, o.doLight, o.lightLevel
    );
  }
  // Перемикач режиму не смикаємо автоматично: користувач сам обирає
  // «Оригінал» чи «Після обробки», за замовчуванням — «Після обробки».
  if (state.view !== "original" && state.view !== "overlay") state.view = "processed";
  syncViewButtons();
  render();
}

// Показуємо/ховаємо повзунок рівня залежно від чекбокса освітлення.
function syncLightLevelVisibility() {
  document.getElementById("lightLevelWrap").style.display =
    document.getElementById("lightChk").checked ? "" : "none";
}

document.getElementById("lightChk").addEventListener("change", () => {
  syncLightLevelVisibility();
  applyPreprocess();
});
document.getElementById("lightLevel").addEventListener("input", (e) => {
  document.getElementById("lightLevelVal").textContent = e.target.value;
  applyPreprocess();
});

// ---------- Ручна перспектива (4 кути) ----------
perspPicker.onComplete = (pts) => {
  manualPerspPoints = pts;
  perspPicker.disable();
  if (cropToolOn) cropBox.enable();
  document.getElementById("manualPerspBtn").textContent = t("s1.perspBtn");
  document.getElementById("applyManualPerspBtn").style.display = "";
  document.getElementById("manualPerspHint").textContent =
    t("s1.perspMarked");
  render();
};

document.getElementById("manualPerspBtn").addEventListener("click", () => {
  if (!state.working) { toast(t("t.needImage")); return; }
  if (perspPicker.isActive()) {
    // Скасувати режим.
    perspPicker.disable();
    if (cropToolOn) cropBox.enable();
    manualPerspPoints = null;
    document.getElementById("manualPerspBtn").textContent = t("s1.perspBtn");
    document.getElementById("applyManualPerspBtn").style.display = "none";
    document.getElementById("manualPerspHint").textContent =
      t("s1.perspHint");
    render();
    return;
  }
  manualPerspPoints = null;
  document.getElementById("applyManualPerspBtn").style.display = "none";
  document.getElementById("manualPerspHint").textContent =
    t("s1.perspHint");
  cropBox.disable();
  perspPicker.enable();
  document.getElementById("manualPerspBtn").textContent = t("s1.perspCancel");
});

document.getElementById("applyManualPerspBtn").addEventListener("click", async () => {
  if (!manualPerspPoints || manualPerspPoints.length !== 4) return;
  await waitForOpenCV();
  const warped = warpPerspectiveFromPoints(state.working, manualPerspPoints);
  if (!warped) { toast(t("t.perspFail")); return; }
  safeDelete(state.working);
  safeDelete(state.base);
  state.working = warped;
  state.base = warped.clone();
  state.angle = 0;
  document.getElementById("angleSlider").value = 0;
  document.getElementById("angleVal").textContent = "0°";
  // Скидаємо попередню обробку, бо зображення змінилось.
  safeDelete(state.preprocessed);
  state.preprocessed = null;
  state.view = "processed";
  syncViewButtons();
  state.cells = [];
  state.gridNodes = null;
  state.results = [];
  manualPerspPoints = null;
  perspPicker.clear();
  document.getElementById("applyManualPerspBtn").style.display = "none";
  document.getElementById("manualPerspHint").textContent =
    t("s1.perspHint");
  if (cropToolOn) cropBox.resetToFull();
  render();
  updateActiveThumb();
  toast(t("t.perspDone"));
});

// Зчитує поточні параметри детекції зі слайдерів.
function getDetectParams() {
  return {
    minArea: parseFloat(document.getElementById("minAreaSlider").value) / 10000,
    maxArea: parseFloat(document.getElementById("maxAreaSlider").value) / 10000,
    closeKX: parseInt(document.getElementById("closeKXSlider").value, 10),
    closeKY: parseInt(document.getElementById("closeKYSlider").value, 10),
    blockSize: parseInt(document.getElementById("blockSizeSlider").value, 10),
  };
}

// Виконує детекцію комірок за замкненими контурами з поточними параметрами.
async function runDetection() {
  if (!state.working) return;
  await waitForOpenCV();
  const src = state.preprocessed || state.working;
  const p = getDetectParams();
  const boxes = detectCellsByContours(src, p);
  state.cells = assignRowCol(boxes);
  cellEditor.cells = state.cells;
  cellEditor.selected = -1;
  const nRows = state.cells.length ? Math.max(...state.cells.map(c => c.row)) + 1 : 0;
  const nCols = state.cells.length ? Math.max(...state.cells.map(c => c.col)) + 1 : 0;
  document.getElementById("gridInfo").textContent =
    t("s2.gridFound", {rows: nRows, cols: nCols, cells: state.cells.length});
  render();
  return state.cells.length;
}

document.getElementById("detectBtn").addEventListener("click", async () => {
  const n = await runDetection();
  if (n != null) toast(t("t.detected", {n: n}));
});

// Оновлює видимість кнопки видалення залежно від наявності виділення.
function updateCellEditorUI() {
  const hasSel = cellEditor.enabled && cellEditor.selected >= 0;
  document.getElementById("deleteCellBtn").style.display = hasSel ? "" : "none";
  // Синхронізуємо кнопку малювання зі станом режиму.
  const drawBtn = document.getElementById("drawCellBtn");
  if (cellEditor.drawMode) {
    drawBtn.textContent = t("s2.cancelDraw");
    drawBtn.classList.add("active");
  } else {
    drawBtn.textContent = t("s2.draw");
    drawBtn.classList.remove("active");
  }
}

document.getElementById("deleteCellBtn").addEventListener("click", () => {
  cellEditor.deleteSelected();
  updateCellEditorUI();
  toast(t("t.cellDeleted"));
});

document.getElementById("drawCellBtn").addEventListener("click", () => {
  const btn = document.getElementById("drawCellBtn");
  if (cellEditor.drawMode) {
    cellEditor.setDrawMode(false);
    btn.textContent = t("s2.draw");
    btn.classList.remove("active");
  } else {
    cellEditor.setDrawMode(true);
    btn.textContent = t("s2.cancelDraw");
    btn.classList.add("active");
    toast(t("t.dragCell"));
  }
  updateCellEditorUI();
  render();
});

// Слайдери параметрів: оновлюємо підписи та перезапускаємо детекцію на льоту.
function bindDetectSlider(id, valId, fmt) {
  const slider = document.getElementById(id);
  const val = document.getElementById(valId);
  slider.addEventListener("input", () => {
    val.textContent = fmt(slider.value);
    runDetection();
  });
}
bindDetectSlider("minAreaSlider", "minAreaVal", (v) => (parseFloat(v) / 100).toFixed(2) + "%");
bindDetectSlider("maxAreaSlider", "maxAreaVal", (v) => (parseFloat(v) / 100).toFixed(2) + "%");
bindDetectSlider("closeKXSlider", "closeKXVal", (v) => v);
bindDetectSlider("closeKYSlider", "closeKYVal", (v) => v);
bindDetectSlider("blockSizeSlider", "blockSizeVal", (v) => v);

// ---------- Крок 3: OCR + накладання ----------
// Обмежувач запитів на хвилину (RPM). Батчинг по рядках дає ~N запитів (N = число
// рядків), що зазвичай < 10-15 — вкладається в безкоштовний ліміт ~10 RPM.
// Тримаємо стелю 9/хв як безпечний буфер, щоб не отримати 429.
const rpmTracker = {
  timestamps: [],
  maxPerMinute: 9,
  async waitForSlot() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60000);
    if (this.timestamps.length >= this.maxPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = 60000 - (now - oldest) + 50;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.waitForSlot();
    }
    this.timestamps.push(now);
  },
};

// Розпізнавання тексту комірки через Google Gemini (Google AI Studio).
// Працює прямо з браузера (fetch), тому сумісне з GitHub Pages без бекенду.
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_ENDPOINT = (key, model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

function getGeminiKey() {
  return document.getElementById("geminiKey").value.trim();
}

// Перетворює dataURL (image/png;base64,...) на чистий base64.
function dataUrlToBase64(dataUrl) {
  return dataUrl.split(",")[1] || "";
}

// Склеює масив зображень комірок ({ id, dataUrl }[]) в ОДНЕ горизонтальне
// зображення через HTML-канвас. Над кожною коміркою малюємо її унікальний id
// у квадратній рамці — модель повертає текст, прив'язаний до цього id, тому
// перемішування значень фізично неможливе (id є частиною самого зображення).
// Між комірками — чорна вертикальна роздільна лінія, щоб не зливались сусіди.
function hconcatImages(items, gapPx = 20, linePx = 3, labelH = 28) {
  const imgs = items.map((it) => {
    const img = new Image();
    img.src = it.dataUrl;
    return { id: it.id, img };
  });
  return Promise.all(imgs.map((o) => new Promise((res) => {
    if (o.img.complete && o.img.naturalWidth) res();
    else { o.img.onload = () => res(); o.img.onerror = () => res(); }
  }))).then(() => {
    let totalW = 0, maxH = 0;
    for (const o of imgs) {
      totalW += o.img.naturalWidth || o.img.width;
      maxH = Math.max(maxH, o.img.naturalHeight || o.img.height);
    }
    totalW += gapPx * (imgs.length - 1);
    const c = document.createElement("canvas");
    c.width = totalW;
    c.height = maxH + labelH;
    const cx = c.getContext("2d");
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, c.width, c.height);
    let x = 0;
    for (let i = 0; i < imgs.length; i++) {
      const o = imgs[i];
      const w = o.img.naturalWidth || o.img.width;
      const h = o.img.naturalHeight || o.img.height;
      // Малюємо комірку під зоною з id.
      cx.drawImage(o.img, x, labelH, w, h);
      // Малюємо id над коміркою (у чорній рамці для контрасту).
      cx.fillStyle = "#fff";
      cx.fillRect(x, 0, w, labelH);
      cx.strokeStyle = "#000";
      cx.lineWidth = 2;
      cx.strokeRect(x, 0, w, labelH);
      cx.fillStyle = "#000";
      cx.font = "bold 16px sans-serif";
      cx.textBaseline = "middle";
      cx.textAlign = "center";
      cx.fillText(String(o.id), x + w / 2, labelH / 2);
      x += w;
      // Між комірками — чорна вертикальна роздільна лінія.
      if (i < imgs.length - 1) {
        const mid = x + gapPx / 2;
        cx.fillStyle = "#000";
        cx.fillRect(mid - linePx / 2, labelH, linePx, maxH);
        x += gapPx;
      }
    }
    return c.toDataURL("image/png");
  });
}

// Розпізнає текст з одного склеєного зображення рядка, де над кожною коміркою
// намальовано її унікальний id. Повертає об'єкт { [id]: text }.
// Прив'язка за id (намальованим на зображенні) гарантує 100% відповідність
// «комірка -> текст» незалежно від порядку, у якому модель поверне відповідь.
async function recognizeRowImage(dataUrl, onStatus) {
  const key = getGeminiKey();
  if (!key) throw new Error(t("err.needKey"));

  // Мова розпізнавання фіксована: українська + англійська змішано.
  const langHint = "Ukrainian (or mixed Ukrainian/English)";

  const instructions = [{
    text: `Це зображення одного рядка таблиці. Зверху над КОЖНОЮ коміркою в рамці написано її унікальний номер (id).
Розпізнай текст у КОЖНІЙ комірці і поверни результат по одному рядку на комірку у форматі:
id:::текст

Приклад:
0:::Іваненко
1:::25.50
2:::
3:::Київ

Правила:
- id ОБОВ'ЯЗКОВО — це число, намальоване в рамці НАД коміркою.
- Кожен рядок — рівно один id і його текст, розділені «:::».
- Текст — ЛИШЕ вміст комірки, без лапок, без пояснень.
- Якщо комірка порожня — залиш текст після «:::» порожнім (наприклад «2:::»).
- Не змінюй id, не переставляй, не додавай зайвого тексту.
Мова тексту: ${langHint}.`
  }];

  const imageParts = [{
    inline_data: { mime_type: "image/png", data: dataUrlToBase64(dataUrl) }
  }];

  const body = {
    contents: [{ parts: [...instructions, ...imageParts] }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 }
  };

  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (onStatus) {
      onStatus({
        model: GEMINI_MODEL,
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        bytes: JSON.stringify(body).length,
      });
    }
    const resp = await fetch(GEMINI_ENDPOINT(key, GEMINI_MODEL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const json = await resp.json();
      const raw = (json.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "").trim();

      // Парсимо рядки у форматі «id:::текст» у map id -> text.
      const result = {};
      const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        const m = line.match(/^(\d+)\s*:{3}\s*([\s\S]*)$/);
        if (m) result[m[1]] = m[2].trim();
      }
      return result;
    }

    // 429 (забагато запитів) або 503 (перевантаження) — чекаємо і повторюємо.
    if ((resp.status === 429 || resp.status === 503) && attempt < maxRetries) {
      const retryAfter = parseInt(resp.headers.get("Retry-After") || "", 10);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const errText = await resp.text();
    throw new Error(t("err.gemini", { status: resp.status, e: errText.slice(0, 200) }));
  }

  throw new Error(t("err.geminiTimeout"));
}

// Розпізнає текст з ОДНОГО зображення комірки (dataUrl). Повертає рядок.
// Використовується для перезаповнення однієї конкретної комірки за запитом ШІ.
async function recognizeSingleCell(dataUrl) {
  const key = getGeminiKey();
  if (!key) throw new Error(t("err.needKey"));

  // Мова розпізнавання фіксована: українська + англійська змішано.
  const langHint = "Ukrainian (or mixed Ukrainian/English)";

  const instructions = [{
    text: `Розпізнай текст на цьому зображенні комірки таблиці.
Поверни ЛИШЕ сам текст комірки — без лапок, без пояснень, без зайвих символів.
Якщо комірка порожня — поверни порожній рядок.
Мова тексту: ${langHint}.`
  }];

  const imageParts = [{
    inline_data: { mime_type: "image/png", data: dataUrlToBase64(dataUrl) }
  }];

  const body = {
    contents: [{ parts: [...instructions, ...imageParts] }],
    generationConfig: { temperature: 0, maxOutputTokens: 512 }
  };

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(GEMINI_ENDPOINT(key, GEMINI_MODEL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const json = await resp.json();
      const raw = (json.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "").trim();
      return raw.replace(/^["']+|["']+$/g, "").trim();
    }

    if ((resp.status === 429 || resp.status === 503) && attempt < maxRetries) {
      const retryAfter = parseInt(resp.headers.get("Retry-After") || "", 10);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const errText = await resp.text();
    throw new Error(t("err.gemini", { status: resp.status, e: errText.slice(0, 200) }));
  }

  throw new Error(t("err.geminiTimeout"));
}

// Виконує OCR для ОДНОГО кадру. Оновлює frame.results і (якщо кадр активний)
// перемальовує список проблем. btn/statusEl використовуються для UI-прогресу.
async function runOcrOnFrame(frame, btn, statusEl) {
  if (!frame.working || frame.cells.length === 0) {
    throw new Error(t("err.needCells"));
  }
  const src = frame.preprocessed || frame.working;

  frame.results = [];

  // Підготовляємо зображення (ROI) для кожної комірки наперед.
  const orderedCells = frame.cells.slice().sort((a, b) =>
    (a.row - b.row) || (a.col - b.col));

  const jobs = orderedCells.map((cell) => {
    let roi;
    if (cell.quad && cell.quad.length === 4) {
      roi = warpPerspectiveFromPoints(src, cell.quad);
      if (!roi) roi = src.roi(new cv.Rect(cell.x, cell.y, cell.w, cell.h));
    } else {
      roi = src.roi(new cv.Rect(cell.x, cell.y, cell.w, cell.h));
    }
    const dataUrl = matToDataUrl(roi);
    safeDelete(roi);
    return { cell, dataUrl };
  });

  statusEl.style.display = "block";

  // Групуємо комірки по рядках (row).
  const rowsMap = new Map();
  for (const job of jobs) {
    if (!rowsMap.has(job.cell.row)) rowsMap.set(job.cell.row, []);
    rowsMap.get(job.cell.row).push(job);
  }
  const rows = Array.from(rowsMap.keys()).sort((a, b) => a - b).map(r =>
    rowsMap.get(r).sort((a, b) => a.cell.col - b.cell.col));

  const idByKey = {};
  jobs.forEach((job, i) => {
    idByKey[job.cell.row * 10000 + job.cell.col] = String(i);
  });

  const textByKey = {};
  for (let ri = 0; ri < rows.length; ri++) {
    const rowJobs = rows[ri];
    btn.textContent = `🔍 Розпізнавання… рядок ${ri + 1}/${rows.length}`;
    await rpmTracker.waitForSlot();
    const items = rowJobs.map(j => ({
      id: idByKey[j.cell.row * 10000 + j.cell.col],
      dataUrl: j.dataUrl,
    }));
    const rowImage = await hconcatImages(items);
    const textsById = await recognizeRowImage(rowImage, (st) => {
      const kb = (st.bytes / 1024).toFixed(1);
      statusEl.innerHTML =
        `<span class="status-line">${t("s3.rowStatus", { i: ri + 1, n: rows.length, cells: rowJobs.length, model: st.model })}</span>` +
        `<span class="status-line">${t("s3.attemptStatus", { a: st.attempt, m: st.maxRetries, kb })}</span>` +
        `<span class="status-req">${t("s3.waiting")}</span>`;
    });
    rowJobs.forEach((job) => {
      const key = job.cell.row * 10000 + job.cell.col;
      const id = idByKey[key];
      textByKey[key] = textsById[id] != null ? textsById[id] : "";
    });
  }
  statusEl.innerHTML = `<span class="status-line"></span>`;
  statusEl.querySelector(".status-line").textContent =
    t("s3.ocrSummary", { cells: jobs.length, rows: rows.length });

  frame.results = jobs.map((job) => {
    const cell = job.cell;
    const key = cell.row * 10000 + cell.col;
    const raw = textByKey[key] != null ? textByKey[key] : "";
    const normalized = /^[.·•\s]*$/.test(raw) ? " " : raw;
    return {
      row: cell.row, col: cell.col,
      x: cell.x, y: cell.y, w: cell.w, h: cell.h,
      text: normalized,
      confidence: 100,
    };
  });
}

document.getElementById("ocrBtn").addEventListener("click", async () => {
  const fr = activeFrame();
  if (!fr || !fr.working || fr.cells.length === 0) {
    toast(t("t.needCells"));
    return;
  }
  if (!getGeminiKey()) {
    toast(t("t.needKey"));
    return;
  }
  const btn = document.getElementById("ocrBtn");
  const statusEl = document.getElementById("ocrStatus");
  btn.disabled = true;
  try {
    await runOcrOnFrame(fr, btn, statusEl);
    renderResults();
    toast(t("t.ocrDone"));
  } catch (err) {
    statusEl.style.display = "block";
    statusEl.innerHTML = `<span class="status-line"></span>`;
    statusEl.querySelector(".status-line").textContent = t("s3.errorLine", {e: err.message});
    toast(t("t.ocrError", {e: err.message}));
  } finally {
    btn.disabled = false;
    btn.textContent = t("s3.ocrBtn");
  }
});

// «Розпізнати всі» — послідовно проганяє OCR по всіх незаблокованих кадрах.
document.getElementById("ocrAllBtn").addEventListener("click", async () => {
  if (!getGeminiKey()) {
    toast(t("t.needKey"));
    return;
  }
  const targets = state.frames.filter((fr) => fr.working && fr.cells.length);
  if (!targets.length) {
    toast(t("t.noFramesCells"));
    return;
  }
  const btn = document.getElementById("ocrBtn");
  const allBtn = document.getElementById("ocrAllBtn");
  const statusEl = document.getElementById("ocrStatus");
  btn.disabled = true;
  allBtn.disabled = true;
  const origLabel = allBtn.textContent;
  try {
    for (let i = 0; i < targets.length; i++) {
      const fr = targets[i];
      allBtn.textContent = t("s3.recognizing", {i: i + 1, n: targets.length, name: fr.name});
      statusEl.style.display = "block";
      statusEl.innerHTML = `<span class="status-line"></span>`;
      statusEl.querySelector(".status-line").textContent = t("s3.frameStatus", {i: i + 1, n: targets.length, name: fr.name});
      await runOcrOnFrame(fr, btn, statusEl);
    }
    // Після обробки всіх — показуємо результати активного кадру.
    renderResults();
    toast(t("t.ocrMany", {n: targets.length}));
  } catch (err) {
    statusEl.style.display = "block";
    statusEl.innerHTML = `<span class="status-line"></span>`;
    statusEl.querySelector(".status-line").textContent = t("s3.errorLine", {e: err.message});
    toast(t("t.ocrError", {e: err.message}));
  } finally {
    btn.disabled = false;
    allBtn.disabled = false;
    allBtn.textContent = origLabel;
    btn.textContent = t("s3.ocrBtn");
  }
});

function matToDataUrl(mat) {
  const c = document.createElement("canvas");
  c.width = mat.cols; c.height = mat.rows;
  cv.imshow(c, mat);
  return c.toDataURL("image/png");
}

function renderResults() {
  const total = state.results.length;

  // 1) Комірки з відсутнім значенням (порожній рядок).
  const isEmpty = (x) => (x == null ? "" : String(x)).trim() === "";
  const emptyProblems = state.results.filter((r) => isEmpty(r.text));

  // 2) Комірки, що НЕ відповідають активній масці (помаранчеві).
  let maskProblems = [];
  try {
    maskProblems = MaskManager.validateResults(state.results);
  } catch (e) {
    maskProblems = [];
  }

  // Об'єднуємо (за row,col) без дублів.
  const seen = new Set();
  const problems = [];
  const kind = {}; // key -> 'empty' | 'mask'
  for (const r of emptyProblems) {
    const key = r.row + "," + r.col;
    seen.add(key);
    problems.push(r);
    kind[key] = "empty";
  }
  for (const r of maskProblems) {
    const key = r.row + "," + r.col;
    if (!seen.has(key)) {
      seen.add(key);
      problems.push(r);
      kind[key] = "mask";
    }
  }

  const auto = total - problems.length;

  document.getElementById("metrics").style.display = "flex";
  document.getElementById("mTotal").textContent = total;
  document.getElementById("mAuto").textContent = auto;
  document.getElementById("mProblem").textContent = problems.length;

  document.getElementById("overlayBtn").style.display = "inline-block";
  document.getElementById("exportCsvBtn").style.display = "inline-block";
  document.getElementById("editCellBtn").style.display = "inline-block";
  document.getElementById("reOcrCellBtn").style.display = "inline-block";
  document.getElementById("verifyMaskBtn").style.display = MaskManager.isActive() ? "inline-block" : "none";
  document.getElementById("applyReplacesBtn").style.display = MaskManager.isActive() ? "inline-block" : "none";

  // Проблемні комірки
  const container = document.getElementById("problemCells");
  container.innerHTML = "";
  if (problems.length === 0) {
    const okP = document.createElement("p");
    okP.className = "hint";
    okP.textContent = t("s3.noProblems");
    container.appendChild(okP);
  } else {
    for (const r of problems) {
      const key = r.row + "," + r.col;
      const isMask = kind[key] === "mask";
      const card = document.createElement("div");
      card.className = "cell-card" + (isMask ? " cell-card-invalid" : "");
      const roi = (state.preprocessed || state.working).roi(new cv.Rect(r.x, r.y, r.w, r.h));
      const img = document.createElement("img");
      img.src = matToDataUrl(roi);
      safeDelete(roi);
      const input = document.createElement("input");
      input.type = "text";
      input.value = r.text;
      input.placeholder = t("s3.cellValuePh", { row: r.row, col: r.col });
      // Введення одразу оновлює значення і лівий overlay, АЛЕ комірка
      // ЛИШАЄТЬСЯ в списку (не зникає) до підтвердження Enter або перевірки.
      input.addEventListener("input", (e) => {
        r.text = e.target.value;
        refreshOverlayTexts(); // живий апдейт тексту у вікні накладання
        render(); // перемальовуємо overlay одразу
      });
      // Enter — підтвердити виправлення цієї комірки і перевірити її.
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          r.text = input.value;
          refreshOverlayTexts(); // оновлюємо текст у вікні накладання
          render();
          renderResults();
        }
      });
      const cap = document.createElement("div");
      cap.className = "hint";
      cap.textContent = `(${r.row},${r.col})` +
        (isMask ? t("s3.badMaskSuffix") : t("s3.emptySuffix"));
      card.appendChild(img);
      card.appendChild(cap);
      card.appendChild(input);
      container.appendChild(card);
    }
  }
}

function resetResultsUI() {
  document.getElementById("metrics").style.display = "none";
  document.getElementById("overlayBtn").style.display = "none";
  document.getElementById("exportCsvBtn").style.display = "none";
  document.getElementById("downloadPngBtn").style.display = "none";
  document.getElementById("editCellBtn").style.display = "none";
  document.getElementById("reOcrCellBtn").style.display = "none";
  document.getElementById("verifyMaskBtn").style.display = "none";
  document.getElementById("applyReplacesBtn").style.display = "none";
  setEditCellMode(false);
  setReOcrCellMode(false);
  document.getElementById("problemCells").innerHTML = "";
  document.getElementById("gridInfo").textContent = "";
}

document.getElementById("overlayBtn").addEventListener("click", async () => {
  if (!state.results.length) return;
  await waitForOpenCV();
  const src = state.preprocessed || state.working;
  safeDelete(state.overlay);
  state.overlay = src.clone();
  // Текст малюємо окремо через ctx.fillText у render() (кирилиця не працює в cv.putText).
  state.overlayTexts = state.results
    .filter((r) => r.text && r.text.trim())
    .map((r) => ({ x: r.x + 4, y: r.y + r.h - 8, text: r.text }));
  state.view = "overlay";
  document.querySelectorAll(".view-btn").forEach((x) =>
    x.classList.toggle("active", x.dataset.view === "overlay"));
  render();
  document.getElementById("downloadPngBtn").style.display = "inline-block";
  toast(t("t.textOverlaid"));
});

// ---------- Перевірка маскою (ручна переверифікація) ----------
// Перегенеровує overlay-текст із поточних результатів (щоб зміни комірок
// одразу відображались у вікні накладання).
function refreshOverlayTexts() {
  state.overlayTexts = state.results
    .filter((r) => r.text && r.text.trim())
    .map((r) => ({ x: r.x + 4, y: r.y + r.h - 8, text: r.text }));
}

// Застосовує заміни активної маски до текстів комірок і повертає, чи щось змінилось.
function applyMaskReplaces() {
  if (!state.results.length) return false;
  let changed = false;
  try {
    const corrected = MaskManager.applyReplaces(state.results);
    for (let i = 0; i < corrected.length; i++) {
      if (corrected[i].text !== state.results[i].text) {
        state.results[i].text = corrected[i].text;
        changed = true;
      }
    }
  } catch (e) {
    // ignore
  }
  return changed;
}

document.getElementById("verifyMaskBtn").addEventListener("click", () => {
  if (!state.results.length) return;
  // Просто перевалідовуємо результати маскою та перемальовуємо
  // (помаранчеві підсвітки + список проблем) — БЕЗ автозамін.
  refreshOverlayTexts();
  render();
  renderResults();
  toast(t("t.maskChecked"));
});

// Кнопка «🔄 Застосувати заміни» — явно застосовує mask.replaces до комірок.
document.getElementById("applyReplacesBtn").addEventListener("click", () => {
  if (!state.results.length) return;
  const changed = applyMaskReplaces();
  refreshOverlayTexts();
  render();
  renderResults();
  toast(changed ? t("t.replacesApplied") : t("t.replacesNone"));
});

// ---------- Крок 4: Експорт ----------
document.getElementById("exportCsvBtn").addEventListener("click", () => {
  if (!state.results.length) return;
  const nRows = Math.max(...state.results.map((r) => r.row)) + 1;
  const nCols = Math.max(...state.results.map((r) => r.col)) + 1;
  const grid = Array.from({ length: nRows }, () => Array(nCols).fill(""));
  for (const r of state.results) {
    grid[r.row][r.col] = r.text;
  }
  const csv = grid.map((row) =>
    row.map((c) => `"${(c || "").replace(/"/g, '""')}"`).join(",")
  ).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const frName = (activeFrame() && activeFrame().name) || "table";
  a.download = frName.replace(/[\\/:*?"<>|]+/g, "_") + ".csv";
  a.click();
  URL.revokeObjectURL(a.href);
  toast(t("t.csvSaved"));
});

document.getElementById("downloadPngBtn").addEventListener("click", () => {
  if (!state.overlay) return;
  const c = document.createElement("canvas");
  c.width = state.overlay.cols; c.height = state.overlay.rows;
  cv.imshow(c, state.overlay);
  // Малюємо текст поверх так само, як у render(), щоб він потрапив у PNG.
  const cctx = c.getContext("2d");
  cctx.fillStyle = "#d22";
  cctx.strokeStyle = "#fff";
  cctx.lineWidth = 3;
  cctx.font = "bold 16px sans-serif";
  cctx.textBaseline = "alphabetic";
  for (const t of state.overlayTexts) {
    cctx.strokeText(t.text, t.x, t.y);
    cctx.fillText(t.text, t.x, t.y);
  }
  const a = document.createElement("a");
  a.href = c.toDataURL("image/png");
  const frN = (activeFrame() && activeFrame().name) || "overlay";
  a.download = frN.replace(/[\\/:*?"<>|]+/g, "_") + "_overlay.png";
  a.click();
});

// ---------- Інструмент редагування комірки (клік по зображенню) ----------
let editCellMode = false;
let editCellTarget = null; // { row, col, x, y, w, h } комірки, що редагується

// Вмикає/вимикає режим «клікни по комірці, щоб відредагувати».
function setEditCellMode(on) {
  editCellMode = on;
  const btn = document.getElementById("editCellBtn");
  if (on) {
    btn.textContent = t("s3.cancelEdit");
    btn.classList.add("active");
    canvas.style.cursor = "crosshair";
    toast(t("t.clickCell"));
  } else {
    btn.textContent = t("s3.editCell");
    btn.classList.remove("active");
    canvas.style.cursor = "";
  }
}

// Перетворює координати кліку (clientX/Y) у координати зображення (пікселі canvas).
function canvasClickToImageCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

// Знаходить комірку в state.results під точкою (px, py).
function findResultCellAt(px, py) {
  for (const r of state.results) {
    // Використовуємо bbox комірки (простий і стабільний hit-test).
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
      return r;
    }
  }
  return null;
}

// Відкриває модальне вікно для комірки.
function openCellModal(cell) {
  editCellTarget = cell;
  const src = state.preprocessed || state.working;
  const roi = src.roi(new cv.Rect(cell.x, cell.y, cell.w, cell.h));
  const img = document.getElementById("cellModalImg");
  img.src = matToDataUrl(roi);
  safeDelete(roi);
  document.getElementById("cellModalTitle").textContent =
    t("s3.cellTitle", { row: cell.row + 1, col: cell.col + 1 });
  const input = document.getElementById("cellModalInput");
  input.value = cell.text === " " ? "" : cell.text;
  document.getElementById("cellModal").style.display = "flex";
  // Виділяємо текст по замовчуванню, щоб при введенні він замінювався.
  input.focus();
  input.select();
}

// Закриває модальне вікно та зберігає значення.
function closeCellModal(save) {
  const modal = document.getElementById("cellModal");
  if (modal.style.display === "none") return;
  if (save && editCellTarget) {
    const val = document.getElementById("cellModalInput").value;
    // Порожній ввід → один пробіл (як і для порожніх комірок після OCR).
    editCellTarget.text = val === "" ? " " : val;
    // Оновлюємо overlay-текст, якщо він уже згенерований.
    if (state.overlayTexts.length) {
      refreshOverlayTexts();
      render();
    }
    // Перебудовуємо список проблем (щоб невалідна комірка з'явилась справа).
    renderResults();
    toast(t("t.saved"));
  }
  editCellTarget = null;
  modal.style.display = "none";
}

document.getElementById("editCellBtn").addEventListener("click", () => {
  if (!state.results.length) return;
  if (reOcrCellMode) setReOcrCellMode(false); // взаємовиключно з режимом перерозпізнавання
  setEditCellMode(!editCellMode);
});

// Клік по полотну в режимі редагування.
canvas.addEventListener("click", (e) => {
  if (!editCellMode) return;
  const { x, y } = canvasClickToImageCoords(e);
  const cell = findResultCellAt(x, y);
  if (cell) {
    openCellModal(cell);
  } else {
    toast(t("t.clickExactlyCell"));
  }
});

// ---------- Інструмент «Перерозпізнати комірку (ШІ)» ----------
let reOcrCellMode = false;
let reOcrBusy = false;

// Вмикає/вимикає режим «клікни по комірці, щоб перерозпізнати її окремо».
function setReOcrCellMode(on) {
  reOcrCellMode = on;
  const btn = document.getElementById("reOcrCellBtn");
  if (on) {
    btn.textContent = t("s3.cancelReOcr");
    btn.classList.add("active");
    canvas.style.cursor = "crosshair";
    toast(t("t.clickCellForAi"));
  } else {
    btn.textContent = t("s3.reOcrCell");
    btn.classList.remove("active");
    canvas.style.cursor = "";
  }
}

// Перерозпізнає окрему комірку: вирізає її ROI, відправляє в ШІ, перезаписує текст.
async function reRecognizeCell(cell) {
  if (reOcrBusy) return;
  reOcrBusy = true;
  try {
    const src = state.preprocessed || state.working;
    const roi = src.roi(new cv.Rect(cell.x, cell.y, cell.w, cell.h));
    const dataUrl = matToDataUrl(roi);
    safeDelete(roi);

    toast(t("t.reOcrRunning", {r: cell.row + 1, c: cell.col + 1}));
    const text = await recognizeSingleCell(dataUrl);

    cell.text = text === "" ? " " : text;
    // Оновлюємо overlay-текст, якщо він уже згенерований.
    if (state.overlayTexts.length) {
      refreshOverlayTexts();
      render();
    }
    // Перебудовуємо список проблем (щоб невалідна комірка з'явилась справа).
    renderResults();
    toast(t("t.reOcrDone", {text: cell.text === " " ? t("t.emptyCell") : cell.text}));
  } catch (err) {
    toast(t("t.error", {e: (err && err.message ? err.message : err)}));
  } finally {
    reOcrBusy = false;
  }
}

document.getElementById("reOcrCellBtn").addEventListener("click", () => {
  if (!state.results.length) return;
  if (editCellMode) setEditCellMode(false); // взаємовиключно з режимом редагування
  setReOcrCellMode(!reOcrCellMode);
});

// Клік по полотну в режимі перерозпізнавання.
canvas.addEventListener("click", (e) => {
  if (!reOcrCellMode) return;
  const { x, y } = canvasClickToImageCoords(e);
  const cell = findResultCellAt(x, y);
  if (cell) {
    reRecognizeCell(cell);
  } else {
    toast(t("t.clickExactlyCell"));
  }
});

// Закриття модалки: хрестик, клік по фону, Enter (зберегти), Escape (скасувати).
document.getElementById("cellModalClose").addEventListener("click", () => closeCellModal(false));
document.getElementById("cellModal").addEventListener("click", (e) => {
  if (e.target === document.getElementById("cellModal")) closeCellModal(false);
});
document.getElementById("cellModalInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    closeCellModal(true);
  } else if (e.key === "Escape") {
    closeCellModal(false);
  }
});

// ---------- Ініціалізація ----------
// Перемальовуємо та перевіряємо результати при зміні активної маски.
window.__onMaskChange = () => {
  render();
  // Показуємо/ховаємо кнопки перевірки та замін залежно від наявності активної маски.
  const showMaskBtns = !!(state.results.length && MaskManager.isActive());
  document.getElementById("verifyMaskBtn").style.display = showMaskBtns ? "inline-block" : "none";
  document.getElementById("applyReplacesBtn").style.display = showMaskBtns ? "inline-block" : "none";
  if (state.results.length) renderResults();
};

setStep(1);
syncLightLevelVisibility();
renderGallery();
updateStepLockUI();

// ---------- Підказки до слайдерів (?) ----------
// :hover для ::after ненадійний, тому клас .tip-open ставиться явно.
// Додатково підказуємо позицію стрілкою (top/bottom), щоб вона не вилітала
// за межі вікна: біля верху — показуємо знизу, інакше — зверху.
function initHelpTips() {
  const tips = document.querySelectorAll(".help-tip[data-tip]");
  const place = (el) => {
    // Підказка в position:fixed — координати беремо з вічку екрана.
    const r = el.getBoundingClientRect();
    const TIP_W = 300;
    // Тримаємо картку в межах вікна: центр не ближче ніж півширини до країв.
    const cx = Math.min(Math.max(r.left + r.width / 2, TIP_W / 2 + 8), window.innerWidth - TIP_W / 2 - 18);
    document.documentElement.style.setProperty("--tip-x", Math.round(cx) + "px");
    document.documentElement.style.setProperty("--tip-y", Math.round(r.top) + "px");
    el.classList.remove("tip-below");
    if (r.top < 150) el.classList.add("tip-below");
  };
  tips.forEach((el) => {
    el.addEventListener("mouseenter", () => { place(el); el.classList.add("tip-open"); });
    el.addEventListener("mouseleave", () => el.classList.remove("tip-open"));
    el.addEventListener("focus", () => { place(el); el.classList.add("tip-open"); });
    el.addEventListener("blur", () => el.classList.remove("tip-open"));
    // Клік/тап: показати-сховати (для тач-пристроїв).
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      place(el);
      el.classList.toggle("tip-open");
    });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") el.classList.remove("tip-open");
    });
  });
  // Клацаємо поза підказкою — закриваємо всі.
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest || !ev.target.closest(".help-tip")) {
      document.querySelectorAll(".help-tip.tip-open").forEach((x) => x.classList.remove("tip-open"));
    }
  });
  // Прокрутка змінює позицію — закриваємо, щоб не «висіла» не там.
  window.addEventListener("scroll", () => {
    document.querySelectorAll(".help-tip.tip-open").forEach((x) => x.classList.remove("tip-open"));
  }, true);
}
initHelpTips();

// ---------- Drag & drop імпорту зображень на всю сторінку ----------
// Кидок файлів будь-де на сторінці (крім модалок) додає їх як кадри.
(function initPageDropZone() {
  let depth = 0;
  const overlay = document.getElementById("dropOverlay");

  const hasFiles = (e) =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  const inModal = (e) =>
    !!(e.target && e.target.closest && e.target.closest(".modal-backdrop, .modal"));

  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || inModal(e)) return;
    e.preventDefault();
    depth++;
    if (overlay) overlay.classList.add("visible");
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0 && overlay) overlay.classList.remove("visible");
  });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    if (overlay) overlay.classList.remove("visible");
    if (inModal(e)) return;
    await importFiles(e.dataTransfer.files);
  });
})();

// ---------- Реакція на зміну мови ----------
// Перемальовуємо тексти, які згенеровані в JS (лічильник комірок, кнопки режимів).
window.__i18nRefresh = function () {
  try {
    const fr = activeFrame && activeFrame();
    if (fr && fr.cells && fr.cells.length) {
      const nRows = Math.max(...fr.cells.map((c) => c.row)) + 1;
      const nCols = Math.max(...fr.cells.map((c) => c.col)) + 1;
      document.getElementById("gridInfo").textContent =
        t("s2.gridFound", { rows: nRows, cols: nCols, cells: fr.cells.length });
    }
    if (typeof updateFilePickLabel === "function") updateFilePickLabel(0);
    if (typeof window.__syncLangLabel === "function") window.__syncLangLabel(I18N.getLang());
    if (typeof window.__maskI18nRefresh === "function") window.__maskI18nRefresh();
    if (typeof updateCellEditorUI === "function") updateCellEditorUI();
    // Кнопки режимів редагування мають підписи, що залежать від мови.
    if (typeof setEditCellMode === "function" && editCellMode) setEditCellMode(true);
    if (typeof setReOcrCellMode === "function" && reOcrCellMode) setReOcrCellMode(true);
    const ocrB = document.getElementById("ocrBtn");
    if (ocrB && !ocrB.disabled) ocrB.textContent = t("s3.ocrBtn");
  } catch (e) { /* тихо: хук не має ламати перемикання мови */ }
};

// Синхронізує підпис вибраної мови (самоназва: Українська / English)
// та позначку активного пункту в підменю.
function syncLangLabel(lang) {
  document.querySelectorAll(".sub-item[data-lang]").forEach((x) => {
    const on = x.dataset.lang === lang;
    x.classList.toggle("active", on);
    x.setAttribute("aria-checked", on ? "true" : "false");
  });
  const lv = document.getElementById("langValue");
  if (lv) lv.textContent = t("lang." + lang);
}
window.__syncLangLabel = syncLangLabel;

// ---------- Меню налаштувань (крайній лівий кут) ----------
(function initSettingsMenu() {
  const wrap = document.getElementById("settingsWrap");
  const btn = document.getElementById("settingsBtn");
  const menu = document.getElementById("settingsMenu");
  if (!wrap || !btn || !menu) return;

  const setOpen = (on) => {
    menu.classList.toggle("open", on);
    btn.setAttribute("aria-expanded", on ? "true" : "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains("open"));
  });
  // Клік поза меню закриває його.
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
  // Позначаємо активну мову збереженим вибором.
  const curLang = (window.I18N && I18N.getLang()) || "uk";
  syncLangLabel(curLang);

  // Вибір мови.
  menu.querySelectorAll(".sub-item[data-lang]").forEach((item) => {
    item.addEventListener("click", () => {
      menu.querySelectorAll(".sub-item").forEach((x) => {
        x.classList.remove("active");
        x.setAttribute("aria-checked", "false");
      });
      item.classList.add("active");
      item.setAttribute("aria-checked", "true");
      const lang = item.dataset.lang;
      if (window.I18N) I18N.setLang(lang);
      syncLangLabel(lang);
      setOpen(false);
      if (typeof toast === "function") toast(t("t.langChanged", {lang: t("lang." + lang)}));
    });
  });
})();
