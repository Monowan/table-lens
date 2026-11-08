/**
 * Інтерактивний редактор комірок на canvas.
 * - Клік по комірці → виділення (підсвітка рамки + кутів).
 * - Перетягування кутів виділеної комірки → редагування чотирикутника.
 * - Перетягування середини комірки → переміщення всієї комірки.
 * - Клавіша Delete/Backspace або кнопка → видалення виділеної комірки.
 *
 * Комірка має вигляд { row, col, x, y, w, h, quad? }.
 * Якщо quad немає — він створюється з x/y/w/h (прямокутник).
 */

class CellEditor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cells = [];        // посилання на state.cells
    this.selected = -1;     // індекс виділеної комірки в this.cells
    this.enabled = false;
    this.drawMode = false;  // режим ручного малювання нової комірки
    this.startPoint = null; // точка початку протягування при малюванні
    this.previewRect = null; // { x, y, w, h } прев'ю під час малювання
    this.drag = null;       // { kind: 'corner'|'move', corner: 0..3, startX, startY, origQuad }
    this.onChange = null;   // викликається після редагування (для ре-рендеру)
    this.onStructureChange = null; // викликається після додавання/видалення/переміщення

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    this.canvas.addEventListener("mousedown", this._onMouseDown);
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mouseup", this._onMouseUp);
    window.addEventListener("keydown", this._onKeyDown);
  }

  enable() { this.enabled = true; }
  disable() { this.enabled = false; this.selected = -1; this.drag = null; this.stopDrawMode(); }

  // Вмикає/вимикає режим ручного малювання комірок.
  setDrawMode(on) {
    this.drawMode = on;
    this.startPoint = null;
    this.previewRect = null;
    this.drag = null;
    if (on) {
      this.selected = -1;
      this.canvas.style.cursor = "crosshair";
    } else {
      this.canvas.style.cursor = "";
    }
  }

  stopDrawMode() { this.setDrawMode(false); }

  // Перераховує row/col за фактичним положенням і зберігає поточне виділення.
  _renumber() {
    if (!this.cells.length) return;
    // Запам'ятовуємо центр виділеної комірки, щоб повернути виділення після сортування.
    let selCenter = null;
    if (this.selected >= 0 && this.selected < this.cells.length) {
      const s = this.cells[this.selected];
      selCenter = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
    }

    const renum = assignRowCol(this.cells.map(c => ({
      x: c.x, y: c.y, w: c.w, h: c.h,
      quad: c.quad,
    })));
    this.cells.length = 0;
    for (const c of renum) this.cells.push(c);

    // Повертаємо виділення на комірку з найближчим центром.
    if (selCenter) {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < this.cells.length; i++) {
        const c = this.cells[i];
        const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
        const d = (cx - selCenter.x) ** 2 + (cy - selCenter.y) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      this.selected = best;
    } else {
      this.selected = -1;
    }

    if (this.onStructureChange) this.onStructureChange();
  }

  // Кутові точки комірки у порядку TL, TR, BR, BL.
  _quadOf(cell) {
    if (cell.quad && cell.quad.length === 4) return cell.quad.map(p => ({ ...p }));
    return [
      { x: cell.x, y: cell.y },
      { x: cell.x + cell.w, y: cell.y },
      { x: cell.x + cell.w, y: cell.y + cell.h },
      { x: cell.x, y: cell.y + cell.h },
    ];
  }

  _toCanvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  // Точка всередині чотирикутника (через перетин променя).
  _pointInQuad(px, py, quad) {
    let inside = false;
    for (let i = 0, j = quad.length - 1; i < quad.length; j = i++) {
      const xi = quad[i].x, yi = quad[i].y;
      const xj = quad[j].x, yj = quad[j].y;
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  _findCellAt(mx, my) {
    // Шукаємо зверху (останні намальовані) вниз.
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const quad = this._quadOf(this.cells[i]);
      if (this._pointInQuad(mx, my, quad)) return i;
    }
    return -1;
  }

  _findCornerAt(mx, my, quad) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const r = 8 * scaleX;
    for (let i = 0; i < 4; i++) {
      if (Math.abs(mx - quad[i].x) <= r && Math.abs(my - quad[i].y) <= r) return i;
    }
    return -1;
  }

  _onMouseDown(e) {
    if (!this.enabled || !this.cells.length && !this.drawMode) return;
    const { x: mx, y: my } = this._toCanvasCoords(e);

    // Режим малювання нової комірки.
    if (this.drawMode) {
      this.startPoint = { x: mx, y: my };
      this.previewRect = null;
      return;
    }

    // Якщо щось виділено — спершу перевіримо кути цієї комірки.
    if (this.selected >= 0 && this.selected < this.cells.length) {
      const sel = this.cells[this.selected];
      const q = this._quadOf(sel);
      const cIdx = this._findCornerAt(mx, my, q);
      if (cIdx >= 0) {
        this.drag = { kind: "corner", corner: cIdx, startX: mx, startY: my, orig: q };
        return;
      }
    }

    // Інакше — вибираємо комірку під курсором.
    const idx = this._findCellAt(mx, my);
    if (idx >= 0) {
      this.selected = idx;
      const q = this._quadOf(this.cells[idx]);
      const cIdx = this._findCornerAt(mx, my, q);
      if (cIdx >= 0) {
        this.drag = { kind: "corner", corner: cIdx, startX: mx, startY: my, orig: q };
      } else {
        this.drag = { kind: "move", startX: mx, startY: my, orig: q };
      }
      if (this.onChange) this.onChange();
    } else {
      this.selected = -1;
      this.drag = null;
      if (this.onChange) this.onChange();
    }
  }

  _onMouseMove(e) {
    // Прев'ю прямокутника під час малювання.
    if (this.drawMode && this.startPoint) {
      const { x: mx, y: my } = this._toCanvasCoords(e);
      const x = Math.min(this.startPoint.x, mx);
      const y = Math.min(this.startPoint.y, my);
      const w = Math.abs(mx - this.startPoint.x);
      const h = Math.abs(my - this.startPoint.y);
      this.previewRect = { x, y, w, h };
      if (this.onChange) this.onChange();
      return;
    }

    if (!this.drag) return;
    const { x: mx, y: my } = this._toCanvasCoords(e);
    const dx = mx - this.drag.startX;
    const dy = my - this.drag.startY;
    const cell = this.cells[this.selected];
    if (!cell) return;

    const q = this.drag.orig.map(p => ({ ...p }));
    if (this.drag.kind === "corner") {
      q[this.drag.corner] = { x: q[this.drag.corner].x + dx, y: q[this.drag.corner].y + dy };
    } else {
      for (const p of q) { p.x += dx; p.y += dy; }
    }

    // Зберігаємо quad та оновлюємо b-box.
    cell.quad = q;
    const xs = q.map(p => p.x), ys = q.map(p => p.y);
    cell.x = Math.min(...xs);
    cell.y = Math.min(...ys);
    cell.w = Math.max(...xs) - cell.x;
    cell.h = Math.max(...ys) - cell.y;

    if (this.onChange) this.onChange();
  }

  _onMouseUp(e) {
    // Завершуємо малювання: додаємо нову комірку.
    if (this.drawMode && this.startPoint) {
      const { x: mx, y: my } = this._toCanvasCoords(e);
      const x = Math.min(this.startPoint.x, mx);
      const y = Math.min(this.startPoint.y, my);
      const w = Math.abs(mx - this.startPoint.x);
      const h = Math.abs(my - this.startPoint.y);
      this.startPoint = null;
      this.previewRect = null;
      if (w >= 3 && h >= 3) {
        this.cells.push({ row: 0, col: 0, x, y, w, h });
        this.selected = this.cells.length - 1;
        this._renumber();
        if (this.onChange) this.onChange();
      }
      return;
    }

    // Після завершення переміщення комірки — перераховуємо її row/col.
    if (this.drag && this.drag.kind === "move") {
      this._renumber();
    }
    this.drag = null;
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    if ((e.key === "Delete" || e.key === "Backspace") && this.selected >= 0) {
      e.preventDefault();
      this.deleteSelected();
    }
  }

  deleteSelected() {
    if (this.selected < 0 || this.selected >= this.cells.length) return;
    this.cells.splice(this.selected, 1);
    this.selected = -1;
    this._renumber();
    if (this.onChange) this.onChange();
  }

  // Малює виділення та кути поверх вже намальованих комірок.
  draw() {
    if (!this.enabled) return;

    // Прев'ю прямокутника під час малювання.
    if (this.drawMode && this.previewRect) {
      const r = this.previewRect;
      const ctx = this.ctx;
      ctx.strokeStyle = "#0d6efd";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(13, 110, 253, 0.15)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      return;
    }

    if (this.selected < 0) return;
    const cell = this.cells[this.selected];
    if (!cell) return;
    const q = this._quadOf(cell);
    const ctx = this.ctx;

    // Яскрава рамка виділеної комірки.
    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // Ручки кутів.
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(q[i].x, q[i].y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#ff3b30";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}
