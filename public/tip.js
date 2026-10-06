// Bordered tooltip for hover devices: replaces the native title bubble (unstyleable) with a framed one.
if (matchMedia('(hover: hover)').matches) {
  let box = null, cur = null, timer = 0;
  const hide = () => {
    clearTimeout(timer); timer = 0;
    if (box) box.style.display = 'none';
    if (cur && cur.dataset.tip != null) { cur.title = cur.dataset.tip; delete cur.dataset.tip; }
    cur = null;
  };
  const show = (el) => {
    if (!box) { box = document.createElement('div'); box.className = 'tipbox'; document.body.appendChild(box); }
    box.textContent = el.dataset.tip;
    box.style.display = 'block';
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    let x = r.left + r.width / 2 - b.width / 2;
    x = Math.max(6, Math.min(innerWidth - b.width - 6, x));
    let y = r.bottom + 8;
    if (y + b.height > innerHeight - 6) y = r.top - b.height - 8;
    box.style.left = `${x}px`; box.style.top = `${Math.max(6, y)}px`;
  };
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[title]');
    if (el === cur) return;
    hide();
    if (!el || !el.title) return;
    cur = el; el.dataset.tip = el.title; el.removeAttribute('title');
    timer = setTimeout(() => show(el), 450);
  });
  for (const t of ['mousedown', 'scroll', 'keydown']) document.addEventListener(t, hide, true);
  document.addEventListener('mouseout', (e) => { if (cur && !cur.contains(e.relatedTarget)) hide(); });
}
