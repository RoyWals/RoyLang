// Virtual On-Screen Touch Gamepad for Roy-Игры Player
// Multi-touch D-pad (Arrows / WASD toggle) + A (Space) / B (Enter) buttons.

const KEY_DEFS = {
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  KeyA: { code: 'KeyA', key: 'a', keyCode: 65 },
  KeyD: { code: 'KeyD', key: 'd', keyCode: 68 },
  KeyW: { code: 'KeyW', key: 'w', keyCode: 87 },
  KeyS: { code: 'KeyS', key: 's', keyCode: 83 },
  Space: { code: 'Space', key: ' ', keyCode: 32 },
  Enter: { code: 'Enter', key: 'Enter', keyCode: 13 }
};

export function createRoyTouchGamepadController({ getOverlayEl, getIframeEl }) {
  let active = false;
  let useWasd = false;
  const activePointers = new Map(); // pointerId -> mappedKeyCode
  const keyHoldCounts = new Map(); // mappedKeyCode -> count

  function dispatchVirtualKey(codeName, pressed) {
    const def = KEY_DEFS[codeName];
    if (!def) return;
    const iframe = typeof getIframeEl === 'function' ? getIframeEl() : null;
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({
        type: 'roy-virtual-key',
        code: def.code,
        key: def.key,
        keyCode: def.keyCode,
        pressed: !!pressed
      }, '*');
    } catch (_) {}
  }

  function setLogicalPressed(codeName, pressed) {
    const cur = keyHoldCounts.get(codeName) || 0;
    if (pressed) {
      keyHoldCounts.set(codeName, cur + 1);
      if (cur === 0) dispatchVirtualKey(codeName, true);
    } else {
      const next = Math.max(0, cur - 1);
      if (next === 0) {
        keyHoldCounts.delete(codeName);
        if (cur > 0) dispatchVirtualKey(codeName, false);
      } else {
        keyHoldCounts.set(codeName, next);
      }
    }
  }

  function releaseAll() {
    Array.from(keyHoldCounts.keys()).forEach((code) => {
      dispatchVirtualKey(code, false);
    });
    keyHoldCounts.clear();
    activePointers.clear();
    const overlay = typeof getOverlayEl === 'function' ? getOverlayEl() : null;
    if (overlay) {
      overlay.querySelectorAll('.roy-pad-btn.pressed').forEach(b => b.classList.remove('pressed'));
    }
  }

  function resolveDirCode(dir) {
    if (dir === 'up') return useWasd ? 'KeyW' : 'ArrowUp';
    if (dir === 'down') return useWasd ? 'KeyS' : 'ArrowDown';
    if (dir === 'left') return useWasd ? 'KeyA' : 'ArrowLeft';
    if (dir === 'right') return useWasd ? 'KeyD' : 'ArrowRight';
    if (dir === 'a') return 'Space';
    if (dir === 'b') return 'Enter';
    return null;
  }

  function updateVisualStates(overlay) {
    if (!overlay) return;
    overlay.querySelectorAll('[data-pad-dir]').forEach(btn => {
      const dir = btn.getAttribute('data-pad-dir');
      const code = resolveDirCode(dir);
      btn.classList.toggle('pressed', !!(code && (keyHoldCounts.get(code) || 0) > 0));
    });
  }

  function bindOverlayEvents(overlay) {
    if (!overlay || overlay._royPadBound) return;
    overlay._royPadBound = true;

    const handleReleasePointer = (pointerId) => {
      const prevCode = activePointers.get(pointerId);
      if (prevCode) {
        activePointers.delete(pointerId);
        setLogicalPressed(prevCode, false);
        updateVisualStates(overlay);
      }
    };

    overlay.addEventListener('pointerdown', (e) => {
      const modeBtn = e.target.closest('[data-pad-mode-toggle]');
      if (modeBtn) {
        e.preventDefault();
        e.stopPropagation();
        releaseAll();
        useWasd = !useWasd;
        modeBtn.textContent = useWasd ? 'WASD' : 'Стрелки';
        return;
      }
      const btn = e.target.closest('[data-pad-dir]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const code = resolveDirCode(btn.getAttribute('data-pad-dir'));
      if (!code) return;
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
      const prev = activePointers.get(e.pointerId);
      if (prev && prev !== code) setLogicalPressed(prev, false);
      if (prev !== code) {
        activePointers.set(e.pointerId, code);
        setLogicalPressed(code, true);
      }
      updateVisualStates(overlay);
    });

    overlay.addEventListener('pointermove', (e) => {
      if (!activePointers.has(e.pointerId)) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const btn = el ? el.closest('[data-pad-dir]') : null;
      const nextCode = btn ? resolveDirCode(btn.getAttribute('data-pad-dir')) : null;
      const prevCode = activePointers.get(e.pointerId);
      if (nextCode === prevCode) return;
      if (prevCode) setLogicalPressed(prevCode, false);
      if (nextCode) {
        activePointers.set(e.pointerId, nextCode);
        setLogicalPressed(nextCode, true);
      } else {
        activePointers.delete(e.pointerId);
      }
      updateVisualStates(overlay);
    });

    overlay.addEventListener('pointerup', (e) => handleReleasePointer(e.pointerId));
    overlay.addEventListener('pointercancel', (e) => handleReleasePointer(e.pointerId));
  }

  function renderMarkup(overlay) {
    overlay.innerHTML = `
      <div class="roy-gamepad-cluster roy-gamepad-dpad">
        <div></div>
        <button type="button" class="roy-pad-btn" data-pad-dir="up" aria-label="Вверх"><i class="fa-solid fa-caret-up"></i></button>
        <div></div>
        <button type="button" class="roy-pad-btn" data-pad-dir="left" aria-label="Влево"><i class="fa-solid fa-caret-left"></i></button>
        <div class="roy-pad-center"></div>
        <button type="button" class="roy-pad-btn" data-pad-dir="right" aria-label="Вправо"><i class="fa-solid fa-caret-right"></i></button>
        <div></div>
        <button type="button" class="roy-pad-btn" data-pad-dir="down" aria-label="Вниз"><i class="fa-solid fa-caret-down"></i></button>
        <div></div>
      </div>
      <div class="roy-gamepad-cluster roy-gamepad-actions">
        <button type="button" class="roy-pad-mode-pill" data-pad-mode-toggle title="Переключить Стрелки / WASD">${useWasd ? 'WASD' : 'Стрелки'}</button>
        <div style="display:flex; gap:12px; align-items:flex-end;">
          <button type="button" class="roy-pad-btn roy-pad-action roy-pad-b" data-pad-dir="b" aria-label="Enter">B</button>
          <button type="button" class="roy-pad-btn roy-pad-action roy-pad-a" data-pad-dir="a" aria-label="Space">A</button>
        </div>
      </div>
    `;
    bindOverlayEvents(overlay);
  }

  function setVisible(show) {
    active = !!show;
    const overlay = typeof getOverlayEl === 'function' ? getOverlayEl() : null;
    if (!overlay) return active;
    if (!active) {
      releaseAll();
      overlay.style.display = 'none';
    } else {
      if (!overlay.innerHTML.trim()) renderMarkup(overlay);
      overlay.style.display = 'flex';
    }
    return active;
  }

  function toggle() {
    return setVisible(!active);
  }

  function isVisible() {
    return active;
  }

  return { setVisible, toggle, isVisible, releaseAll };
}
