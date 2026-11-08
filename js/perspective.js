/**
 * Ручний інструмент вирівнювання перспективи.
 * Користувач клікає по 4 кутах таблиці (TL → TR → BR → BL),
 * точки з'єднуються у чотирикутник, за яким вирівнюється перспектива.
 */

class PerspectivePicker {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.points = []; // до 4 точок у внутрішніх координатах canvas
    this.enabled = false;
    this.onComplete = null; // викликається з масивом 4 точок [TL, TR, BR, BL]

    this._onMouseDown = this._onMouseDown.bind(this);
    this.canvas.addEventListener("mousedown", this._onMouseDown);
  }

  enable() {
    this.enabled = true;
    this.points = [];
    this.canvas.style.cursor = "crosshair";
  }

  disable() {
    this.enabled = false;
    this.points = [];
    this.canvas.style.cursor = "";
  }

  clear() { this.points = []; }

  isActive() { return this.enabled; }

  getPoints() { return this.points.slice(); }

  // Переводимо CSS-координати миші у внутрішні координати canvas.
  _toCanvasCoords(e) {
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
    if (this.points.length >= 4) return;
    const { x, y } = this._toCanvasCoords(e);
    this.points.push({ x, y });
    this.draw();
    if (this.points.length === 4 && this.onComplete) {
      // Впорядковуємо точки як [TL, TR, BR, BL] і передаємо.
      this.onComplete(this._orderPoints(this.points));
    }
  }

  // Впорядковує 4 точки за кутами: TL, TR, BR, BL.
  _orderPoints(pts) {
    const sum = pts.map(p => p.x + p.y);
    const diff = pts.map(p => p.x - p.y);
    const TL = pts[sum.indexOf(Math.min(...sum))];
    const BR = pts[sum.indexOf(Math.max(...sum))];
    const TR = pts[diff.indexOf(Math.max(...diff))];
    const BL = pts[diff.indexOf(Math.min(...diff))];
    return [TL, TR, BR, BL];
  }

  draw() {
    if (!this.enabled) return;
    const ctx = this.ctx;
    if (!this.points.length) return;

    // Лінії між послідовними точками + замикання, коли всі 4 є.
    const pts = this.points;
    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    if (pts.length === 4) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // Маркери точок.
    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#ff3b30";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
      // Порядковий номер.
      ctx.fillStyle = "#fff";
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), pts[i].x, pts[i].y - 14);
    }
  }
}
