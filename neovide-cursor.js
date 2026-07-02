// --- Configurations ---
const cursorColor = "#C8D3F5"; // cursor color
const cursorUpdatePollingRate = 500; // dom detecting time (ms)
const useShadow = true; // cursor shadow
const shadowColor = cursorColor; // cursor shadow color
const shadowBlur = 20; // shadow blur radius

// 光标停留在字符上时把本体 alpha 降到这个值，让下方字符和真实光标透出来。
// 飞行中保持 1.0 以保留视觉冲击；判定"停留"以 spring 动画收敛为准。
const stationaryBodyAlpha = 0;
// 停留态本体 alpha 从 1 匀速淡到 stationaryBodyAlpha 所需的总时间（秒）。
// 用线性淡出而非指数衰减，避免尾巴拖长；数值越小打字/定位体感越干脆。
const bodyAlphaFadeDuration = 0.04;

const ANIMATION_SETTINGS = {
  animationLength: 0.1, // animation time length (when cursor jumping)
  trailSize: 1, // animation trail density (0-1)
};

// 光标离目标的距离超过这个像素数即视为"飞行中"，允许穿越其他窗格；小于等于
// 时视为已到位，启用 clip 防止阴影从边缘溢出到邻居窗格。取大于 shadowBlur
// 是为了在阴影半径够小时不误判为飞行。
const CLIP_DISTANCE_THRESHOLD = 30;

// Monaco 的 .cursor 节点在刚插入 DOM、编辑器聚焦切换、tab 切换等瞬间会
// 短暂给出 (0,0,0,0) 或坐标位于视口原点的 rect（此时 Monaco 还没跑完布局）。
// 若把这类值当作真实位置缓存到 lastX/lastY，或当作动画目的地传给 move()，
// 光标就会从画布左上角飞出。所有对 .cursor rect 的读取都要先过这个检查。
// 编辑器内部的光标最少也在行号槽之后，rect.left/top 不可能真正落在 (0,0)。
function isValidCursorRect(rect) {
  if (!rect) return false;
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.left === 0 && rect.top === 0) return false;
  return true;
}

// -----------------------

const STANDARD_CORNERS = [
  { x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 },
  { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }
];

const helperCanvas = document.createElement("canvas");
const helperCtx = helperCanvas.getContext("2d");

function resolveColor(color) {
  // 用 Canvas 像素读取方式解析任意 CSS 颜色格式（hex/rgb/rgba/命名颜色），
  // 避免 CSS 变量值或 computedStyle 为非 hex 时 fallback 到白色。
  helperCtx.clearRect(0, 0, 1, 1);
  helperCtx.fillStyle = color;
  helperCtx.fillRect(0, 0, 1, 1);
  const pixel = helperCtx.getImageData(0, 0, 1, 1).data;
  helperCtx.clearRect(0, 0, 1, 1);
  return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3] };
}

function rgbaToCss({ r, g, b, a }) {
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function length(vec) {
  return Math.hypot(vec.x, vec.y);
}

function normalize(vec) {
  const len = length(vec);
  if (!len) return { x: 0, y: 0 };
  return { x: vec.x / len, y: vec.y / len };
}

class DampedSpringAnimation {
  constructor() {
    this.position = 0;
    this.velocity = 0;
  }
  update(dt, animationLength) {
    if (animationLength <= dt || this.position === 0) {
      this.reset();
      return false;
    }
    const omega = 4.0 / animationLength;
    const a = this.position;
    const b = this.position * omega + this.velocity;
    const c = Math.exp(-omega * dt);
    this.position = (a + b * dt) * c;
    this.velocity = c * (-a * omega - b * dt * omega + b);

    if (Math.abs(this.position) < 0.01) {
      this.reset();
      return false;
    }
    return true;
  }
  reset() {
    this.position = 0;
    this.velocity = 0;
  }
}

class Corner {
  constructor(relativePosition) {
    this.relativePosition = relativePosition;
    this.currentPosition = { x: 0, y: 0 };
    this.previousDestination = { x: -1000, y: -1000 };
    this.animationX = new DampedSpringAnimation();
    this.animationY = new DampedSpringAnimation();
    this.animationLength = ANIMATION_SETTINGS.animationLength;
    // getDestination / update 共用：避免每帧/每次移动都分配新 {x,y} 对象。
    this._dest = { x: 0, y: 0 };
  }

  getDestination(center, cursorDimensions) {
    this._dest.x = center.x + this.relativePosition.x * cursorDimensions.width;
    this._dest.y = center.y + this.relativePosition.y * cursorDimensions.height;
    return this._dest;
  }

  calculateDirectionAlignment(cursorDimensions, destination) {
    const relativeScaled = {
      x: this.relativePosition.x * cursorDimensions.width,
      y: this.relativePosition.y * cursorDimensions.height
    };
    const cornerDestination = {
      x: destination.x + relativeScaled.x,
      y: destination.y + relativeScaled.y
    };
    const travelDirection = normalize({
      x: cornerDestination.x - this.currentPosition.x,
      y: cornerDestination.y - this.currentPosition.y
    });
    const cornerDirection = normalize(this.relativePosition);
    return travelDirection.x * cornerDirection.x + travelDirection.y * cornerDirection.y;
  }

  jump(cursorDimensions, rank) {
    const leading = ANIMATION_SETTINGS.animationLength * clamp(1 - ANIMATION_SETTINGS.trailSize, 0, 1);
    const trailing = ANIMATION_SETTINGS.animationLength;
    if (rank >= 2) {
      this.animationLength = leading;
    } else if (rank === 1) {
      this.animationLength = (leading + trailing) / 2;
    } else {
      this.animationLength = trailing;
    }
    this.animationX.reset();
    this.animationY.reset();
  }

  update(cursorDimensions, destination, dt, immediate) {
    const cornerDestination = this.getDestination(destination, cursorDimensions);

    if (cornerDestination.x !== this.previousDestination.x || cornerDestination.y !== this.previousDestination.y) {
      // 瞬移时 delta 赋值完立刻被 reset() 归零，跳过省掉无用计算。
      if (!immediate) {
        const delta = {
          x: cornerDestination.x - this.currentPosition.x,
          y: cornerDestination.y - this.currentPosition.y
        };
        this.animationX.position = delta.x;
        this.animationY.position = delta.y;
      }
      this.previousDestination.x = cornerDestination.x;
      this.previousDestination.y = cornerDestination.y;
    }

    if (immediate) {
      this.currentPosition.x = cornerDestination.x;
      this.currentPosition.y = cornerDestination.y;
      this.animationX.reset();
      this.animationY.reset();
      return false;
    }

    const animX = this.animationX.update(dt, this.animationLength);
    const animY = this.animationY.update(dt, this.animationLength);

    this.currentPosition.x = cornerDestination.x - this.animationX.position;
    this.currentPosition.y = cornerDestination.y - this.animationY.position;
    return animX || animY;
  }
}

function computeCornerRanks(corners, cursorDimensions, destination) {
  const aligned = corners
    .map((corner, index) => ({
      index,
      value: corner.calculateDirectionAlignment(cursorDimensions, destination)
    }))
    .sort((a, b) => {
      if (a.value === b.value) return a.index - b.index;
      return a.value - b.value;
    });
  const ranks = Array(corners.length).fill(0);
  aligned.forEach((item, rank) => ranks[item.index] = rank);
  return ranks;
}

function createNeovideCursor(options) {
  const canvas = options?.canvas;
  const context = canvas.getContext("2d");
  let particlesColor = options?.color || cursorColor;

  if (particlesColor === "default") {
    const color = getComputedStyle(document.querySelector("body>.monaco-workbench"))
      .getPropertyValue("--vscode-editorCursor-background").trim();
    particlesColor = color || "#ffffffff";
  }

  const colorObj = resolveColor(particlesColor);
  const shadowColorObj = resolveColor(shadowColor);
  // 预算颜色的 CSS 字符串——drawCursorShape 每帧要用，避免重复拼接和 GC。
  const colorCss = rgbaToCss(colorObj);
  const transparentCss = "rgba(0, 0, 0, 0)";
  const opaqueBlackCss = "rgba(0, 0, 0, 1)";
  // shadowCss 依赖 shadowAlphaFactor，setShadowAlphaFactor 变化时重算。
  let shadowCss = rgbaToCss(shadowColorObj);
  let cursorDimensions = { width: 8, height: 18 };
  let destination = { x: 0, y: 0 };
  let centerDestination = { x: 0, y: 0 };
  let lastTimestamp = performance.now();
  let initialized = false;
  let jumped = false;
  // 独立于 globalAlpha 的阴影强度系数：dying 光标越靠近吸附目标时，两个光标
  // 的阴影会强烈重叠形成大面积光晕，需要按距离单独把阴影压下来。
  let shadowAlphaFactor = 1;
  // 当前平滑逼近后的本体 alpha。目标值由 updateLoopLogic 每帧根据 animating
  // 计算，实际渲染值走指数衰减，避免"停下瞬间"的硬跳变。初始 1 保证首次
  // 飞入时不透明。
  let currentBodyAlpha = 1;

  // 离屏 shadow sprite：把静态矩形光标的 shadow 预渲染成位图，停留态直接
  // drawImage 代替实时 shadowBlur。飞行态因为四角形变，走原始 fill+blur 路径。
  // sprite 尺寸与 cursorDimensions 绑定，尺寸变化时重建。dying 光标每帧变化
  // 的 shadowAlphaFactor 靠 drawImage 时的 globalAlpha 处理（高斯模糊是线性
  // 算子，等价于对 sprite 整体缩放 alpha）。
  let shadowSprite = null;
  let shadowSpriteInset = 0;  // sprite 内部矩形距 sprite 边缘的空白（CSS 像素，等于 shadowBlur*2）
  let shadowSpriteCssWidth = 0;
  let shadowSpriteCssHeight = 0;

  const corners = STANDARD_CORNERS.map(rel => new Corner(rel));

  function rebuildShadowSprite() {
    if (!useShadow) { shadowSprite = null; return; }
    const w = cursorDimensions.width;
    const h = cursorDimensions.height;
    if (w <= 0 || h <= 0) { shadowSprite = null; return; }
    // 留出 blur 半径 × 2 的边距，保证软阴影不被裁掉。
    const pad = shadowBlur * 2;
    const cssW = w + pad * 2;
    const cssH = h + pad * 2;
    // sprite 内部按 devicePixelRatio 扩容，保证在 Retina/高 DPI 屏上光晕不
    // 模糊。setTransform 让后续 fillRect 继续用 CSS 坐标；drawImage 时通过
    // 9-arg 明确目标 CSS 尺寸，不然默认会按物理像素当 CSS 尺寸画，位置对但
    // 内部像素密度只有 1x。
    const dpr = window.devicePixelRatio || 1;
    const sprite = document.createElement("canvas");
    sprite.width = Math.ceil(cssW * dpr);
    sprite.height = Math.ceil(cssH * dpr);
    const sctx = sprite.getContext("2d");
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 在 sprite 中心画矩形，触发 shadow，再用 destination-out 擦掉本体，只留光晕。
    sctx.shadowColor = rgbaToCss(shadowColorObj);
    sctx.shadowBlur = shadowBlur;
    sctx.fillStyle = colorCss;
    sctx.fillRect(pad, pad, w, h);
    sctx.shadowColor = transparentCss;
    sctx.shadowBlur = 0;
    sctx.globalCompositeOperation = "destination-out";
    sctx.fillStyle = opaqueBlackCss;
    sctx.fillRect(pad, pad, w, h);
    shadowSprite = sprite;
    shadowSpriteInset = pad;
    shadowSpriteCssWidth = cssW;
    shadowSpriteCssHeight = cssH;
  }

  function updateCursorSize(width, height) {
    if (width) cursorDimensions.width = width;
    if (height) cursorDimensions.height = height;
    // 宽高变化后必须同步刷新 centerDestination：half-width↔full-width 切换时
    // Monaco 会改变光标 rect.width（8↔16），若 centerDestination 仍沿用旧宽度
    // 推得的中心点，四个角就会算到"以旧中心 + 新宽度"的位置上，视觉上光标
    // 覆盖会整体偏离字符格。
    centerDestination.x = destination.x + cursorDimensions.width / 2;
    centerDestination.y = destination.y + cursorDimensions.height / 2;
    rebuildShadowSprite();
  }

  function move(x, y) {
    destination.x = x;
    destination.y = y;
    centerDestination.x = destination.x + cursorDimensions.width / 2;
    centerDestination.y = destination.y + cursorDimensions.height / 2;
    jumped = true;

    if (!initialized) {
      corners.forEach(corner => {
        const cornerDest = corner.getDestination(centerDestination, cursorDimensions);
        corner.currentPosition.x = cornerDest.x;
        corner.currentPosition.y = cornerDest.y;
        corner.previousDestination.x = cornerDest.x;
        corner.previousDestination.y = cornerDest.y;
      });
      initialized = true;
    }
  }

  function drawCursorShape(bodyAlpha = 1, useSprite = false) {
    if (!initialized) return;

    // Pass 1 — 阴影：停留态用离屏 sprite，飞行态用实时 fill+blur。
    if (useSprite && shadowSprite && useShadow && shadowAlphaFactor > 0) {
      context.save();
      context.globalAlpha = context.globalAlpha * shadowAlphaFactor;
      context.drawImage(
        shadowSprite,
        0, 0, shadowSprite.width, shadowSprite.height,
        corners[0].currentPosition.x - shadowSpriteInset,
        corners[0].currentPosition.y - shadowSpriteInset,
        shadowSpriteCssWidth, shadowSpriteCssHeight
      );
      context.restore();
    }

    // 飞行态阴影或本体需要绘制时，构建一次四边形路径供两者共用。
    // Canvas fill() 不消费路径，可多次 fill。停留态 bodyAlpha=0 时跳过。
    const needPath = (!useSprite && useShadow && shadowAlphaFactor > 0) || bodyAlpha > 0;
    if (needPath) {
      context.beginPath();
      context.moveTo(corners[0].currentPosition.x, corners[0].currentPosition.y);
      for (let i = 1; i < corners.length; i++) {
        context.lineTo(corners[i].currentPosition.x, corners[i].currentPosition.y);
      }
      context.closePath();
    }

    if (!useSprite && useShadow && shadowAlphaFactor > 0) {
      context.save();
      context.shadowColor = shadowCss;
      context.shadowBlur = shadowBlur;
      context.fillStyle = colorCss;
      context.fill();
      context.restore();

      // destination-out 擦掉本体只留阴影
      context.save();
      context.globalCompositeOperation = "destination-out";
      context.shadowColor = transparentCss;
      context.shadowBlur = 0;
      context.fillStyle = opaqueBlackCss;
      context.fill();
      context.restore();
    }

    // Pass 2 — 本体
    if (bodyAlpha > 0) {
      context.save();
      context.globalAlpha = context.globalAlpha * bodyAlpha;
      context.shadowColor = transparentCss;
      context.shadowBlur = 0;
      context.fillStyle = colorCss;
      context.fill();
      context.restore();
    }
  }

  function setShadowAlphaFactor(factor) {
    const next = clamp(factor, 0, 1);
    if (next === shadowAlphaFactor) return;
    shadowAlphaFactor = next;
    // 只在因子真的变化时重算 shadow CSS，避免每帧字符串拼接。
    shadowCss = rgbaToCss({
      r: shadowColorObj.r,
      g: shadowColorObj.g,
      b: shadowColorObj.b,
      a: shadowColorObj.a * shadowAlphaFactor
    });
  }

  // 返回当前几何中心到最新目标（centerDestination）的距离。dying 光标用它
  // 判断"离主光标还有多远"，从而快速拉低光晕 alpha。
  function getDistanceToDestination() {
    if (!initialized) return 0;
    let cx = 0, cy = 0;
    for (const corner of corners) {
      cx += corner.currentPosition.x;
      cy += corner.currentPosition.y;
    }
    cx /= corners.length;
    cy /= corners.length;
    return Math.hypot(centerDestination.x - cx, centerDestination.y - cy);
  }

  function setPosition(x, y) {
    destination.x = x;
    destination.y = y;
    centerDestination.x = destination.x + cursorDimensions.width / 2;
    centerDestination.y = destination.y + cursorDimensions.height / 2;

    corners.forEach(corner => {
      const dest = corner.getDestination(centerDestination, cursorDimensions);
      corner.currentPosition.x = dest.x;
      corner.currentPosition.y = dest.y;
      corner.previousDestination.x = dest.x;
      corner.previousDestination.y = dest.y;
      corner.animationX.reset();
      corner.animationY.reset();
    });

    initialized = true;
    jumped = false;
  }

  function updateLoopLogic(isScrolling, shouldDraw) {
    if (!initialized) return false;
    const now = performance.now();
    const dt = Math.min((now - lastTimestamp) / 1000, 1 / 30);
    lastTimestamp = now;

    const immediateMovement = isScrolling;

    if (jumped) {
      // 滚动瞬移时 corner.update(immediate=true) 会覆盖 jump() 的全部效果，
      // 跳过角排名和弹簧重置省掉每帧 4 次 calculateDirectionAlignment。
      if (!immediateMovement) {
        const ranks = computeCornerRanks(corners, cursorDimensions, centerDestination);
        corners.forEach((corner, index) => {
          corner.jump(cursorDimensions, ranks[index]);
        });
      }
      // 新动画启动的瞬间硬切到不透明，避免从"停留态透明"渐入 1 时，飞行途中
      // 拖尾本体几乎看不见（只剩 shadow 拖尾）。停下时才走指数淡出。
      currentBodyAlpha = 1;
    }

    let animating = false;
    corners.forEach(corner => {
      if (corner.update(cursorDimensions, centerDestination, dt, immediateMovement)) {
        animating = true;
      }
    });

    // 停下后 body alpha 线性淡到 stationaryBodyAlpha，起步即最快速度、到点
    // 即停。飞行中始终不透明——jumped 分支已把 currentBodyAlpha 硬回到 1，
    // spring 恢复期 animating 保持 true，不会误淡出。淡出未收敛时也算
    // animating，驱动 loop 继续跑帧。
    if (!animating && currentBodyAlpha > stationaryBodyAlpha) {
      const step = bodyAlphaFadeDuration > 0 ? dt / bodyAlphaFadeDuration : 1;
      currentBodyAlpha = Math.max(stationaryBodyAlpha, currentBodyAlpha - step);
      if (currentBodyAlpha > stationaryBodyAlpha) animating = true;
    }

    if (shouldDraw) {
      // dying 光标在到达吸附目标前 animating 恒为 true，本体一直是 1，外层
      // globalAlpha 负责时间淡出；此处不干扰它。
      // useSprite = !animating：spring 收敛后 corners 就在原始矩形四角，可
      // 以走离屏 sprite 快速路径；飞行中 corners 形变，必须走实时 fill+blur。
      drawCursorShape(currentBodyAlpha, !animating);
    }

    jumped = false;
    return animating;
  }

  return { move, updateCursorSize, setPosition, updateLoopLogic, setShadowAlphaFactor, getDistanceToDestination };
}

class GlobalCursorManager {
  constructor() {
    this.cursors = new Map(); // Map<CursorId, NeovideCursorInstance>
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.isScrolling = false;
    this.scrollTimeout = null;
    // 单调递增的创建序号，用于在同一窗格里定位"最近一次创建的光标"。不能靠
    // Map 的插入序，因为 scanCursors 是按 DOM 文档顺序遍历，新增的光标若位于
    // 文档更靠前的位置，会被排到已有光标前面，与真实创建顺序不符。
    this.creationCounter = 0;
    // 已排队的 rAF 句柄。null 表示当前没有 pending 帧——外部事件通过
    // requestFrame() 唤醒 loop；loop() 结束时若还有 animating 光标，也会
    // 自己 requestFrame() 续下一帧。空闲态整个 rAF 队列静默，CPU 降到 ~0。
    this._rafId = null;
    // Monaco 使用 CSS transform 程序化滚动不触发 scroll 事件，loop 空闲后
    // 由此定时器自唤醒，确保光标位置与 DOM 保持同步。
    this._idleCheckId = null;
    // 本帧 editor rect 缓存：runWithEditorClip 首次访问时 populate，同帧内
    // 所有光标复用，避免 N·M 次 querySelectorAll + getBoundingClientRect。
    // loop() 开头置为 null；每帧结束自然回收。
    this._frameEditorRects = null;
    // updateCursor 每帧要判断 target 所在窗格是否 focused，原来靠
    // getComputedStyle。改为 focusout/focusin 事件维护 focusedEditor，
    // updateCursor 只做引用比较。
    this._focusedEditor = document.querySelector(".monaco-editor.focused");
    this.init();
  }

  init() {
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.position = "fixed";
    this.canvas.style.top = "0px";
    this.canvas.style.left = "0px";
    this.canvas.style.zIndex = "9999";
    this.canvas.style.width = "100vw";
    this.canvas.style.height = "100vh";
    document.body.appendChild(this.canvas);

    window.addEventListener("resize", () => {
      this.updateCanvasSize();
      // 窗口尺寸变化通常伴随布局重排，光标绝对坐标会变。
      for (const data of this.cursors.values()) data.dirty = true;
      this.requestFrame();
    });
    this.updateCanvasSize();

    document.addEventListener('scroll', () => {
      this.isScrolling = true;
      clearTimeout(this.scrollTimeout);
      this.scrollTimeout = setTimeout(() => {
        this.isScrolling = false;
      }, 100);
      // 滚动会移动光标的屏幕坐标但不改 .cursor 的 style（transform 是编辑器
      // 内容层做的），style observer 捕捉不到——必须显式标脏。
      for (const data of this.cursors.values()) data.dirty = true;
      this.requestFrame();
    }, { capture: true, passive: true });

    this.requestFrame();

    setInterval(() => {
      this.scanCursors();
      // 光标的 dirty 标记和 requestFrame 已由 33ms 空闲轮询覆盖，
      // 这里只做 DOM 发现（新增/移除 .cursor 节点的兜底扫描）。
    }, cursorUpdatePollingRate);

    // 通过 MutationObserver 立即响应 .cursor 节点的增删，消除 Ctrl+D 等操作
    // 到动画启动之间的轮询延迟。轮询保留作为兜底，避免观察范围之外遗漏。
    this.pendingScan = false;
    const observer = new MutationObserver((mutations) => {
      if (this.pendingScan) return;
      for (const m of mutations) {
        if (this.mutationHasCursor(m.addedNodes) || this.mutationHasCursor(m.removedNodes)) {
          this.pendingScan = true;
          requestAnimationFrame(() => {
            this.pendingScan = false;
            this.scanCursors();
            // scanCursors 里注册新光标会调 requestFrame；这里补一次确保
            // 光标销毁触发 dying 时也能立刻续帧。
            this.requestFrame();
          });
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 记录上一个活跃窗格里最近使用过的光标位置。当焦点切到别的 .monaco-editor
    // 时（例如 Ctrl+1/2/3），把新窗格里所有已存在的光标从这个位置"飞"到当前
    // 位置，产生跨窗格切换的动画。
    this.lastActiveEditor = null;
    this.lastActiveCursorPos = null;
    document.addEventListener("focusin", (e) => {
      this._focusedEditor = e.target?.closest?.(".monaco-editor") || null;
      this.handleFocusChange(e.target);
      // 焦点切换可能让新聚焦窗格里之前"未 focused 被跳过"的光标需要重新绘制，
      // 位置也可能在被跳过的期间已经变了——标脏保险。
      for (const data of this.cursors.values()) data.dirty = true;
      this.requestFrame();
    }, true);
    document.addEventListener("focusout", () => {
      // focusout 早于 focusin，先清空；随后的 focusin 会补上正确值。若
      // focusout 后没有 focusin（焦点飘到 window 之外），保持 null。
      this._focusedEditor = null;
      this.requestFrame();
    }, true);
  }

  // 唯一的 rAF 入口。已有 pending 帧时直接返回，避免同一帧被 schedule 多次。
  // loop() 内部若发现还有动画未收敛，也会调这里续下一帧。
  requestFrame() {
    if (this._rafId != null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this.loop();
    });
  }

  handleFocusChange(target) {
    if (!target || !target.closest) return;
    const editor = target.closest(".monaco-editor");
    if (!editor) return;
    if (editor === this.lastActiveEditor) return;

    // 收集新窗格里的所有已注册光标，并把源位置作为动画起点。缺少源位置时
    // （第一次聚焦）直接更新当前窗格，不放动画。
    const spawnPoint = this.resolveSpawnPoint(this.lastActiveCursorPos);
    if (spawnPoint) {
      for (const data of this.cursors.values()) {
        if (data.dying) continue;
        if (!data.target.isConnected) continue;
        if (data.target.closest(".monaco-editor") !== editor) continue;
        const rect = data.target.getBoundingClientRect();
        // 不能只判 width && height 为 0：Monaco 布局尚未完成时，rect 也可能
        // 落在视口原点（一侧维度非零但坐标是 0,0），把这类值当动画终点会让
        // 光标飞到左上角。isValidCursorRect 会同时挡掉这两类脏值。
        if (!isValidCursorRect(rect)) continue;
        data.instance.setPosition(spawnPoint.x, spawnPoint.y);
        data.instance.move(rect.left, rect.top);
        data.lastX = rect.left;
        data.lastY = rect.top;
      }
    }

    this.lastActiveEditor = editor;
    // 更新一次源位置：取新窗格里"最近创建的那个光标"的当前位置，供下一次
    // 切走时作为动画起点。
    this.lastActiveCursorPos = this.pickEditorAnchor(editor);
  }

  pickEditorAnchor(editor) {
    let best = null;
    for (const data of this.cursors.values()) {
      if (data.dying) continue;
      if (!data.target.isConnected) continue;
      if (data.target.closest(".monaco-editor") !== editor) continue;
      if (!best || data.createdAt > best.createdAt) best = data;
    }
    if (!best) return null;
    return { x: best.lastX, y: best.lastY };
  }

  // 直接从 DOM 读当前 focused 编辑器里的"主光标"实时位置，作为动画起点的
  // 最终兜底。所有基于缓存字段（lastX/lastY、lastActiveCursorPos）的推导都
  // 可能因为异常路径变成 (0,0)——例如 Monaco 在极端 tab 切换时刻返回脏 rect、
  // 缓存被写入无效值、或首次聚焦还没建立锚点。相比让光标飞去画布左上角，飞
  // 出焦点窗格的主光标位置视觉上要合理得多。
  //
  // 主光标定义：focused 编辑器内第一个 rect 有效的 .cursor 节点。Monaco 的
  // primary cursor 通常是最早插入 DOM 的那个，DOM 顺序天然对应"第一个"。
  getActiveEditorPrimaryCursorPos() {
    const focused = document.querySelector(".monaco-editor.focused");
    if (!focused) return null;
    const cursors = focused.querySelectorAll(".cursor");
    for (const cursor of cursors) {
      const rect = cursor.getBoundingClientRect();
      if (isValidCursorRect(rect)) return { x: rect.left, y: rect.top };
    }
    return null;
  }

  // 校验一个准备用作动画起点的坐标：合法就原样返回；落在 (0,0) 附近或明显
  // 越界则回退到当前 focused 编辑器的主光标位置。都拿不到时返回 null，让
  // 调用方走"无动画直接就位"的分支——总之绝不允许把 (0,0) 传给 setPosition。
  resolveSpawnPoint(candidate) {
    if (candidate && isValidCursorRect({
      left: candidate.x, top: candidate.y, width: 1, height: 1
    })) {
      return candidate;
    }
    return this.getActiveEditorPrimaryCursorPos();
  }

  mutationHasCursor(nodeList) {
    for (const node of nodeList) {
      if (node.nodeType !== 1) continue;
      if (node.classList && node.classList.contains("cursor")) return true;
      if (node.querySelector && node.querySelector(".monaco-editor .cursor")) return true;
    }
    return false;
  }

  updateCanvasSize() {
    // 对齐 devicePixelRatio：canvas 内部像素密度与屏幕匹配，光标和阴影在
    // Retina/高 DPI 屏上不再模糊。用 setTransform 而不是缩放 style，避免
    // 后续 ctx 绘制坐标改变——上层代码用 CSS 像素坐标即可。
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = window.innerWidth + "px";
    this.canvas.style.height = window.innerHeight + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 给 .cursor 挂属性 observer：Monaco 通过改 style（移位、闪烁）或改 class
  // （选区/pending 状态）来更新光标；两种情况都当作"位置或可见性变了"处理，
  // 唤醒一帧并把光标标脏，让 updateCursor 重读 rect 和 computedStyle。稳态
  // 帧 dirty=false 可以完全跳过 getBoundingClientRect + getComputedStyle。
  _observeCursorTarget(target, data) {
    const obs = new MutationObserver(() => {
      data.dirty = true;
      this.requestFrame();
    });
    obs.observe(target, { attributes: true, attributeFilter: ["style", "class"] });
    return obs;
  }

  _removeCursor(id) {
    const data = this.cursors.get(id);
    if (!data) return;
    if (data.observer) data.observer.disconnect();
    this.cursors.delete(id);
  }

  scanCursors() {
    const nowIds = new Set();
    const cursorElements = document.querySelectorAll(".monaco-editor .cursor");

    // 按所在的 .monaco-editor 容器（窗格）分组已有光标，让新光标的动画起点
    // 只在同一窗格内查找——避免从另一个分屏的光标飞过来。每组内按 createdAt
    // 排序，取最大值即"实际最近一次创建的那个"（不能用 Map 插入序，因为它
    // 反映的是 DOM 文档顺序）。
    const editorGroups = new Map();
    for (const data of this.cursors.values()) {
      if (data.dying) continue;
      if (!data.target.isConnected) continue;
      const editor = data.target.closest(".monaco-editor");
      if (!editor) continue;
      if (!editorGroups.has(editor)) editorGroups.set(editor, []);
      editorGroups.get(editor).push(data);
    }

    const editorsWithNewCursors = new Set();
    cursorElements.forEach((target) => {
      let cursorId = target.getAttribute("custom-cursor-id");
      if (!cursorId) {
        cursorId = Math.random().toString(36).substring(7);
        target.setAttribute("custom-cursor-id", cursorId);
      }
      nowIds.add(cursorId);

      if (!this.cursors.has(cursorId)) {
        const rect = target.getBoundingClientRect();
        // 新光标 rect 无效时（Monaco 尚未跑完布局），本轮不注册。若强行把
        // (0,0) 记进来，move() 会立刻把 spring 目标锁死在左上角，光标就会
        // 先从合法起点飞到 (0,0) 再飞回真实位置。等下一次 MutationObserver
        // 触发或 500ms 轮询触发时再重试。
        if (!isValidCursorRect(rect)) return;

        const instance = createNeovideCursor({ canvas: this.canvas });
        instance.updateCursorSize(rect.width, rect.height);

        // 只在同一 .monaco-editor 窗格内查找起点光标，按 createdAt 取最近
        // 一次创建的那个。使用 lastX/lastY 而不是实时 getBoundingClientRect：
        // 在 MutationObserver 触发的时刻，Monaco 可能正处于批量 DOM 更新中
        // （例如 Ctrl+Shift+L），此时旧光标的 rect 可能瞬时归零或被移到别处，
        // 而 lastX/lastY 反映的是"最近一次渲染循环里稳定看到的位置"，也就是
        // 眼睛看到的起点，视觉最自然。
        const editor = target.closest(".monaco-editor");
        const siblings = editor ? editorGroups.get(editor) : null;
        let spawnSource = null;
        if (siblings && siblings.length > 0) {
          let last = siblings[0];
          for (let i = 1; i < siblings.length; i++) {
            if (siblings[i].createdAt > last.createdAt) last = siblings[i];
          }
          spawnSource = { x: last.lastX, y: last.lastY };
        }

        // 同窗格找不到兄弟光标、或兄弟坐标脏（比如 lastX/lastY 恰好被写成
        // (0,0)）时，交给 resolveSpawnPoint：它会先校验候选值合法性，不合法
        // 就回退到当前 focused 编辑器主光标的实时位置，避免退化成从画布左上
        // 角 (0,0) 起飞。
        spawnSource = this.resolveSpawnPoint(spawnSource);

        if (spawnSource) {
          instance.setPosition(spawnSource.x, spawnSource.y);
          instance.move(rect.left, rect.top);
        } else {
          instance.setPosition(rect.left, rect.top);
        }

        const data = {
          instance,
          target: target,
          // 缓存所在窗格：DOM 被销毁后 target.closest 会返回 null，吸回动画找
          // 不到主光标；提前缓存后哪怕 target 断链也能定位到窗格。
          editor: target.closest(".monaco-editor"),
          lastX: rect.left,
          lastY: rect.top,
          lastWidth: rect.width,
          lastHeight: rect.height,
          createdAt: ++this.creationCounter,
          dying: false,
          dirty: true,
          observer: null,
        };
        // 同窗格有新光标注册，说明这是 DOM 重建而非真正退出多光标。
        if (data.editor) editorsWithNewCursors.add(data.editor);
        // observer 需要引用 data 来置 dirty，所以要在 data 创建后再挂。
        data.observer = this._observeCursorTarget(target, data);
        this.cursors.set(cursorId, data);
        // 新光标注册后立即唤醒一帧，让它至少绘制一次到当前位置。
        this.requestFrame();
      }
    });

    // 若有同窗格新光标注册，说明之前标记的 dying 光标是 DOM 重建而非真正
    // 退出多光标——直接删除，不播放吸回动画（否则旧位置会残留孤儿光晕）。
    const crossScanRemovals = [];
    for (const [id, data] of this.cursors) {
      if (data.dying && editorsWithNewCursors.has(data.editor)) crossScanRemovals.push(id);
    }
    for (const id of crossScanRemovals) this._removeCursor(id);

    for (const [id, data] of this.cursors) {
      if (nowIds.has(id)) continue;
      if (data.dying) continue;
      // 滚动或同窗格 DOM 重建时直接删除，不播放吸回动画——否则旧位置
      // 会残留孤儿光晕，弹簧飞行产生拖尾。
      if (this.isScrolling || editorsWithNewCursors.has(data.editor)) {
        this._removeCursor(id);
        continue;
      }
      const suckTarget = this.findSuckTarget(data);
      if (!suckTarget) {
        this._removeCursor(id);
        continue;
      }
      this.startDying(data, suckTarget);
    }
  }

  // 把一个光标从活跃状态切换到 dying：设置吸附目的地并记录淡出起始时间。
  // 之所以抽出来是因为 scanCursors 和 loop 两个路径都会触发销毁。
  startDying(data, suckTarget) {
    data.dying = true;
    data.dyingAt = performance.now();
    // 淡出时长与吸附动画对齐：动画结束时透明度正好为 0，视觉上没有"到达终点
    // 再突然消失"的跳变。乘以 1000 换成毫秒；下限 60ms 防止极短动画下淡出
    // 过快看起来像闪断。
    data.fadeDuration = Math.max(ANIMATION_SETTINGS.animationLength * 1000, 60);
    // 记录起飞时刻到吸附目标的直线距离，作为归一化基准：越接近目标，光晕越
    // 容易叠出大面积高亮，需要更快地把 shadow alpha 拉低。
    data.suckStartDistance = Math.hypot(suckTarget.x - data.lastX, suckTarget.y - data.lastY);
    data.instance.move(suckTarget.x, suckTarget.y);
  }

  // 在同一窗格内挑一个"还活着"的最近使用的光标作为吸附目标。多光标模式退出
  // 时，主光标通常还留着，这里就会命中主光标；若整窗格都被销毁则返回 null。
  findSuckTarget(dyingData) {
    let best = null;
    for (const data of this.cursors.values()) {
      if (data === dyingData) continue;
      if (data.dying) continue;
      if (!data.target.isConnected) continue;
      if (data.editor !== dyingData.editor) continue;
      if (!best || data.createdAt > best.createdAt) best = data;
    }
    if (!best) return null;
    return { x: best.lastX, y: best.lastY };
  }

  loop() {
    // clearRect 走当前 transform，所以用 CSS 像素尺寸即可（不是 canvas.width，
    // 那是含 dpr 放大后的物理像素）。
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    // 本帧的 editor rect 缓存：runWithEditorClip 首次使用时 populate 一次，
    // 同一帧内所有光标复用；帧结束不显式清理，下帧开头重置。
    this._frameEditorRects = null;

    let anyAnimating = false;

    for (const [id, data] of this.cursors) {
      if (data.dying) {
        // dying 光标不再读 DOM（target 可能已经断链），只让 spring 动画跑完，
        // 到达吸附点后再真正从 Map 里删掉。
        // 本体 alpha 用时间线性淡出；阴影 alpha 单独按"离目标的距离比"高次幂
        // 快速衰减：光晕的成因是两个光标的阴影 blur 相互叠加，距离越近叠加
        // 越强，若沿用时间线性会在收尾阶段看到明显光斑。
        const elapsed = performance.now() - data.dyingAt;
        const bodyAlpha = Math.max(0, 1 - elapsed / data.fadeDuration);
        if (bodyAlpha <= 0) {
          this._removeCursor(id);
          continue;
        }
        const dist = data.instance.getDistanceToDestination();
        const distRatio = data.suckStartDistance > 0
          ? clamp(dist / data.suckStartDistance, 0, 1)
          : 0;
        // 三次方让阴影在"接近目标"的最后一段迅速掉到接近 0：距离剩 50% 时
        // shadow 只有 12.5%，距离剩 20% 时只有 0.8%。
        const shadowAlpha = distRatio * distRatio * distRatio;
        data.instance.setShadowAlphaFactor(shadowAlpha);
        this.ctx.save();
        this.ctx.globalAlpha = bodyAlpha;
        // 飞行中允许穿越其他窗格（否则动画会被邻居窗格"咬"断一截）；接近
        // 目标进入停留态时再启用 clip，避免阴影从边缘溢出到别的窗格。
        // dying 分支不传 bbox（null），永远走 clip 路径——dying 的绘制位置每帧
        // 变化，算 bbox 的代价接近 clip 本身，剪枝无收益。
        const flying = dist > CLIP_DISTANCE_THRESHOLD;
        const animating = this.runWithEditorClip(data.editor, flying, null, () =>
          data.instance.updateLoopLogic(this.isScrolling, true)
        );
        this.ctx.restore();
        // spring 收敛后直接删除不续帧；还在淡出中则续帧让 alpha 走完。
        if (!animating) {
          this._removeCursor(id);
        } else {
          anyAnimating = true;
        }
        continue;
      }
      // DOM 断连但 scanCursors 尚未执行。滚动期间 Monaco 重建元素导致
      // 断连时直接删除，不播放吸回动画。
      if (!data.target.isConnected) {
        if (this.isScrolling) {
          this._removeCursor(id);
        } else {
          const suckTarget = this.findSuckTarget(data);
          if (suckTarget) {
            this.startDying(data, suckTarget);
            anyAnimating = true;
          } else {
            this._removeCursor(id);
          }
        }
        continue;
      }
      if (this.updateCursor(data)) anyAnimating = true;
    }

    // 每帧刷新当前活跃窗格的锚点位置，让跨窗格切换的动画起点始终跟随最近
    // 一次光标移动，而不是停留在首次聚焦时的旧位置。
    if (this.lastActiveEditor) {
      if (this.lastActiveEditor.isConnected) {
        const anchor = this.pickEditorAnchor(this.lastActiveEditor);
        if (anchor) this.lastActiveCursorPos = anchor;
      } else {
        // 编辑器标签页已关闭，释放 DOM 引用防止内存泄漏。
        this.lastActiveEditor = null;
        this.lastActiveCursorPos = null;
      }
    }

    // Monaco 使用程序化滚动（CSS transform），不触发浏览器 scroll 事件。
    // 无论动画是否在跑，每 ~33ms 标脏一次确保光标目标始终与 DOM 同步。
    // 动画期间 requestFrame 是 no-op，但 dirty 会在下一帧触发位置重读。
    if (this._idleCheckId == null && this.cursors.size > 0) {
      this._idleCheckId = setTimeout(() => {
        this._idleCheckId = null;
        // 回调执行前所有光标可能已被移除，避免空转一帧只做 clearRect。
        if (this.cursors.size === 0) return;
        for (const data of this.cursors.values()) data.dirty = true;
        this.requestFrame();
      }, 33);
    }
    if (anyAnimating) this.requestFrame();
  }

  updateCursor(data) {
    const { instance, target } = data;

    // 窗格未 focused（Monaco 会在失焦后对 .cursor 做 opacity 淡出，此期间
    // 还会绘制若干帧）：直接跳过，不占用绘制。
    // 快路径：focusin/focusout 事件维护的 _focusedEditor 做引用比较；慢路径：
    // classList 兜底——首帧或 script 注入时机早于用户第一次 focus 时
    // _focusedEditor 可能仍为 null，但 Monaco 自己一直在维护 focused 类，
    // 靠 classList 就能确保光标始终能被绘制。classList 属性访问不触发布局。
    if (data.editor && data.editor !== this._focusedEditor
        && !data.editor.classList.contains("focused")) {
      return false;
    }

    // 快路径：dirty=false 表示上次同步后位置/尺寸没变过（style observer 没
    // 触发、也没被 scroll/focus/resize/interval 标脏）。直接用缓存的
    // lastX/lastY，跳过 getBoundingClientRect 和后续 move 判定——spring 动画
    // 仍然通过 updateLoopLogic 继续跑（比如从上一次 move 触发的 spring 还没
    // 收敛，或者本体 alpha 还在淡出）。
    // 可见性用缓存：Monaco 会单独把 .cursor 做透明（选区 anchor、闪烁、pending
    // 状态），此时 rect 仍有效但节点不应绘制——不然本体透明只剩 shadow，就
    // 会看到"凭空的光晕"。
    if (!data.dirty && !this.isScrolling) {
      if (data.hidden) return false;
      const flying = instance.getDistanceToDestination() > CLIP_DISTANCE_THRESHOLD;
      // shadow 外扩用 shadowBlur*2：canvas 高斯模糊的实际影响范围远大于
      // shadowBlur（后者只是"模糊半径"，尾部像素能延伸到 ~2 倍处），与
      // rebuildShadowSprite 里的 pad 保持一致。用 shadowBlur 会低估，光标离
      // sticky/breadcrumb/邻居窗格 20~40px 时相交剪枝误判为不相交，shadow
      // 就溢出到本该被 clip 挖掉的区域。
      const shadowPad = shadowBlur * 2;
      const bbox = {
        left: data.lastX - shadowPad,
        top: data.lastY - shadowPad,
        right: data.lastX + data.lastWidth + shadowPad,
        bottom: data.lastY + data.lastHeight + shadowPad,
      };
      return this.runWithEditorClip(data.editor, flying, bbox, () =>
        instance.updateLoopLogic(this.isScrolling, true)
      );
    }
    data.dirty = false;

    // dirty 分支必查一次可见性：Monaco 通过 CSS 类或 inline style 把光标做
    // 透明/隐藏时不会改坐标，若只依赖 rect 会漏掉，导致 stationaryBodyAlpha=0
    // 场景下留下"孤儿光晕"。getComputedStyle 只在 dirty 时调，频率与
    // style observer 触发一致（远低于 60Hz）。
    const computed = getComputedStyle(target);
    data.hidden = computed.visibility === "hidden"
      || computed.display === "none"
      || parseFloat(computed.opacity) < 0.05;
    if (data.hidden) return false;

    const rect = target.getBoundingClientRect();
    // 布局尚未稳定时 rect 可能是 (0,0,0,0)：不能让这类值污染 lastX/lastY，
    // 否则 pickEditorAnchor 会把 (0,0) 作为跨窗格切换的起点，让下一个焦点
    // 光标从左上角飞出。同样跳过尺寸更新——用 0 宽/高重算 centerDestination
    // 会把动画目的地推到窗格原点。
    if (!isValidCursorRect(rect)) return false;

    const isOffScreen = rect.right < 0 || rect.bottom < 0 ||
      rect.left > window.innerWidth || rect.top > window.innerHeight;

    // 尺寸变化独立于位置变化处理：全角↔半角切换时 rect.left/top 可能保持
    // 不变，只有 rect.width 会从 8 跳到 16（或反之）。若把尺寸更新塞进下面
    // 的位置分支里，就会漏掉这种"原地变宽"的情况，动画光标会继续用旧宽度
    // 绘制，出现覆盖错位。此外必须先 updateCursorSize 再 move，保证 move
    // 内部按新宽度重算 centerDestination。
    if (rect.width !== data.lastWidth || rect.height !== data.lastHeight) {
      instance.updateCursorSize(rect.width, rect.height);
      data.lastWidth = rect.width;
      data.lastHeight = rect.height;
      // 宽度变了、但位置没变时，也需要触发一次 move 让 centerDestination
      // 与新几何绑定并把动画目标推给 corners（updateCursorSize 内部只更新
      // centerDestination，不会通知 corners 重新计算目的地）。
      if (rect.left === data.lastX && rect.top === data.lastY) {
        instance.move(rect.left, rect.top);
      }
    }

    if (rect.left !== data.lastX || rect.top !== data.lastY) {
      instance.move(rect.left, rect.top);
      data.lastX = rect.left;
      data.lastY = rect.top;
    }

    // 稳态下把绘制限制在光标所属窗格外的允许区，防止阴影从窗格边缘溢出到
    // 邻居窗格的内容里；飞行途中（跨窗格切换的动画中段）临时放开 clip，让
    // 光标可以穿越其他窗格，否则动画会被邻居窗格咬掉一段看起来断开了。
    const flying = instance.getDistanceToDestination() > CLIP_DISTANCE_THRESHOLD;
    // 计算光标 + shadow 的外扩 bbox（CSS 像素），供 runWithEditorClip 做相交
    // 剪枝：不与任何需挖矩形相交时可以完全跳过 save/rect/clip/restore。
    // shadowPad 与 rebuildShadowSprite 保持一致，见上方快路径注释。
    const shadowPad = shadowBlur * 2;
    const bbox = {
      left: data.lastX - shadowPad,
      top: data.lastY - shadowPad,
      right: data.lastX + data.lastWidth + shadowPad,
      bottom: data.lastY + data.lastHeight + shadowPad,
    };
    return this.runWithEditorClip(data.editor, flying, bbox, () =>
      instance.updateLoopLogic(this.isScrolling, !isOffScreen)
    );
  }

  // 允许 dying / 跨窗格切换过程中的光标穿越 tab bar 和窗格之间的间隙，但不
  // 允许盖到其他窗格的内容区，也不允许停留在 sticky scroll 悬浮栏或面包屑
  // 导航栏下（否则动画光标会被这些悬浮层遮挡时序不同步，出现"半个光标露出
  // 来"或位置错乱）。做法：clip 掉"所有其他 .monaco-editor 的矩形 +
  // 所有 .sticky-widget + 所有 .monaco-breadcrumbs"，保留整块画布的剩余部分。
  // 用 evenodd 填充规则实现"外框减去内框"的环形 clip。飞行途中（flying=true）
  // 完全跳过 clip，让光标穿越任何东西（包括 sticky 和面包屑）——因为路径中段
  // 本来就跨在多个窗格上，飞越视觉上更自然。
  //
  // 相交剪枝：bbox 给出光标+shadow 的外扩矩形；如果它不与任何需挖矩形相交，
  // clip 只是空操作，直接跳过整套 save/rect/clip/restore。单光标 + 无分屏 +
  // 光标远离 sticky/breadcrumb 时这个分支覆盖大多数帧。传 null 视为不做剪枝。
  runWithEditorClip(editor, flying, bbox, fn) {
    if (flying) return fn();
    if (bbox && !this._bboxNeedsClip(editor, bbox)) return fn();
    this.ctx.save();
    this.ctx.beginPath();
    // 外框：整块 canvas（CSS 像素）。所有绘制默认落在这里。
    this.ctx.rect(0, 0, window.innerWidth, window.innerHeight);
    // 内框：每个"其他窗格" + 所有 sticky 栏 + 所有面包屑。evenodd 会把这些
    // 矩形从允许区里挖掉。本帧缓存：多光标 / 多分屏时同一帧内所有光标共用一
    // 份矩形列表，避免重复 querySelectorAll 和 getBoundingClientRect。
    // loop() 每帧开头把 _frameEditorRects 置 null 触发下一次重建。
    const cache = this._getFrameEditorRects();
    for (const entry of cache.editors) {
      if (entry.editor === editor) continue;
      const b = entry.rect;
      this.ctx.rect(b.left, b.top, b.width, b.height);
    }
    for (const b of cache.overlays) {
      // sticky 栏和面包屑无论属于哪个 editor 都要挖：即使是当前 editor 自己的
      // sticky/面包屑也不能让光标画在下面。
      this.ctx.rect(b.left, b.top, b.width, b.height);
    }
    this.ctx.clip("evenodd");
    try {
      return fn();
    } finally {
      this.ctx.restore();
    }
  }

  // 判断当前光标 bbox（left/top/right/bottom）是否与任何"需挖矩形"相交。
  // 相交 = clip 会真实生效，需要走 clip 路径；不相交 = clip 是空操作，跳过。
  _bboxNeedsClip(editor, bbox) {
    const cache = this._getFrameEditorRects();
    for (const entry of cache.editors) {
      if (entry.editor === editor) continue;
      const b = entry.rect;
      if (bbox.left < b.right && bbox.right > b.left
          && bbox.top < b.bottom && bbox.bottom > b.top) return true;
    }
    for (const b of cache.overlays) {
      if (bbox.left < b.right && bbox.right > b.left
          && bbox.top < b.bottom && bbox.bottom > b.top) return true;
    }
    return false;
  }

  _getFrameEditorRects() {
    if (this._frameEditorRects) return this._frameEditorRects;
    const editorNodes = document.querySelectorAll(".monaco-editor");
    // 一起收集所有需要遮挡光标的悬浮层：sticky scroll 栏 + 面包屑。两者结构
    // 上都是覆盖在编辑区上方的固定元素，clip 处理逻辑完全一致，合并到一个
    // overlays 数组减少循环开销。
    const overlayNodes = document.querySelectorAll(".sticky-widget, .monaco-breadcrumbs");
    const editors = [];
    for (const editor of editorNodes) {
      const rect = editor.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      editors.push({ editor, rect });
    }
    const overlays = [];
    for (const s of overlayNodes) {
      const rect = s.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      overlays.push(rect);
    }
    this._frameEditorRects = { editors, overlays };
    return this._frameEditorRects;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => new GlobalCursorManager());
} else {
  new GlobalCursorManager();
}
