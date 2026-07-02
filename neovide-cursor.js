// --- Configurations ---
const cursorColor = "#C8D3F5"; // cursor color
const cursorUpdatePollingRate = 500; // dom detecting time (ms)
const useShadow = true; // cursor shadow
const shadowColor = cursorColor; // cursor shadow color
const shadowBlur = 20; // shadow blur radius

const ANIMATION_SETTINGS = {
  animationLength: 0.1, // animation time length (when cursor jumping)
  trailSize: 1, // animation trail density (0-1)
};

// 光标离目标的距离超过这个像素数即视为"飞行中"，允许穿越其他窗格；小于等于
// 时视为已到位，启用 clip 防止阴影从边缘溢出到邻居窗格。取大于 shadowBlur
// 是为了在阴影半径够小时不误判为飞行。
const CLIP_DISTANCE_THRESHOLD = 30;

// -----------------------

const STANDARD_CORNERS = [
  { x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 },
  { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }
];

const helperCanvas = document.createElement("canvas");
const helperCtx = helperCanvas.getContext("2d");

function resolveColor(color) {
  helperCtx.fillStyle = color;
  const normalized = helperCtx.fillStyle;
  return parseHexColor(normalized);
}

function parseHexColor(color) {
  if (!color?.startsWith("#")) return { r: 255, g: 255, b: 255, a: 255 };
  const hex = color.slice(1);
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: 255
    };
  }
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 255
    };
  }
  if (hex.length === 8) {
    return {
      a: parseInt(hex.slice(0, 2), 16),
      r: parseInt(hex.slice(2, 4), 16),
      g: parseInt(hex.slice(4, 6), 16),
      b: parseInt(hex.slice(6, 8), 16)
    };
  }
  return { r: 255, g: 255, b: 255, a: 255 };
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
  }

  getDestination(center, cursorDimensions) {
    return {
      x: center.x + this.relativePosition.x * cursorDimensions.width,
      y: center.y + this.relativePosition.y * cursorDimensions.height
    };
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

  jump(destination, cursorDimensions, rank) {
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
      const delta = {
        x: cornerDestination.x - this.currentPosition.x,
        y: cornerDestination.y - this.currentPosition.y
      };
      this.animationX.position = delta.x;
      this.animationY.position = delta.y;
      this.previousDestination = { ...cornerDestination };
    }

    if (immediate) {
      this.currentPosition = cornerDestination;
      this.animationX.reset();
      this.animationY.reset();
      return false;
    }

    const animX = this.animationX.update(dt, this.animationLength);
    const animY = this.animationY.update(dt, this.animationLength);

    this.currentPosition = {
      x: cornerDestination.x - this.animationX.position,
      y: cornerDestination.y - this.animationY.position
    };
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
  let cursorDimensions = { width: 8, height: 18 };
  let destination = { x: 0, y: 0 };
  let centerDestination = { x: 0, y: 0 };
  let lastTimestamp = performance.now();
  let initialized = false;
  let jumped = false;
  // 独立于 globalAlpha 的阴影强度系数：dying 光标越靠近吸附目标时，两个光标
  // 的阴影会强烈重叠形成大面积光晕，需要按距离单独把阴影压下来。
  let shadowAlphaFactor = 1;

  const corners = STANDARD_CORNERS.map(rel => new Corner(rel));

  function updateCursorSize(width, height) {
    if (width) cursorDimensions.width = width;
    if (height) cursorDimensions.height = height;
  }

  function move(x, y) {
    destination = { x, y };
    centerDestination = {
      x: destination.x + cursorDimensions.width / 2,
      y: destination.y + cursorDimensions.height / 2
    };
    jumped = true;

    if (!initialized) {
      corners.forEach(corner => {
        const cornerDest = corner.getDestination(centerDestination, cursorDimensions);
        corner.currentPosition = { ...cornerDest };
        corner.previousDestination = { ...cornerDest };
      });
      initialized = true;
    }
  }

  function drawCursorShape() {
    if (!initialized) return;
    context.beginPath();
    context.moveTo(corners[0].currentPosition.x, corners[0].currentPosition.y);
    for (let i = 1; i < corners.length; i++) {
      context.lineTo(corners[i].currentPosition.x, corners[i].currentPosition.y);
    }
    context.closePath();

    context.fillStyle = rgbaToCss(colorObj);
    context.imageSmoothingEnabled = ANIMATION_SETTINGS.antialiasing;

    // canvas 的阴影强度由 shadowColor 的 alpha 直接控制；shadowAlphaFactor 让
    // 调用方能独立压制光晕（例如 dying 光标靠近吸附目标时避免叠出大面积光晕），
    // 又不影响本体填充的透明度。
    if (useShadow && shadowAlphaFactor > 0) {
      context.shadowColor = rgbaToCss({
        r: shadowColorObj.r,
        g: shadowColorObj.g,
        b: shadowColorObj.b,
        a: shadowColorObj.a * shadowAlphaFactor
      });
      context.shadowBlur = shadowBlur;
    } else {
      context.shadowColor = "rgba(0, 0, 0, 0)";
      context.shadowBlur = 0;
    }
    context.fill();
  }

  function setShadowAlphaFactor(factor) {
    shadowAlphaFactor = clamp(factor, 0, 1);
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
    destination = { x, y };
    centerDestination = {
      x: destination.x + cursorDimensions.width / 2,
      y: destination.y + cursorDimensions.height / 2,
    };

    corners.forEach(corner => {
      const dest = corner.getDestination(centerDestination, cursorDimensions);
      corner.currentPosition = { ...dest };
      corner.previousDestination = { ...dest };
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
      const ranks = computeCornerRanks(corners, cursorDimensions, centerDestination);
      corners.forEach((corner, index) => {
        corner.jump(centerDestination, cursorDimensions, ranks[index]);
      });
    }

    let animating = false;
    corners.forEach(corner => {
      if (corner.update(cursorDimensions, centerDestination, dt, immediateMovement)) {
        animating = true;
      }
    });

    if (shouldDraw) {
      drawCursorShape();
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

    window.addEventListener("resize", () => this.updateCanvasSize());
    this.updateCanvasSize();

    document.addEventListener('scroll', () => {
      this.isScrolling = true;
      clearTimeout(this.scrollTimeout);
      this.scrollTimeout = setTimeout(() => {
        this.isScrolling = false;
      }, 100);
    }, { capture: true, passive: true });

    this.loop();

    setInterval(() => this.scanCursors(), cursorUpdatePollingRate);

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
    document.addEventListener("focusin", (e) => this.handleFocusChange(e.target), true);
  }

  handleFocusChange(target) {
    if (!target || !target.closest) return;
    const editor = target.closest(".monaco-editor");
    if (!editor) return;
    if (editor === this.lastActiveEditor) return;

    // 收集新窗格里的所有已注册光标，并把源位置作为动画起点。缺少源位置时
    // （第一次聚焦）直接更新当前窗格，不放动画。
    if (this.lastActiveCursorPos) {
      for (const data of this.cursors.values()) {
        if (data.dying) continue;
        if (!data.target.isConnected) continue;
        if (data.target.closest(".monaco-editor") !== editor) continue;
        const rect = data.target.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        data.instance.setPosition(this.lastActiveCursorPos.x, this.lastActiveCursorPos.y);
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

  mutationHasCursor(nodeList) {
    for (const node of nodeList) {
      if (node.nodeType !== 1) continue;
      if (node.classList && node.classList.contains("cursor")) return true;
      if (node.querySelector && node.querySelector(".monaco-editor .cursor")) return true;
    }
    return false;
  }

  updateCanvasSize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
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

    cursorElements.forEach((target) => {
      let cursorId = target.getAttribute("custom-cursor-id");
      if (!cursorId) {
        cursorId = Math.random().toString(36).substring(7);
        target.setAttribute("custom-cursor-id", cursorId);
      }
      nowIds.add(cursorId);

      if (!this.cursors.has(cursorId)) {
        const instance = createNeovideCursor({ canvas: this.canvas });
        const rect = target.getBoundingClientRect();
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

        // 同窗格找不到兄弟光标时（例如新分屏里首次出现的光标，或者 DOM 刚插入
        // 时兄弟光标的 rect 尚未稳定），退回到"当前活跃窗格的主光标位置"作为
        // 动画起点，避免退化成从画布左上角 (0,0) 起飞的怪异动画。
        if (!spawnSource) {
          const activeEditor = document.querySelector(".monaco-editor.focused");
          if (activeEditor) {
            spawnSource = this.pickEditorAnchor(activeEditor);
          }
        }

        if (spawnSource) {
          instance.setPosition(spawnSource.x, spawnSource.y);
          instance.move(rect.left, rect.top);
        } else {
          instance.setPosition(rect.left, rect.top);
        }

        this.cursors.set(cursorId, {
          instance,
          target: target,
          // 缓存所在窗格：DOM 被销毁后 target.closest 会返回 null，吸回动画找
          // 不到主光标；提前缓存后哪怕 target 断链也能定位到窗格。
          editor: target.closest(".monaco-editor"),
          lastX: rect.left,
          lastY: rect.top,
          createdAt: ++this.creationCounter,
          dying: false
        });
      }
    });

    for (const [id, data] of this.cursors) {
      if (nowIds.has(id)) continue;
      if (data.dying) continue;
      // DOM 被移除的光标（例如 Esc 退出多光标模式时销毁的次光标）不立刻删除，
      // 而是标记为 dying 并给它设置一个"吸回主光标"的目的地，让 spring 动画
      // 把它拉过去，产生被吸附的视觉效果。找不到吸附目标（例如整个窗格都消
      // 失）时直接删除。
      const suckTarget = this.findSuckTarget(data);
      if (!suckTarget) {
        this.cursors.delete(id);
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
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

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
          this.cursors.delete(id);
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
        const flying = dist > CLIP_DISTANCE_THRESHOLD;
        const animating = this.runWithEditorClip(data.editor, flying, () =>
          data.instance.updateLoopLogic(this.isScrolling, true)
        );
        this.ctx.restore();
        if (!animating) this.cursors.delete(id);
        continue;
      }
      // DOM 节点被移除但还未走到 scanCursors 的兜底路径（例如 loop 早于下一次
      // scan 触发）：这里不再直接 delete，先启动吸回动画，找不到吸附目标时才
      // 真正丢弃。
      if (!data.target.isConnected) {
        const suckTarget = this.findSuckTarget(data);
        if (suckTarget) {
          this.startDying(data, suckTarget);
        } else {
          this.cursors.delete(id);
        }
        continue;
      }
      this.updateCursor(data);
    }

    // 每帧刷新当前活跃窗格的锚点位置，让跨窗格切换的动画起点始终跟随最近
    // 一次光标移动，而不是停留在首次聚焦时的旧位置。
    if (this.lastActiveEditor && this.lastActiveEditor.isConnected) {
      const anchor = this.pickEditorAnchor(this.lastActiveEditor);
      if (anchor) this.lastActiveCursorPos = anchor;
    }

    requestAnimationFrame(() => this.loop());
  }

  updateCursor(data) {
    const { instance, target } = data;

    const computed = getComputedStyle(target);
    if (computed.visibility === "hidden" || computed.display === "none" || parseFloat(computed.opacity) < 0.05) {
      return;
    }

    // 窗格失焦后 Monaco 会给 .cursor 做 opacity 淡出过渡，同时移除父级
    // .monaco-editor 上的 focused 类。仅靠 opacity 判断会读到 "0.6" 这类
    // 中间值，导致淡出期间光标继续被绘制，产生切换窗格时的短暂残留。
    const editor = target.closest(".monaco-editor");
    if (editor && !editor.classList.contains("focused")) {
      return;
    }

    const rect = target.getBoundingClientRect();
    const isOffScreen = rect.right < 0 || rect.bottom < 0 ||
      rect.left > window.innerWidth || rect.top > window.innerHeight;

    if (rect.left !== data.lastX || rect.top !== data.lastY) {
      instance.move(rect.left, rect.top);
      instance.updateCursorSize(rect.width, rect.height);
      data.lastX = rect.left;
      data.lastY = rect.top;
    }

    // 稳态下把绘制限制在光标所属窗格外的允许区，防止阴影从窗格边缘溢出到
    // 邻居窗格的内容里；飞行途中（跨窗格切换的动画中段）临时放开 clip，让
    // 光标可以穿越其他窗格，否则动画会被邻居窗格咬掉一段看起来断开了。
    const flying = instance.getDistanceToDestination() > CLIP_DISTANCE_THRESHOLD;
    this.runWithEditorClip(editor, flying, () =>
      instance.updateLoopLogic(this.isScrolling, !isOffScreen)
    );
  }

  // 允许 dying / 跨窗格切换过程中的光标穿越 tab bar 和窗格之间的间隙，但不
  // 允许盖到其他窗格的内容区。做法：clip 掉"所有其他 .monaco-editor 的矩形"，
  // 保留整块画布的剩余部分——即当前 editor 本身、标题栏、编辑器之间的空隙。
  // 用 evenodd 填充规则实现"外框减去内框"的环形 clip。飞行途中（flying=true）
  // 完全跳过 clip，让光标穿越任何东西——因为路径中段本来就跨在多个窗格上。
  runWithEditorClip(editor, flying, fn) {
    if (flying) return fn();
    this.ctx.save();
    this.ctx.beginPath();
    // 外框：整块 canvas。所有绘制默认落在这里。
    this.ctx.rect(0, 0, this.canvas.width, this.canvas.height);
    // 内框：每个"其他窗格"。evenodd 会把这些矩形从允许区里挖掉。
    const editors = document.querySelectorAll(".monaco-editor");
    for (const other of editors) {
      if (other === editor) continue;
      const b = other.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      this.ctx.rect(b.left, b.top, b.width, b.height);
    }
    this.ctx.clip("evenodd");
    try {
      return fn();
    } finally {
      this.ctx.restore();
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => new GlobalCursorManager());
} else {
  new GlobalCursorManager();
}
