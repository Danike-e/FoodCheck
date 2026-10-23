/**
 * Page numbers to show in the pager: always the first and last page, plus the
 * current page and its neighbours. Gaps are null (shown as "…"), but a gap of
 * a single page is filled in, since "…" would take the same space.
 *
 *   pageWindow(5, 27) -> [1, null, 4, 5, 6, null, 27]
 *   pageWindow(3, 27) -> [1, 2, 3, 4, null, 27]
 */
export function pageWindow(current, total) {
  const wanted = new Set([1, total, current - 1, current, current + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = [];
  pages.forEach((p, i) => {
    const gap = i > 0 ? p - pages[i - 1] : 1;
    if (gap === 2) out.push(p - 1);
    else if (gap > 2) out.push(null);
    out.push(p);
  });
  return out;
}
