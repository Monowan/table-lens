/**
 * Інтерактивна рамка обрізки на canvas.
 * Рамка з 8 ручками (кути + середини ребер), яку можна тягати мишею.
 * Не виходить за межі зображення.
 */

class CropBox {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.box = { x: 0, y: 0, w: 0, h: 0 };
    this.drag = null; // { handle, startX, startY, orig }
    this.enabled = false;

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);

    this.canvas.addEventListener("mousedown", this._onMouseDown);
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mouseup", this._onMouseUp);
  }

  enable() { this.enabled = true; }
  disable() { this.enabled = false; }

  resetToFull() {
    this.box = { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
  }

  getBox() { return { ...this.box }; }

  _handles(b) {
    return [
      { n: "nw", x: b.x,           y: b.y },
      { n: "n",  x: b.x + b.w / 2, y: b.y },
      { n: "ne", x: b.x + b.w,     y: b.y },
      { n: "e",  x: b.x + b.w,     y: b.y + b.h / 2 },
      { n: "se", x: b.x + b.w,     y: b.y + b.h },
      { n: "s",  x: b.x + b.w / 2, y: b.y + b.h },
      { n: "sw", x: b.x,           y: b.y + b.h },
      { n: "w",  x: b.x,           y: b.y + b.h / 2 },
    ];
  }

  _findHandle(mx, my) {
    // Радіус захоплення масштабується відносно візуального розміру canvas,
    // щоб ручки було легко схопити навіть коли зображення зменшено.
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const r = 8 * scaleX;
    for (const h of this._handles(this.box)) {
      if (Math.abs(mx - h.x) <= r && Math.abs(my - h.y) <= r) return h;
    }
    return null;
  }

  _pointInBox(mx, my) {
    return mx >= this.box.x && mx <= this.box.x + this.box.w &&
           my >= this.box.y && my <= this.box.y + this.box.h;
  }

  _clamp(b) {
    const MIN = 8;
    if (b.w < MIN) b.w = MIN;
    if (b.h < MIN) b.h = MIN;
    if (b.x < 0) b.x = 0;
    if (b.y < 0) b.y = 0;
    if (b.x + b.w > this.canvas.width) b.x = this.canvas.width - b.w;
    if (b.y + b.h > this.canvas.height) b.y = this.canvas.height - b.h;
    if (b.w > this.canvas.width) { b.w = this.canvas.width; b.x = 0; }
    if (b.h > this.canvas.height) { b.h = this.canvas.height; b.y = 0; }
    return b;
  }

  _toCanvasCoords(e) {
    // Переводимо координати миші (CSS px) у внутрішні координати canvas.
    // Важливо: canvas може бути візуально зменшений через CSS
    // (max-width/max-height), тоді getBoundingClientRect() повертає
    // CSS-розмір, а box зберігається у внутрішніх пікселях canvas.
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    const { x: mx, y: my } = this._toCanvasCoords(e);
    const h = this._findHandle(mx, my);
    if (h) {
      this.drag = { handle: h.n, startX: mx, startY: my, orig: { ...this.box } };
    } else if (this._pointInBox(mx, my)) {
      this.drag = { handle: "move", startX: mx, startY: my, orig: { ...this.box } };
    }
  }

  _onMouseMove(e) {
    if (!this.drag) return;
    const { x: mx, y: my } = this._toCanvasCoords(e);
    const dx = mx - this.drag.startX;
    const dy = my - this.drag.startY;
    const o = this.drag.orig;
    let b = { ...o };
    switch (this.drag.handle) {
      case "move": b.x = o.x + dx; b.y = o.y + dy; break;
      case "nw": b.x = o.x + dx; b.y = o.y + dy; b.w = o.w - dx; b.h = o.h - dy; break;
      case "ne": b.y = o.y + dy; b.w = o.w + dx; b.h = o.h - dy; break;
      case "sw": b.x = o.x + dx; b.w = o.w - dx; b.h = o.h + dy; break;
      case "se": b.w = o.w + dx; b.h = o.h + dy; break;
      case "n":  b.y = o.y + dy; b.h = o.h - dy; break;
      case "s":  b.h = o.h + dy; break;
      case "e":  b.w = o.w + dx; break;
      case "w":  b.x = o.x + dx; b.w = o.w - dx; break;
    }
    if (b.w < 0) { b.x += b.w; b.w = -b.w; }
    if (b.h < 0) { b.y += b.h; b.h = -b.h; }
    this.box = this._clamp(b);
    if (this.onChange) this.onChange();
  }

  _onMouseUp() { this.drag = null; }

  drawOverlay() {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const b = this.box;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, this.canvas.width, b.y);
    ctx.fillRect(0, b.y + b.h, this.canvas.width, this.canvas.height - b.y - b.h);
    ctx.fillRect(0, b.y, b.x, b.h);
    ctx.fillRect(b.x + b.w, b.y, this.canvas.width - b.x - b.w, b.h);

    ctx.strokeStyle = "#0d6efd";
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#0d6efd";
    ctx.lineWidth = 1.5;
    for (const h of this._handles(b)) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
