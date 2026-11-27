// 画像の表示（右下のつまみで大きさ変更・クリックで小中大・ダブルクリックでビューワー）
// 本文の画像と表のセルの画像で共通に使う

export interface ImageViewOptions {
  name: string;
  src: string;
  width: string | null;
  /** 大きさを変えたとき（null は既定の大きさ） */
  onWidth?: (w: number | null) => void;
  /** ドラッグで広げられる最大の幅 */
  maxWidth(): number;
  /** クリックで出す大きさの候補 */
  sizes(): [string, number | null][];
  /** width が null のときの見た目の幅 */
  defaultCss: string;
  openImage(name: string): void;
}

export function createImageView(o: ImageViewOptions): HTMLElement {
  const frame = document.createElement("span");
  frame.className = "cm-image-frame";
  let menu: HTMLElement | null = null;
  const img = document.createElement("img");
  const onOutside = (e: MouseEvent) => {
    if (menu && !menu.contains(e.target as Node) && e.target !== img) closeMenu();
  };
  const closeMenu = () => {
    menu?.remove();
    menu = null;
    document.removeEventListener("mousedown", onOutside, true);
  };
  img.src = o.src;
  img.alt = o.name;
  img.draggable = false;
  img.title = "クリックで大きさを選ぶ／ダブルクリックで画像ビューワーで開く";
  frame.style.width = o.width ? `${o.width}px` : o.defaultCss;
  frame.append(img);
  img.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    o.openImage(o.name);
  });
  const onWidth = o.onWidth;
  if (!onWidth) return frame;

  // 右下のつまみでドラッグして大きさを変える
  const handle = document.createElement("span");
  handle.className = "cm-image-resize";
  handle.title = "ドラッグで大きさを変える";
  handle.addEventListener("mousedown", (e) => e.stopPropagation());
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = frame.getBoundingClientRect().width;
    const max = o.maxWidth();
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.min(max, Math.max(60, startW + ev.clientX - startX));
      frame.style.width = `${w}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      if (Math.abs(w - startW) < 2) return;
      onWidth(w >= max - 4 ? null : Math.round(w / 10) * 10);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  frame.append(handle);

  // クリックで 小・中・大
  img.addEventListener("mousedown", (e) => e.stopPropagation());
  img.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (menu) return closeMenu();
    const current = frame.getBoundingClientRect().width;
    menu = document.createElement("span");
    menu.className = "cm-image-menu";
    menu.addEventListener("mousedown", (ev) => ev.stopPropagation());
    for (const [label, w] of o.sizes()) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      const target = w ?? o.maxWidth();
      if (Math.abs(target - current) < 12) b.className = "on";
      b.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        closeMenu();
        onWidth(w);
      });
      menu.append(b);
    }
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "開く";
    open.title = "画像ビューワーで開く";
    open.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      closeMenu();
      o.openImage(o.name);
    });
    menu.append(open);
    frame.append(menu);
    document.addEventListener("mousedown", onOutside, true);
  });
  return frame;
}
