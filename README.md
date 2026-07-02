# Neovide Cursor Effect for VS Code 🚀

Adds a smooth, spring-physics based cursor animation to VS Code, inspired by the beautiful cursor movement of [Neovide](https://neovide.dev/).

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## ✨ Features

*   **Neovide-like Physics**: Implements the characteristic "jelly" effect where the cursor stretches based on movement velocity.

*   **Global Overlay**: Uses a fixed canvas overlay that works perfectly with **Split Screens** and scrolling.

*   **Optimized Performance**: Only draws when necessary. No lag during typing or scrolling.

*   **Smart Positioning**: 
    *   Fixes "flying cursor" issues when switching between split editors.
    *   Fixes animation lag when scrolling.

## 🤝 Credits

This project is an open-source implementation inspired by the community.

*   **Animation Concept**: [Neovide](https://github.com/neovide/neovide) (MIT License).
*   **Original Idea & Logic**: Based on the Reddit post by **u/qwreey**: [I made neovide alike cursor effect on vscode](https://www.reddit.com/r/vscode/comments/11e66xh/i_made_neovide_alike_cursor_effect_on_vscode/).
*   **Refactoring & Fixes**: Includes significant rewrites for split-screen support, scroll synchronization, and global event management.

## Seng Jik 的改进 / Seng Jik's Improvements

改进完全使用 Claude Sonnet 完成。

Improvements were done entirely with Claude Sonnet.

* 多光标支持 / Multi-cursor support
  * 创建多光标时新光标从旧光标飞入 / New cursors fly in from existing ones when multi-cursor is triggered
  * 删除多光标时将亡光标会飞回主光标 / Dying cursors are sucked back into the primary cursor when multi-cursor mode exits
* 在窗格间切换时光标可以飞越窗格 / Cursor can fly across panes when switching split editors
* 修复特定情况下从左上角飞入的bug / Fixed a bug where the cursor sometimes flew in from the top-left corner
* 在涉及中文排版时坐标对不齐的问题 / Fixed coordinate misalignment when mixing CJK and Latin characters
* 光标停留时半透明化，避免遮挡下方字符与真实光标 / Cursor fades to semi-transparent when stationary, so the underlying character and the real cursor stay visible

## 🛠️ Installation

To use this script, you need an extension that allows injecting custom JavaScript into VS Code.


1.  Install [Custom CSS and JS Loader](https://marketplace.visualstudio.com/items?itemName=be5invis.vscode-custom-css).
2.  Download `neovide-cursor.js`.
3.  Add the configuration to `settings.json`:
    ```json
    "vscode_custom_css.imports": [
        "file:///C:/path/to/your/neovide-cursor.js"
    ]
    ```
4.  Run the command: `> Enable Custom CSS and JS`.
5.  Restart VS Code.

## ⚙️ Configuration

You can adjust the animation speed and look by modifying the constants at the top of the `.js` file:

```javascript
const cursorColor = "#C8D3F5"; // cursor color
const cursorUpdatePollingRate = 500; // dom detecting time (ms)
const useShadow = true; // cursor shadow
const shadowColor = cursorColor; // cursor shadow color
const shadowBlur = 10; // shadow blur radius

const stationaryBodyAlpha = 0.35; // 静止态（spring 收敛后）本体透明度，0 = 全透，1 = 不透明

const ANIMATION_SETTINGS = {
  animationLength: 0.10, // animation time length (when cursor jumping)
  shortAnimationLength: 0.04, // short animation time length (when cursor moving on single line)
  trailSize: 1, // animation trail density (0-1)
};
```
