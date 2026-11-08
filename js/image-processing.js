/**
 * Обробка зображень: поворот, попередня обробка, детекція сітки.
 * Використовує OpenCV.js (глобальний об'єкт cv).
 */

// Поворот на довільний кут (градуси), з розширенням полотна.
function rotateImage(src, angle) {
  const rad = angle * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const nw = Math.round(src.cols * cos + src.rows * sin);
  const nh = Math.round(src.cols * sin + src.rows * cos);

  const M = cv.getRotationMatrix2D(
    new cv.Point(src.cols / 2, src.rows / 2), angle, 1.0
  );
  M.data[2] += (nw / 2) - (src.cols / 2);
  M.data[5] += (nh / 2) - (src.rows / 2);

  const dst = new cv.Mat();
  cv.warpAffine(src, dst, M, new cv.Size(nw, nh), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  M.delete();
  return dst;
}

// Поворот на 90° (times: 1 = вправо, -1 = вліво).
function rotate90(src, times) {
  const code = times > 0 ? cv.ROTATE_90_CLOCKWISE : cv.ROTATE_90_COUNTERCLOCKWISE;
  const dst = new cv.Mat();
  cv.rotate(src, dst, code);
  return dst;
}

// Попередня обробка: перспектива, дескев (вирівнювання нахилу),
// нормалізація освітлення.
function preprocessImage(src, doDeskew, doPersp, doLight, lightLevel) {
  let out = src.clone();

  if (doPersp) {
    const persp = correctPerspective(out);
    if (persp) { out.delete(); out = persp; }
  }

  if (doDeskew) {
    const deskewed = deskew(out);
    if (deskewed) { out.delete(); out = deskewed; }
  }

  if (doLight) {
    // Нормалізація освітлення зі збереженням відтінків сірого.
    // Вирівнюємо контраст (equalizeHist) і плавно змішуємо з оригіналом:
    // lightLevel керує силою ефекту (0 = оригінал, 100 = повна корекція).
    const gray = new cv.Mat();
    cv.cvtColor(out, gray, cv.COLOR_RGBA2GRAY);
    const equalized = new cv.Mat();
    cv.equalizeHist(gray, equalized);

    // Змішуємо (blend) оригінал і вирівняне зображення по-піксельно.
    const t = Math.max(0, Math.min(1, lightLevel / 100));
    const a = gray.data;
    const b = equalized.data;
    for (let i = 0; i < a.length; i++) {
      a[i] = Math.round(a[i] * (1 - t) + b[i] * t);
    }
    cv.cvtColor(gray, out, cv.COLOR_GRAY2RGBA);
    gray.delete(); equalized.delete();
  }

  return out;
}

// Корекція перспективи: шукає найбільший чотирикутний контур (контур таблиці)
// і випрямляє його до прямокутника. Повертає нову матрицю або null, якщо контур не знайдено.
function correctPerspective(src) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  const binary = new cv.Mat();
  cv.threshold(blur, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let best = null, bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
    if (approx.rows === 4 && area > bestArea) {
      bestArea = area;
      if (best) best.delete();
      best = approx.clone();
    }
    approx.delete();
  }

  contours.delete(); hierarchy.delete(); gray.delete(); blur.delete(); binary.delete();

  if (!best) return null;

  // Впорядковуємо кути: TL, TR, BR, BL.
  const pts = [];
  for (let i = 0; i < 4; i++) {
    pts.push({ x: best.data32S[i * 2], y: best.data32S[i * 2 + 1] });
  }
  best.delete();

  const sum = pts.map(p => p.x + p.y);
  const diff = pts.map(p => p.x - p.y);
  const TL = pts[sum.indexOf(Math.min(...sum))];
  const BR = pts[sum.indexOf(Math.max(...sum))];
  const TR = pts[diff.indexOf(Math.max(...diff))];
  const BL = pts[diff.indexOf(Math.min(...diff))];

  const wTop = Math.hypot(TR.x - TL.x, TR.y - TL.y);
  const wBot = Math.hypot(BR.x - BL.x, BR.y - BL.y);
  const hLef = Math.hypot(BL.x - TL.x, BL.y - TL.y);
  const hRig = Math.hypot(BR.x - TR.x, BR.y - TR.y);
  const outW = Math.max(1, Math.round(Math.max(wTop, wBot)));
  const outH = Math.max(1, Math.round(Math.max(hLef, hRig)));

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    TL.x, TL.y, TR.x, TR.y, BR.x, BR.y, BL.x, BL.y
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, outW - 1, 0, outW - 1, outH - 1, 0, outH - 1
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(outW, outH));
  srcTri.delete(); dstTri.delete(); M.delete();
  return dst;
}

// Ручне вирівнювання перспективи за 4 точками [TL, TR, BR, BL].
// Розтягує чотирикутник у прямокутник розміру, що визначається сторонами.
function warpPerspectiveFromPoints(src, pts) {
  if (!pts || pts.length !== 4) return null;
  const [TL, TR, BR, BL] = pts;

  const wTop = Math.hypot(TR.x - TL.x, TR.y - TL.y);
  const wBot = Math.hypot(BR.x - BL.x, BR.y - BL.y);
  const hLef = Math.hypot(BL.x - TL.x, BL.y - TL.y);
  const hRig = Math.hypot(BR.x - TR.x, BR.y - TR.y);
  const outW = Math.max(1, Math.round(Math.max(wTop, wBot)));
  const outH = Math.max(1, Math.round(Math.max(hLef, hRig)));

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    TL.x, TL.y, TR.x, TR.y, BR.x, BR.y, BL.x, BL.y
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, outW - 1, 0, outW - 1, outH - 1, 0, outH - 1
  ]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(outW, outH));
  srcTri.delete(); dstTri.delete(); M.delete();
  return dst;
}

// Вирівнювання нахилу (deskew): знаходить кут повороту через мінімальний
// обернений прямокутник і повертає зображення. Повертає нову матрицю або null.
function deskew(src) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const binary = new cv.Mat();
  cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

  const coords = new cv.Mat();
  cv.findNonZero(binary, coords);
  if (!coords || coords.rows < 10) {
    gray.delete(); binary.delete(); if (coords) coords.delete();
    return null;
  }
  const rect = cv.minAreaRect(coords);
  let angle = rect.angle;
  // Нормалізуємо кут до [-45, 45].
  if (angle < -45) angle += 90;
  if (Math.abs(angle) < 0.1) {
    gray.delete(); binary.delete(); coords.delete();
    return null;
  }

  const h = src.rows, w = src.cols;
  const M = cv.getRotationMatrix2D(new cv.Point(w / 2, h / 2), angle, 1.0);
  const dst = new cv.Mat();
  cv.warpAffine(src, dst, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);

  gray.delete(); binary.delete(); coords.delete(); M.delete();
  return dst;
}

// Детекція ліній таблиці (повертає { rowLines: [], colLines: [] }).
// opts: { threshold (0..1), kernel (ділник для розміру ядра), merge (0..2) }.
function detectTableGrid(src, opts) {
  opts = opts || {};
  const thresholdFrac = opts.threshold != null ? opts.threshold : 0.3;
  const kernelDiv = opts.kernel != null ? opts.kernel : 30;
  const mergeFrac = opts.merge != null ? opts.merge : 0.5;

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // Бінаризація (Otsu): чорні лінії на білому -> білі лінії на чорному.
  const binary = new cv.Mat();
  cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

  const h = src.rows, w = src.cols;
  const hkSize = Math.max(1, Math.floor(w / kernelDiv));
  const vkSize = Math.max(1, Math.floor(h / kernelDiv));
  const hk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(hkSize, 1));
  const vk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, vkSize));

  const horizontal = new cv.Mat();
  const vertical = new cv.Mat();
  cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, hk, new cv.Point(-1, -1), 2);
  cv.morphologyEx(binary, vertical, cv.MORPH_OPEN, vk, new cv.Point(-1, -1), 2);

  const rowLines = linePositions(horizontal, true, w, h, thresholdFrac, mergeFrac);
  const colLines = linePositions(vertical, false, h, w, thresholdFrac, mergeFrac);

  gray.delete(); binary.delete(); hk.delete(); vk.delete();
  horizontal.delete(); vertical.delete();

  return { rowLines, colLines };
}

// Проєкція ліній: axisHorizontal=true -> рядки (y), false -> стовпці (x).
// projectionLen — довжина, вздовж якої сумуємо (для порогу),
// axisLen — довжина осі, вздовж якої розташовані позиції (для злиття).
// thresholdFrac — частка projectionLen для порогу наявності лінії.
// mergeFrac — множник для порогу злиття близьких ліній.
function linePositions(mask, axisHorizontal, projectionLen, axisLen, thresholdFrac, mergeFrac) {
  const positions = [];
  const rows = mask.rows, cols = mask.cols;
  const threshold = projectionLen * thresholdFrac;
  const data = mask.data; // Uint8Array, індекс = y * cols + x

  if (axisHorizontal) {
    // сума по стовпцях (по рядках) -> y-координати рядків
    let inLine = false, start = 0;
    for (let y = 0; y < rows; y++) {
      let sum = 0;
      const base = y * cols;
      for (let x = 0; x < cols; x++) {
        sum += data[base + x] > 0 ? 1 : 0;
      }
      if (sum > threshold && !inLine) { inLine = true; start = y; }
      else if (sum <= threshold && inLine) { inLine = false; positions.push((start + y) >> 1); }
    }
    if (inLine) positions.push((start + rows - 1) >> 1);
  } else {
    // сума по рядках (по стовпцях) -> x-координати стовпців
    let inLine = false, start = 0;
    for (let x = 0; x < cols; x++) {
      let sum = 0;
      for (let y = 0; y < rows; y++) {
        sum += data[y * cols + x] > 0 ? 1 : 0;
      }
      if (sum > threshold && !inLine) { inLine = true; start = x; }
      else if (sum <= threshold && inLine) { inLine = false; positions.push((start + x) >> 1); }
    }
    if (inLine) positions.push((start + cols - 1) >> 1);
  }
  return mergeCloseLines(positions, axisLen, mergeFrac);
}

function mergeCloseLines(positions, axisLen, mergeFrac) {
  if (positions.length < 2) return positions;

  // Адаптивний поріг злиття: типова відстань між лініями (медіана),
  // помножена на mergeFrac. Лінії, ближчі за цей поріг, — дублікати
  // (товсті лінії, подвійні піки), їх зливаємо.
  const gaps = [];
  for (let i = 1; i < positions.length; i++) {
    gaps.push(positions[i] - positions[i - 1]);
  }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  // Захист: поріг не може бути ані завеликим, ані замалим.
  const minGap = Math.max(2, Math.min(medianGap * mergeFrac, axisLen * 0.2));

  const merged = [];
  let group = [positions[0]];
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] - group[group.length - 1] < minGap) {
      group.push(positions[i]);
    } else {
      merged.push(Math.round(group.reduce((a, b) => a + b, 0) / group.length));
      group = [positions[i]];
    }
  }
  merged.push(Math.round(group.reduce((a, b) => a + b, 0) / group.length));
  return merged;
}

// Побудувати комірки з ліній сітки: [{ row, col, x, y, w, h }].
function cellsFromGrid(rowLines, colLines, w, h) {
  const xs = [0, ...colLines.slice().sort((a, b) => a - b), w];
  const ys = [0, ...rowLines.slice().sort((a, b) => a - b), h];
  const cells = [];
  for (let r = 0; r < ys.length - 1; r++) {
    for (let c = 0; c < xs.length - 1; c++) {
      const x0 = xs[c], x1 = xs[c + 1];
      const y0 = ys[r], y1 = ys[r + 1];
      cells.push({ row: r, col: c, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return cells;
}

// Адаптивна сітка на основі вузлів (перетинів ліній).
// Для кожного перетину рядкової та стовпцевої лінії локально шукаємо реальний
// «кут» у маленькому вікні. Це гарантує, що кожна комірка має рівно 4 кути,
// а сусідні комірки ділять спільні вершини (контур замкнений, без розривів).
// Повертає nodes[r][c] = { x, y } (r — індекс рядка, c — індекс стовпця).
function detectAdaptiveGridNodes(src, rowLines, colLines) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const binary = new cv.Mat();
  cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
  const data = binary.data;
  const w = src.cols, h = src.rows;

  const ys = rowLines.slice().sort((a, b) => a - b);
  const xs = colLines.slice().sort((a, b) => a - b);
  const R = ys.length, C = xs.length;

  const SEARCH = 15;   // радіус локального пошуку вузла (px)
  const PATCH = 4;     // половина розміру «плями» для оцінки сили кута

  // Знайти локальний максимум «чорнила» у вікні навколо (gx, gy).
  // Повертає уточнену позицію перетину. Якщо нічого не знайдено — gx, gy.
  function findNode(gx, gy) {
    const xLo = Math.max(PATCH, gx - SEARCH);
    const xHi = Math.min(w - 1 - PATCH, gx + SEARCH);
    const yLo = Math.max(PATCH, gy - SEARCH);
    const yHi = Math.min(h - 1 - PATCH, gy + SEARCH);
    let bestX = gx, bestY = gy, bestSum = -1;
    for (let yy = yLo; yy <= yHi; yy++) {
      for (let xx = xLo; xx <= xHi; xx++) {
        // Сума білих пікселів у плямі (2*PATCH+1)² навколо (xx, yy).
        let sum = 0;
        for (let dy = -PATCH; dy <= PATCH; dy++) {
          const base = (yy + dy) * w;
          for (let dx = -PATCH; dx <= PATCH; dx++) {
            if (data[base + (xx + dx)] > 0) sum++;
          }
        }
        if (sum > bestSum) { bestSum = sum; bestX = xx; bestY = yy; }
      }
    }
    return { x: bestX, y: bestY };
  }

  const nodes = [];
  for (let r = 0; r < R; r++) {
    nodes[r] = [];
    for (let c = 0; c < C; c++) {
      nodes[r][c] = findNode(xs[c], ys[r]);
    }
  }

  gray.delete(); binary.delete();
  return nodes;
}

// Уточнення меж комірок через flood-fill внутрішнього білого поля.
// Замість того, щоб покладатись на самі лінії, заповнюємо білий простір
// усередині кожної комірки від її центру до ліній-контурів. Це дає точний
// bounding box, що реально «впирається» в контури, навіть якщо лінії
// викривлені, товсті чи трохи розірвані.
// cells — масив {row, col, x, y, w, h} з грубої сітки; повертає той самий
// масив з уточненими x/y/w/h (row/col зберігаються).
function refineCellsByFill(src, cells) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  // Біле = фон/комірки, чорне = лінії/текст.
  const binary = new cv.Mat();
  cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  // Морфологічне закриття: «заліплює» дрібний текст усередині комірок,
  // лишаючи довгі лінії. Це дозволяє flood-fill пройти через текст.
  const closed = new cv.Mat();
  const ksize = 5;
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ksize, ksize));
  cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
  const data = closed.data;
  const w = src.cols, h = src.rows;

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);

  const result = [];
  for (const cell of cells) {
    const cx = Math.round(cell.x + cell.w / 2);
    const cy = Math.round(cell.y + cell.h / 2);
    if (cx < 0 || cx >= w || cy < 0 || cy >= h) { result.push(cell); continue; }
    const start = cy * w + cx;
    if (data[start] === 0) { result.push(cell); continue; } // центр на лінії — пропускаємо

    let head = 0, tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % w, y = (idx / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !visited[idx - 1] && data[idx - 1] > 0) { visited[idx - 1] = 1; queue[tail++] = idx - 1; }
      if (x < w - 1 && !visited[idx + 1] && data[idx + 1] > 0) { visited[idx + 1] = 1; queue[tail++] = idx + 1; }
      if (y > 0 && !visited[idx - w] && data[idx - w] > 0) { visited[idx - w] = 1; queue[tail++] = idx - w; }
      if (y < h - 1 && !visited[idx + w] && data[idx + w] > 0) { visited[idx + w] = 1; queue[tail++] = idx + w; }
    }

    result.push({
      row: cell.row, col: cell.col,
      x: minX, y: minY,
      w: maxX - minX + 1, h: maxY - minY + 1,
    });
  }

  gray.delete(); binary.delete(); closed.delete(); kernel.delete();
  return result;
}

// Детекція комірок за замкненими чорними контурами (для кривих таблиць).
// Знаходить усі білі області, оточені чорними лініями (connected components),
// і відбирає ті, що можуть бути комірками за площею.
// opts: { minArea (0..1 частка від загальної площі), maxArea (0..1), closeK (ядро закриття) }
// Повертає [{ x, y, w, h }] (без row/col — їх призначимо окремо).
function detectCellsByContours(src, opts) {
  opts = opts || {};
  const minAreaFrac = opts.minArea != null ? opts.minArea : 0.001;
  const maxAreaFrac = opts.maxArea != null ? opts.maxArea : 0.5;
  // Ядро закриття: 1 — нейтральне (без морфології).
  // Ширини >1 у звичайних таблицях швидко «заліплюють» кілька комірок в одну.
  const closeKX = opts.closeKX != null ? opts.closeKX : 1;
  const closeKY = opts.closeKY != null ? opts.closeKY : 1;
  const blockSize = opts.blockSize != null ? opts.blockSize : 35;
  const cOffset = opts.cOffset != null ? opts.cOffset : 15;

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  // Розмиття для зменшення шуму перед адаптивним порогом.
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  // АДАПТИВНА бінаризація: локально розділяє кожну ділянку на чорне/біле.
  // На відміну від глобальної Otsu, працює рівномірно навіть при нерівномірному
  // освітленні/тінях, тому всі комірки виділяються однаково по всьому зображенні.
  // Світле -> біле (255), темне -> чорне (0).
  const binary = new cv.Mat();
  cv.adaptiveThreshold(
    blur, binary, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY,
    blockSize, cOffset
  );

  // Морфологічне закриття: «заліплює» дрібний текст усередині комірок,
  // щоб внутрішність кожної комірки була суцільною білою областю.
  // Асиметричне ядро дає окремий контроль по горизонталі та вертикалі.
  const closed = new cv.Mat();
  if (closeKX > 1 || closeKY > 1) {
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(closeKX, closeKY));
    cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
    kernel.delete();
  } else {
    // Ядро 1×1 — закриття нічого не змінює: копіюємо, щоб не витрачати CPU.
    binary.copyTo(closed);
  }

  const w = src.cols, h = src.rows;
  const totalArea = w * h;
  const minArea = totalArea * minAreaFrac;
  const maxArea = totalArea * maxAreaFrac;

  // Знаходимо контури білих областей (комірок). Кожна замкнена біла область
  // (оточенна чорними лініями) = окремий зовнішній контур.
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const boxes = [];
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    // Фільтр за площею.
    if (area < minArea || area > maxArea) continue;

    // b-box (axis-aligned) — для row/col та сумісності.
    const br = cv.boundingRect(cnt);
    const box = { x: br.x, y: br.y, w: br.width, h: br.height };

    // Чесно знаходимо 4 кути комірки по її РЕАЛЬНОМУ контуру: апроксимуємо
    // контур до чотирикутника, поступово збільшуючи поріг (epsilon), поки не
    // лишиться рівно 4 вершини. Це дає кути, що слідують за лініями таблиці
    // (навіть нахиленими/зігнутими), без діагональних «хрестів» від minAreaRect.
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    let quad = null;
    for (let e = 0.01; e <= 0.10; e += 0.01) {
      cv.approxPolyDP(cnt, approx, e * peri, true);
      if (approx.rows === 4) {
        const pts = [];
        for (let k = 0; k < 4; k++) {
          pts.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
        }
        quad = orderQuad(pts);
        break;
      }
      if (approx.rows < 4) break; // занадто сильно спростили
    }
    approx.delete();
    if (quad) box.quad = quad;

    boxes.push(box);
  }

  contours.delete(); hierarchy.delete();
  gray.delete(); blur.delete(); binary.delete(); closed.delete();
  return boxes;
}

// Впорядковує 4 точки чотирикутника в порядок TL, TR, BR, BL (по периметру).
// Найнадійніший спосіб — сортування за ПОЛЯРНИМ КУТОМ відносно центроїда.
// Це дає коректний обхід контуру без самоперетину («метелика»), який виникає
// при евристиках типу x+y / x-y на нахилених/кривих чотирикутниках.
function orderQuad(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const ordered = pts.slice().sort((a, b) => {
    const angA = Math.atan2(a.y - cy, a.x - cx);
    const angB = Math.atan2(b.y - cy, b.x - cx);
    return angA - angB;
  });
  // Тепер точки йдуть по периметру (проти годинникової стрілки, починаючи
  // від найменшого кута). Знаходимо TL як точку з найменшою сумою x+y,
  // і обертаємо масив так, щоб він починався з TL.
  let tlIdx = 0;
  let minSum = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = ordered[i].x + ordered[i].y;
    if (s < minSum) { minSum = s; tlIdx = i; }
  }
  return [ordered[tlIdx], ordered[(tlIdx + 1) % 4], ordered[(tlIdx + 2) % 4], ordered[(tlIdx + 3) % 4]];
}

// Призначає row/col прямокутникам комірок за їхніми координатами.
// Рядки й стовпці визначаються через 1D-кластеризацію ЦЕНТРІВ за «розривами»:
// це робастно до нахилу/викривлення таблиці (на відміну від групування за
// перекриттям, яке фрагментує нахилені ряди).
function assignRowCol(boxes) {
  if (!boxes.length) return [];

  // Вираховуємо центр кожної комірки (центр bbox — простий і стабільний).
  const cells = boxes.map(b => ({
    ...b,
    cx: b.x + b.w / 2,
    cy: b.y + b.h / 2,
  }));

  const mh = medianHeight(cells);
  const mw = medianWidth(cells);

  // Стовпці: кластеризація центрів по X (cx стабільні, тому це надійно).
  const colIdx = cluster1D(cells.map(c => c.cx), mw, 0.5);
  const nCols = new Set(colIdx).size;

  // Рядки: кластеризація по Y. Якщо таблиця регулярна (кожен рядок має рівно
  // nCols комірок), використовуємо групування по N — це надійно розділяє щільні
  // верхні рядки, які мають менший міжрядковий проміжок, ніж решта таблиці.
  const rowIdx = assignRowsByCount(cells, nCols);

  const result = cells.map((c, i) => {
    const cell = { row: rowIdx[i], col: colIdx[i], x: c.x, y: c.y, w: c.w, h: c.h };
    if (c.quad) cell.quad = c.quad;
    return cell;
  });

  // Впорядковуємо row/col за фактичним положенням (щоб індекси йшли згори вниз,
  // зліва направо), а не за порядком виявлення.
  const rowOrder = Array.from(new Set(rowIdx)).sort((a, b) => {
    const ay = cells.filter((_, i) => rowIdx[i] === a).reduce((s, c) => s + c.cy, 0) /
      cells.filter((_, i) => rowIdx[i] === a).length;
    const by = cells.filter((_, i) => rowIdx[i] === b).reduce((s, c) => s + c.cy, 0) /
      cells.filter((_, i) => rowIdx[i] === b).length;
    return ay - by;
  });
  const colOrder = Array.from(new Set(colIdx)).sort((a, b) => {
    const ax = cells.filter((_, i) => colIdx[i] === a).reduce((s, c) => s + c.cx, 0) /
      cells.filter((_, i) => colIdx[i] === a).length;
    const bx = cells.filter((_, i) => colIdx[i] === b).reduce((s, c) => s + c.cx, 0) /
      cells.filter((_, i) => colIdx[i] === b).length;
    return ax - bx;
  });

  const rowMap = new Map(rowOrder.map((v, i) => [v, i]));
  const colMap = new Map(colOrder.map((v, i) => [v, i]));
  result.forEach(c => { c.row = rowMap.get(c.row); c.col = colMap.get(c.col); });

  return result;
}

// Розбиває комірки на рядки за кількістю стовпців: сортуємо за Y-центром і
// групуємо по nCols комірок. Працює для регулярних таблиць, де кожен рядок має
// однакову кількість комірок. Якщо комірок не ділиться націло на nCols (злиті
// комірки, викиди), повертаємось до звичайної 1D-кластеризації.
function assignRowsByCount(cells, nCols) {
  if (!nCols || nCols < 1) {
    const mh = medianHeight(cells);
    return cluster1D(cells.map(c => c.cy), mh, 0.5);
  }
  const n = cells.length;
  const rem = n % nCols;

  // Якщо ділиться рівно — чисте групування по N. Інакше — фолбек.
  if (rem === 0) {
    const order = cells.map((c, i) => ({ cy: c.cy, i })).sort((a, b) => a.cy - b.cy);
    const labels = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      labels[order[k].i] = Math.floor(k / nCols);
    }
    return labels;
  }

  // Фолбек: кластеризація по Y.
  const mh = medianHeight(cells);
  return cluster1D(cells.map(c => c.cy), mh, 0.5);
}

// Геометричний центр комірки. Якщо є quad (4 кути) — середнє арифметичне кутів
// (точніше для нахилених комірок), інакше — центр bbox.
function centerOfCell(cell) {
  if (cell.quad && cell.quad.length === 4) {
    const xs = cell.quad.map(p => p.x);
    const ys = cell.quad.map(p => p.y);
    return {
      cx: (xs[0] + xs[1] + xs[2] + xs[3]) / 4,
      cy: (ys[0] + ys[1] + ys[2] + ys[3]) / 4,
    };
  }
  return { cx: cell.x + cell.w / 2, cy: cell.y + cell.h / 2 };
}

// Медіанна висота комірок (для оцінки типового розміру рядка).
function medianHeight(cells) {
  const hs = cells.map(c => c.h).sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)] || 1;
}

function medianWidth(cells) {
  const ws = cells.map(c => c.w).sort((a, b) => a - b);
  return ws[Math.floor(ws.length / 2)] || 1;
}

// 1D-кластеризація значень (центрів) на рядки/стовпці.
// Стійка до викидів: крок між кластерами рахується як МЕДІАНА «великих» різниць
// (міжрядкових проміжків), а не від сусідніх значень, тому 1-2 аномальні комірки
// не ламають усю структуру.
function cluster1D(values, cellSize, tolFactor) {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const labels = new Array(values.length).fill(0);
  if (order.length <= 1) return labels;

  // «Міжрядкові/міжстовпчикові» проміжки = різниці, більші за дрібний
  // внутрішній розкид (він зазвичай менший за чверть типового розміру комірки).
  const bigGaps = [];
  for (let k = 1; k < order.length; k++) {
    const g = order[k].v - order[k - 1].v;
    if (g > cellSize * 0.25) bigGaps.push(g);
  }

  // Крок між рядками/стовпцями = медіана «великих» проміжків.
  let step;
  if (bigGaps.length) {
    bigGaps.sort((a, b) => a - b);
    step = bigGaps[Math.floor(bigGaps.length / 2)];
  } else {
    step = cellSize;
  }

  // Поріг розділення = частка від кроку. tolFactor регулює толерантність до
  // нахилу: більший для рядків (0.7), менший для стовпців (0.5).
  const threshold = step * (tolFactor != null ? tolFactor : 0.55);

  let cluster = 0;
  let prev = order[0].v;
  labels[order[0].i] = 0;
  for (let k = 1; k < order.length; k++) {
    const o = order[k];
    if (o.v - prev > threshold) cluster++;
    labels[o.i] = cluster;
    prev = o.v;
  }
  return labels;
}
