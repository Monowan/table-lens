/**
 * Маски (схеми валідації) для результатів OCR.
 *
 * Маска — це набір правил формату для окремих комірок таблиці.
 * Правило для комірки (row,col) зберігається як регулярний вираз (рядок),
 * якому має відповідати значення комірки ПОВНІСТЮ (anchored: ^...$).
 *
 * Сумісно з GitHub Pages: маски зберігаються в localStorage браузера,
 * без жодного бекенду. Завантаження/вивантаження — через JSON-файл.
 *
 * Модель маски:
 *   {
 *     id: string (uuid),
 *     name: string,
 *     cells: { "r,c": "regexString" }  // напр. "2,0": "\\d{2}\\.\\d{2}\\.\\d{4}"
 *   }
 *
 * Комірки, для яких правило не задано, вважаються «будь-що» (без перевірки).
 */

const MaskManager = (() => {
  const STORAGE_KEY = "ocr-table-masks";
  const DEFAULT_OPTION = "__none__"; // «Без маски»
  const ADD_OPTION = "__add__";      // «➕ Додати маску…» (випадаючий пункт)

  let masks = [];          // завантажені маски (in-memory)
  let activeMaskId = null; // id активної маски або null (= без маски)

  // Стан редактора.
  const editor = {
    open: false,
    editingId: null,        // null = нова маска, інакше id редагованої
    selectedRange: null,    // { r1, c1, r2, c2 } нормалізований прямокутник вибраних комірок (або null)
    dragAnchor: null,       // { row, col } комірка-початок протягування діапазону
    dragging: false,
    workingCells: {},       // тимчасові правила під час редагування: { "r,c": regex }
    workingReplaces: {},    // тимчасові заміни під час редагування: { "r,c": [ [from,to], ... ] }
    // Зображення таблиці (dataURL) та комірки для відображення в редакторі.
    imageDataUrl: null,
    cells: [],              // [{ row, col, x, y, w, h, text }]
  };

  // ---------- Утиліти ----------
  function uid() {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Нормалізує діапазон так, щоб r1<=r2, c1<=c2.
  function normRange(a, b) {
    return {
      r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col),
      r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col),
    };
  }

  // Чи входить комірка (row,col) у діапазон.
  function inRange(range, row, col) {
    if (!range) return false;
    return row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2;
  }

  // Усі ключі "r,c" комірок у діапазоні.
  function rangeKeys(range) {
    const keys = [];
    if (!range) return keys;
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        keys.push(r + "," + c);
      }
    }
    return keys;
  }

  // Знаходить комірку в editor.cells під точкою (px,py). Повертає комірку або null.
  function findCellAt(px, py) {
    for (let i = editor.cells.length - 1; i >= 0; i--) {
      const c = editor.cells[i];
      if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
        return c;
      }
    }
    return null;
  }

  // Парсить текст замін з textarea у масив пар [ [from,to], ... ].
  // Формат: один запис на рядок, розділювач «=» (перший «=» розділяє).
  function parseReplaces(text) {
    const pairs = [];
    if (!text) return pairs;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const idx = line.indexOf("=");
      if (idx < 0) continue; // без розділювача — пропускаємо
      const from = line.slice(0, idx);
      const to = line.slice(idx + 1);
      if (from === "") continue; // порожній «що» — пропускаємо
      pairs.push([from, to]);
    }
    return pairs;
  }

  // Серіалізує масив пар замін у текст для textarea.
  function serializeReplaces(pairs) {
    if (!pairs || !pairs.length) return "";
    return pairs.map((p) => p[0] + "=" + p[1]).join("\n");
  }

  // Застосовує заміни до рядка тексту (послідовно, буквальна заміна всіх входжень).
  function applyReplacesToText(text, pairs) {
    if (!pairs || !pairs.length) return text;
    let out = text;
    for (const [from, to] of pairs) {
      out = out.split(from).join(to);
    }
    return out;
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          masks = arr.filter((m) => m && m.id && m.name && m.cells);
        }
      }
    } catch (e) {
      // Пошкоджений JSON — ігноруємо, лишаємо порожній список.
      masks = [];
    }
  }

  function saveToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(masks));
    } catch (e) {
      // localStorage може бути недоступний (приватний режим) — не критично.
    }
  }

  // ---------- Робота зі списком масок ----------
  function allMasks() {
    return masks.slice();
  }

  function getMask(id) {
    return masks.find((m) => m.id === id) || null;
  }

  function getActiveMask() {
    return activeMaskId ? getMask(activeMaskId) : null;
  }

  function setActiveMask(id) {
    activeMaskId = id || null;
    refreshSelect();
    // Сповіщаємо app.js про зміну активної маски (для перемалювання/перевірки).
    if (typeof window.__onMaskChange === "function") {
      window.__onMaskChange();
    }
  }

  function deleteMask(id) {
    masks = masks.filter((m) => m.id !== id);
    if (activeMaskId === id) activeMaskId = null;
    saveToStorage();
    refreshSelect();
    if (typeof window.__onMaskChange === "function") {
      window.__onMaskChange();
    }
  }

  function upsertMask(mask) {
    const idx = masks.findIndex((m) => m.id === mask.id);
    if (idx >= 0) masks[idx] = mask;
    else masks.push(mask);
    saveToStorage();
    refreshSelect();
  }

  // ---------- Дропдаун маски ----------
  function refreshSelect() {
    const sel = document.getElementById("maskSelect");
    if (!sel) return;
    sel.innerHTML = "";

    // «Без маски».
    const noneOpt = document.createElement("option");
    noneOpt.value = DEFAULT_OPTION;
    noneOpt.textContent = t("s3.noMask");
    sel.appendChild(noneOpt);

    // Завантажені маски.
    for (const m of masks) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      sel.appendChild(opt);
    }

    // Пункт «додати маску» (відкриває редактор).
    const addOpt = document.createElement("option");
    addOpt.value = ADD_OPTION;
    addOpt.textContent = t("s3.addMaskOpt");
    sel.appendChild(addOpt);

    // Вибираємо поточну.
    if (activeMaskId && masks.some((m) => m.id === activeMaskId)) {
      sel.value = activeMaskId;
    } else {
      sel.value = DEFAULT_OPTION;
    }

    updateMaskActionButtons();
  }

  function updateMaskActionButtons() {
    const isActive = activeMaskId && !!getMask(activeMaskId);
    document.getElementById("editMaskBtn").style.display = isActive ? "inline-block" : "none";
    document.getElementById("deleteMaskBtn").style.display = isActive ? "inline-block" : "none";
    const hint = document.getElementById("maskHint");
    if (isActive) {
      const m = getMask(activeMaskId);
      const n = Object.keys(m.cells || {}).length;
      hint.textContent = t("s3.maskActive", { name: m.name, n });
    } else {
      hint.textContent = t("s3.maskHint");
    }
  }

  // ---------- Валідація (використовує app.js) ----------
  // Застосовує заміни (маска.replaces) до текстів комірок і ПОВЕРТАЄ
  // новий масив результатів з виправленими значеннями (оригінал не чіпає).
  function applyReplaces(results) {
    const mask = getActiveMask();
    if (!mask || !mask.replaces) return results;
    return results.map((r) => {
      const pairs = mask.replaces[r.row + "," + r.col];
      if (!pairs || !pairs.length) return r;
      const newText = applyReplacesToText(r.text == null ? "" : r.text, pairs);
      if (newText === r.text) return r;
      // Порожнє/сміттєве значення зберігаємо як один пробіл —
      // так комірка лишається «порожньою», а не «невідповідною».
      const normalized = isBlankText(newText) ? " " : newText;
      return Object.assign({}, r, { text: normalized });
    });
  }

  // Повертає масив «проблемних» результатів: тих, що не відповідають масці.
  // results — масив [{ row, col, text, ... }].
  //
  // ВАЖЛИВО про порожні комірки:
  //   · порожня комірка / комірка з самих пробілів / «сміття» з крапок і маркерів
  //     НЕ вважається невідповідною масці — її просто заповнюємо пробілом;
  //   · розпізнане «сміття» ("...", "·", "•", "_", "|") теж нормалізується
  //     в пробіл, інакше одна пляма від лінії валила валідний рядок.
  function isBlankText(value) {
    if (value == null) return true;
    const s = String(value).trim();
    if (s === "") return true;
    // лише маркери/крапки/підкреслення/риски — це не дані, а артефакт OCR.
    return /^[.·•\-_|~\s]+$/.test(s);
  }

  function validateResults(results) {
    const mask = getActiveMask();
    if (!mask) return [];
    const problems = [];
    for (const r of results) {
      const rule = (mask.cells || {})[r.row + "," + r.col];
      if (!rule) continue; // немає правила → не перевіряємо
      // Порожню комірку не вважаємо помилкою формату (її заповнить користувач).
      if (isBlankText(r.text)) continue;
      const text = String(r.text).trim();
      let ok = false;
      try {
        // ПРАВИЛО ПЕРЕВІРЯЄ ЗНАЧЕННЯ ПОВНІСТЮ (anchored).
        // Без ^...$ вираз «\d{2}» пропустив би «1234» як валідне.
        // Якщо користувач сам написав ^...$ — не дублюємо якорі.
        ok = compileRule(rule).test(text);
      } catch (e) {
        ok = false; // некоректний regex — трактуємо як невідповідність
      }
      if (!ok) problems.push(r);
    }
    return problems;
  }

  // Компілює правило в RegExp з якорями ^...$, якщо їх ще немає.
  function compileRule(rule) {
    let src = String(rule == null ? "" : rule);
    if (!src) throw new Error("empty rule");
    const anchoredStart = src.startsWith("^");
    const anchoredEnd = src.endsWith("$") && !src.endsWith("\\$");
    if (!anchoredStart) src = "^" + src;
    if (!anchoredEnd) src = src + "$";
    return new RegExp(src);
  }

  // ---------- Побудова regex з чекбоксів ----------
  // Збирає рядок regex (без anchor) з вибраних класів символів.
  function regexFromCheckboxes() {
    const digit = document.getElementById("maskDigitChk").checked;
    const letter = document.getElementById("maskLetterChk").checked;
    const sign = document.getElementById("maskSignChk").checked;
    const any = document.getElementById("maskAnyChk").checked;

    if (any) return ".*"; // будь-що

    const classes = [];
    if (digit) classes.push("\\d");
    if (letter) classes.push("a-zA-Zа-яА-ЯіІїЇєЄґҐ");
    // Знаки: пробіли, підкреслення, крапки/коми, дефіс, слеш, плюс,
    // дужки, відсоток, номер, апостроф, лапки, двокрапка, крапка з комою,
    // зірочка, решітка — усе, що реально трапляється в таблицях.
    if (sign) classes.push("\\s_.,\\-/+()%№'\"`:;*#<>=«»“”„‹›!?@&$");
    if (!classes.length) return null; // нічого не вибрано

    return "[" + classes.join("") + "]+";
  }

  // ---------- Редактор маски ----------
  function openEditor(editingId) {
    editor.open = true;
    editor.editingId = editingId || null;
    editor.selectedRange = null;
    editor.dragAnchor = null;
    editor.dragging = false;
    editor.workingCells = {};
    editor.workingReplaces = {};

    const mask = editingId ? getMask(editingId) : null;

    // Назва.
    document.getElementById("maskNameInput").value = mask ? mask.name : "";

    // Копіюємо правила.
    if (mask && mask.cells) {
      editor.workingCells = Object.assign({}, mask.cells);
    }
    // Копіюємо заміни.
    if (mask && mask.replaces) {
      editor.workingReplaces = Object.assign({}, mask.replaces);
    }

    // Зображення таблиці (з поточного стану в app.js).
    editor.imageDataUrl = window.__maskSnapshotImage ? window.__maskSnapshotImage() : null;
    editor.cells = window.__maskSnapshotCells ? window.__maskSnapshotCells() : [];

    renderMaskCanvas();
    document.getElementById("maskSelectedCell").textContent = t("s3.noCellSelected");
    clearRulePanel();
    document.getElementById("maskModal").style.display = "flex";
  }

  function closeEditor() {
    editor.open = false;
    editor.editingId = null;
    editor.selectedRange = null;
    editor.dragAnchor = null;
    editor.dragging = false;
    editor.workingCells = {};
    editor.workingReplaces = {};
    editor.imageDataUrl = null;
    editor.cells = [];
    document.getElementById("maskModal").style.display = "none";
  }

  // Малює таблицю та вибрані комірки на canvas редактора.
  function renderMaskCanvas() {
    const canvas = document.getElementById("maskCanvas");
    if (!canvas) return;
    const placeholder = document.getElementById("maskPlaceholder");
    const ctx = canvas.getContext("2d");

    const wrap = canvas.parentElement;
    if (!editor.imageDataUrl) {
      placeholder.style.display = "flex";
      canvas.style.display = "none";
      if (wrap) wrap.classList.add("is-empty");
      return;
    }
    placeholder.style.display = "none";
    canvas.style.display = "block";
    if (wrap) wrap.classList.remove("is-empty");

    const img = new Image();
    img.onload = () => {
      // Полотно малюємо з запасом по вертикалі: підсвічування комірок може
      // виходити за межі зображення, а CSS масштабує його під ширину блоку.
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      // Тонка рамка, щоб права межа таблиці була видима навіть на білому фоні.
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = Math.max(1, Math.round(canvas.width / 880));
      ctx.strokeRect(0, 0, canvas.width - 1, canvas.height - 1);

      // Підсвічуємо вибрані комірки (діапазон) та комірки, для яких вже є правило.
      for (const c of editor.cells) {
        const key = c.row + "," + c.col;
        const hasRule = editor.workingCells[key];
        const selected = inRange(editor.selectedRange, c.row, c.col);
        ctx.beginPath();
        if (selected) {
          ctx.strokeStyle = "#0d6efd";
          ctx.lineWidth = 3;
        } else if (hasRule) {
          ctx.strokeStyle = "#2eb872";
          ctx.lineWidth = 2;
        } else {
          continue; // без правила і не вибрана — не малюємо
        }
        ctx.strokeRect(c.x, c.y, c.w, c.h);
      }
    };
    img.src = editor.imageDataUrl;
  }

  function clearRulePanel() {
    document.getElementById("maskDigitChk").checked = false;
    document.getElementById("maskLetterChk").checked = false;
    document.getElementById("maskSignChk").checked = false;
    document.getElementById("maskAnyChk").checked = false;
    document.getElementById("maskRegexInput").value = "";
    document.getElementById("maskRegexPreview").textContent = "";
    document.getElementById("maskReplaceInput").value = "";
  }

  // Заповнює панель правила для вибраного діапазону (за першою коміркою).
  function loadRulePanel(range) {
    // Скидаємо поля.
    document.getElementById("maskDigitChk").checked = false;
    document.getElementById("maskLetterChk").checked = false;
    document.getElementById("maskSignChk").checked = false;
    document.getElementById("maskAnyChk").checked = false;
    document.getElementById("maskRegexInput").value = "";
    document.getElementById("maskRegexPreview").textContent = "";
    document.getElementById("maskReplaceInput").value = "";

    if (!range) return; // немає вибору — порожні чекбокси
    const key = range.r1 + "," + range.c1;
    const rule = editor.workingCells[key];

    // Завантажуємо заміни (для першої комірки діапазону).
    const repl = editor.workingReplaces[key];
    if (repl) {
      document.getElementById("maskReplaceInput").value = serializeReplaces(repl);
    }

    if (!rule) return; // немає правила — порожні чекбокси

    // Якщо правило — «будь-що».
    if (rule === ".*") {
      document.getElementById("maskAnyChk").checked = true;
      return;
    }

    // Пробуємо розпізнати простий клас символів [ ... ]+ .
    const m = rule.match(/^\[([^\]]*)\]\+\s*$/);
    if (m) {
      const inner = m[1];
      if (inner.includes("\\d")) document.getElementById("maskDigitChk").checked = true;
      if (/a-zA-Zа-яА-Я/.test(inner)) document.getElementById("maskLetterChk").checked = true;
      if (/\\s|\.|,|-|\/|_|\(|\)|%|№/.test(inner)) document.getElementById("maskSignChk").checked = true;
      return;
    }

    // Інакше — показуємо як ручний regex.
    document.getElementById("maskRegexInput").value = rule;
    document.getElementById("maskRegexPreview").textContent = t("s3.regexManualPreview", { r: rule });
  }

  // Зберігає поточне правило (з панелі) для ВСІХ комірок вибраного діапазону.
  function saveRuleForSelection() {
    if (!editor.selectedRange) return;
    const regexInput = document.getElementById("maskRegexInput").value.trim();
    let regex;
    if (regexInput) {
      regex = regexInput;
    } else {
      regex = regexFromCheckboxes();
    }
    const keys = rangeKeys(editor.selectedRange);
    if (regex == null) {
      // Нічого не вибрано → видаляємо правило для всіх комірок діапазону.
      for (const k of keys) delete editor.workingCells[k];
    } else {
      for (const k of keys) editor.workingCells[k] = regex;
    }

    // Заміни: парсимо textarea і зберігаємо для всіх комірок діапазону.
    const pairs = parseReplaces(document.getElementById("maskReplaceInput").value);
    if (pairs.length) {
      for (const k of keys) editor.workingReplaces[k] = pairs;
    } else {
      for (const k of keys) delete editor.workingReplaces[k];
    }
  }

  // Вибирає прямокутний діапазон комірок і заповнює панель правила.
  function selectRange(range) {
    if (editor.selectedRange) saveRuleForSelection(); // зберегти попередню
    editor.selectedRange = range;
    updateSelectedLabel();
    loadRulePanel(range);
    renderMaskCanvas();
  }

  // Оновлює підпис вибраного діапазону.
  function updateSelectedLabel() {
    const range = editor.selectedRange;
    const el = document.getElementById("maskSelectedCell");
    if (!range) {
      el.textContent = t("s3.noCellSelected");
      return;
    }
    const colName = (c) => colLetter(c) + (c + 1);
    // colLetter визначена в app.js (глобально). Якщо немає — фолбек.
    const cellName = (r, c) => {
      if (typeof colLetter === "function") return colLetter(c) + (r + 1);
      return "(" + r + "," + c + ")";
    };
    const n = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    if (n === 1) {
      el.textContent = t("s3.selectedCell", { cell: cellName(range.r1, range.c1) });
    } else {
      el.textContent = t("s3.selectedRange", {
        a: cellName(range.r1, range.c1),
        b: cellName(range.r2, range.c2),
        n,
      });
    }
  }

  // ---------- Вибір комірок на canvas редактора (клік / протягування) ----------
  function canvasToImageCoords(e) {
    const canvas = document.getElementById("maskCanvas");
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function canvasMouseDown(e) {
    if (!editor.open) return;
    const { x: px, y: py } = canvasToImageCoords(e);
    const cell = findCellAt(px, py);
    if (!cell) {
      // Клік поза коміркою — знімаємо вибір (зберігши попереднє правило).
      if (editor.selectedRange) {
        saveRuleForSelection();
        editor.selectedRange = null;
        updateSelectedLabel();
        clearRulePanel();
        renderMaskCanvas();
      }
      return;
    }
    // Початок протягування діапазону.
    editor.dragAnchor = { row: cell.row, col: cell.col };
    editor.dragging = true;
    // Одразу показуємо вибір однієї комірки.
    selectRange(normRange(editor.dragAnchor, editor.dragAnchor));
  }

  function canvasMouseMove(e) {
    if (!editor.open || !editor.dragging || !editor.dragAnchor) return;
    const { x: px, y: py } = canvasToImageCoords(e);
    const cell = findCellAt(px, py);
    if (!cell) return;
    const range = normRange(editor.dragAnchor, { row: cell.row, col: cell.col });
    // Оновлюємо лише якщо діапазон змінився.
    if (!editor.selectedRange ||
        editor.selectedRange.r1 !== range.r1 || editor.selectedRange.c1 !== range.c1 ||
        editor.selectedRange.r2 !== range.r2 || editor.selectedRange.c2 !== range.c2) {
      editor.selectedRange = range;
      updateSelectedLabel();
      renderMaskCanvas();
    }
  }

  function canvasMouseUp() {
    if (!editor.open) return;
    if (editor.dragging) {
      editor.dragging = false;
      editor.dragAnchor = null;
      // Заповнюємо панель правила для фінального діапазону.
      loadRulePanel(editor.selectedRange);
    }
  }

  // ---------- Збереження / скасування / завантаження ----------
  function saveMask() {
    const name = document.getElementById("maskNameInput").value.trim();
    if (!name) {
      if (window.toast) window.toast(t("t.maskNeedName"));
      return;
    }
    // Зберегти правило поточно вибраного діапазону.
    if (editor.selectedRange) saveRuleForSelection();

    const mask = {
      id: editor.editingId || uid(),
      name,
      cells: editor.workingCells,
      replaces: editor.workingReplaces,
    };
    upsertMask(mask);
    setActiveMask(mask.id);
    closeEditor();
    if (window.toast) window.toast(t("t.maskSaved"));
  }

  function cancelMask() {
    closeEditor();
    // Повертаємо вибір у дропдауні до поточної активної маски.
    refreshSelect();
  }

  function downloadMask() {
    if (editor.selectedRange) saveRuleForSelection();
    const name = document.getElementById("maskNameInput").value.trim() || "mask";
    const mask = {
      id: editor.editingId || uid(),
      name: name || "mask",
      cells: editor.workingCells,
      replaces: editor.workingReplaces,
    };
    const blob = new Blob([JSON.stringify(mask, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[^\wа-яА-Яіїєґ\-]+/g, "_") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    if (window.toast) window.toast(t("t.maskExported"));
  }

  function loadMaskFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const mask = JSON.parse(reader.result);
        if (!mask || !mask.name || !mask.cells) {
          if (window.toast) window.toast(t("t.maskBadFile"));
          return;
        }
        mask.id = mask.id || uid();
        // Заповнюємо редактор завантаженим вмістом.
        editor.editingId = null;
        editor.workingCells = Object.assign({}, mask.cells);
        editor.workingReplaces = Object.assign({}, mask.replaces || {});
        document.getElementById("maskNameInput").value = mask.name;
        renderMaskCanvas();
        if (window.toast) window.toast(t("t.maskLoaded"));
      } catch (e) {
        if (window.toast) window.toast(t("t.maskReadError"));
      }
    };
    reader.readAsText(file);
  }

  // ---------- Ініціалізація DOM ----------
  function init() {
    loadFromStorage();
    refreshSelect();

    const sel = document.getElementById("maskSelect");
    sel.addEventListener("change", () => {
      if (sel.value === ADD_OPTION) {
        openEditor(null);
        sel.value = activeMaskId || DEFAULT_OPTION; // повертаємо попередній вибір
      } else if (sel.value === DEFAULT_OPTION) {
        setActiveMask(null);
      } else {
        setActiveMask(sel.value);
      }
    });

    document.getElementById("addMaskBtn").addEventListener("click", () => openEditor(null));
    document.getElementById("editMaskBtn").addEventListener("click", () => {
      if (activeMaskId) openEditor(activeMaskId);
    });
    document.getElementById("deleteMaskBtn").addEventListener("click", () => {
      if (activeMaskId) {
        const m = getMask(activeMaskId);
        if (window.confirm && confirm(`Видалити маску «${m.name}»?`)) {
          deleteMask(activeMaskId);
          if (window.toast) window.toast(t("t.maskDeleted"));
        }
      }
    });

    // Редактор.
    document.getElementById("maskModalClose").addEventListener("click", cancelMask);
    document.getElementById("maskCancelBtn").addEventListener("click", cancelMask);
    document.getElementById("maskSaveBtn").addEventListener("click", saveMask);
    document.getElementById("maskDownloadBtn").addEventListener("click", downloadMask);
    document.getElementById("maskLoadFileBtn").addEventListener("click", () => {
      document.getElementById("maskFileInput").click();
    });
    document.getElementById("maskFileInput").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) loadMaskFile(f);
      e.target.value = "";
    });
    document.getElementById("maskCanvas").addEventListener("mousedown", canvasMouseDown);
    window.addEventListener("mousemove", canvasMouseMove);
    window.addEventListener("mouseup", canvasMouseUp);

    // Живе оновлення попереднього перегляду regex.
    const updatePreview = () => {
      const regexInput = document.getElementById("maskRegexInput").value.trim();
      let preview;
      if (regexInput) {
        preview = t("s3.regexManualPreview", { r: regexInput });
      } else {
        const r = regexFromCheckboxes();
        preview = r == null ? t("s3.regexNone") : t("s3.regexAuto", { r });
      }
      document.getElementById("maskRegexPreview").textContent = preview;
    };
    ["maskDigitChk", "maskLetterChk", "maskSignChk", "maskAnyChk"].forEach((id) => {
      document.getElementById(id).addEventListener("change", () => {
        document.getElementById("maskRegexInput").value = "";
        updatePreview();
      });
    });
    document.getElementById("maskRegexInput").addEventListener("input", updatePreview);
  }

  // Перемальовка залежних від мови рядків при зміні мови.
  window.__maskI18nRefresh = function () {
    try {
      refreshSelect();
      updateMaskActionButtons();
      if (editor.open) {
        updateSelectedLabel();
        // Попередній перегляд regex теж локалізований — оновлюємо з поточних полів.
        const regexInput = document.getElementById("maskRegexInput").value.trim();
        let preview;
        if (regexInput) {
          preview = t("s3.regexManualPreview", { r: regexInput });
        } else {
          const r = regexFromCheckboxes();
          preview = r == null ? t("s3.regexNone") : t("s3.regexAuto", { r });
        }
        document.getElementById("maskRegexPreview").textContent = preview;
      }
    } catch (e) { /* тихо */ }
  };

  // Ініціалізуємо після завантаження DOM (викликається з app.js).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    allMasks,
    getMask,
    getActiveMask,
    setActiveMask,
    deleteMask,
    upsertMask,
    validateResults,
    isBlankText,
    applyReplaces,
    refreshSelect,
    isActive: () => !!activeMaskId,
  };
})();
