// Bordered tooltip for hover devices: replaces the native title bubble (unstyleable) with a framed one.
// It sits to the right of the pointer, level with the element, so it never covers the rows below.
if (matchMedia('(hover: hover)').matches) {
  let box = null, cur = null, timer = 0, mx = 0, my = 0, off = false;
  const hideBox = () => { clearTimeout(timer); timer = 0; if (box) box.style.display = 'none'; };
  const release = () => {            // give the native title back only once the pointer has left, or the native bubble would pop up too
    hideBox();
    if (cur && cur.isConnected && cur.dataset.tip != null) { cur.title = cur.dataset.tip; delete cur.dataset.tip; }
    cur = null; off = false;
  };
  const show = (el) => {
    if (!box) { box = document.createElement('div'); box.className = 'tipbox'; document.body.appendChild(box); }
    box.textContent = el.dataset.tip;
    box.style.display = 'block';
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    let x = mx + 16;
    if (x + b.width > innerWidth - 6) x = Math.max(6, mx - b.width - 16);
    const y = Math.max(6, Math.min(innerHeight - b.height - 6, r.top + r.height / 2 - b.height / 2));
    box.style.left = `${x}px`; box.style.top = `${y}px`;
  };
  document.addEventListener('mouseover', (e) => {
    mx = e.clientX; my = e.clientY;
    const el = e.target.closest?.('[title], [data-tip]');
    if (el === cur) return;
    release();
    if (!el || !el.title) return;
    cur = el; el.dataset.tip = el.title; el.removeAttribute('title');
    timer = setTimeout(() => { if (!off) show(el); }, 450);
  });
  document.addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; });
  document.addEventListener('mouseout', (e) => { if (cur && !cur.contains(e.relatedTarget)) release(); });
  for (const t of ['mousedown', 'keydown']) document.addEventListener(t, () => { off = true; hideBox(); }, true);
  document.addEventListener('scroll', () => { off = true; hideBox(); }, true);
}
