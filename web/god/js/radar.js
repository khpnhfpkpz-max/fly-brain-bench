/* NEURAL GOD — minimal position/heading minimap. Pure canvas 2D, no deps. */
export class Radar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }
  draw(x, z, headingRad, range = 6) {
    const { ctx, canvas } = this;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.width = Math.max(1, canvas.clientWidth * dpr);
    const h = canvas.height = Math.max(1, canvas.clientHeight * dpr);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 3 * dpr;
    ctx.strokeStyle = 'rgba(102,197,255,0.30)';
    ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();

    const px = cx + Math.max(-1, Math.min(1, x / range)) * r;
    const py = cy - Math.max(-1, Math.min(1, z / range)) * r;
    const s = 7 * dpr;
    ctx.fillStyle = '#66c5ff';
    ctx.beginPath();
    ctx.moveTo(px + Math.sin(headingRad) * s, py - Math.cos(headingRad) * s);
    ctx.lineTo(px + Math.sin(headingRad + 2.5) * s * 0.55, py - Math.cos(headingRad + 2.5) * s * 0.55);
    ctx.lineTo(px + Math.sin(headingRad - 2.5) * s * 0.55, py - Math.cos(headingRad - 2.5) * s * 0.55);
    ctx.closePath();
    ctx.fill();
  }
}
