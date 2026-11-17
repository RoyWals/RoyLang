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
  KeyE: { code: 'KeyE', key: 'e', keyCode: 69 },
  KeyQ: { code: 'KeyQ', key: 'q', keyCode: 81 },
  ShiftLeft: { code: 'ShiftLeft', key: 'Shift', keyCode: 16 },
  Space: { code: 'Space', key: ' ', keyCode: 32 },
  Enter: { code: 'Enter', key: 'Enter', keyCode: 13 }
};

export function createRoyTouchGamepadController({ getOverlayEl, getIframeEl, onVisibilityChange }) {
  let active = false;
  let useWasd = false;
  let useStick = false;
  let extraButtons = []; // [{ label, code }]
  const activePointers = new Map(); // pointerId -> mappedKeyCode
  const keyHoldCounts = new Map(); // mappedKeyCode -> count
  let stickPointerId = null;
  const stickHeldDirs = { left: false, right: false, up: false, down: false };
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function dispatchVirtualAxis(x, y, isActive) {
    const iframe = typeof getIframeEl === 'function' ? getIframeEl() : null;
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({
        type: 'roy-virtual-axis',
        x: Math.max(-1, Math.min(1, Number(x) || 0)),
        y: Math.max(-1, Math.min(1, Number(y) || 0)),
        active: !!isActive
      }, '*');
    } catch (_) {}
  }

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

  function releaseStick(overlay) {
    stickPointerId = null;
    ['left', 'right', 'up', 'down'].forEach((dir) => {
      if (stickHeldDirs[dir]) {
        stickHeldDirs[dir] = false;
        const code = resolveDirCode(dir);
        if (code) setLogicalPressed(code, false);
      }
    });
    dispatchVirtualAxis(0, 0, false);
    const ov = overlay || (typeof getOverlayEl === 'function' ? getOverlayEl() : null);
    if (ov) {
      const knob = ov.querySelector('.roy-stick-knob');
      if (knob) knob.style.transform = 'translate(-50%, -50%)';
      const base = ov.querySelector('.roy-stick-base');
      if (base) base.classList.remove('active');
    }
  }

  function releaseAll() {
    releaseStick();
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
    if (String(dir || '').indexOf('extra:') === 0) return String(dir).slice(6);
    return null;
  }

  function updateStickFromPointer(stickEl, clientX, clientY) {
    if (!stickEl) return;
    const rect = stickEl.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const maxR = Math.max(18, rect.width * 0.42);
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > maxR && dist > 0) {
      const s = maxR / dist;
      dx *= s;
      dy *= s;
    }
    const nx = dx / maxR;
    const ny = dy / maxR;
    const knob = stickEl.querySelector('.roy-stick-knob');
    if (knob) {
      knob.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px))`;
    }
    stickEl.classList.add('active');
    dispatchVirtualAxis(nx, ny, true);

    const TH = 0.45;
    const nextDirs = {
      left: nx < -TH,
      right: nx > TH,
      up: ny < -TH,
      down: ny > TH
    };
    ['left', 'right', 'up', 'down'].forEach((dir) => {
      if (nextDirs[dir] !== stickHeldDirs[dir]) {
        stickHeldDirs[dir] = nextDirs[dir];
        const code = resolveDirCode(dir);
        if (code) setLogicalPressed(code, nextDirs[dir]);
      }
    });
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
      if (stickPointerId === pointerId) {
        releaseStick(overlay);
      }
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
      const stickEl = e.target.closest('[data-pad-stick]');
      if (stickEl) {
        e.preventDefault();
        e.stopPropagation();
        stickPointerId = e.pointerId;
        try { stickEl.setPointerCapture(e.pointerId); } catch (_) {}
        updateStickFromPointer(stickEl, e.clientX, e.clientY);
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
      if (stickPointerId === e.pointerId) {
        const stickEl = overlay.querySelector('[data-pad-stick]');
        if (stickEl) updateStickFromPointer(stickEl, e.clientX, e.clientY);
        return;
      }
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
    const leftHtml = useStick
      ? `<div class="roy-gamepad-cluster roy-gamepad-stick">
           <div class="roy-stick-base" data-pad-stick="1" aria-label="Аналоговый стик">
             <div class="roy-stick-knob"></div>
           </div>
         </div>`
      : `<div class="roy-gamepad-cluster roy-gamepad-dpad">
           <div></div>
           <button type="button" class="roy-pad-btn" data-pad-dir="up" aria-label="Вверх"><i class="fa-solid fa-caret-up"></i></button>
           <div></div>
           <button type="button" class="roy-pad-btn" data-pad-dir="left" aria-label="Влево"><i class="fa-solid fa-caret-left"></i></button>
           <div class="roy-pad-center"></div>
           <button type="button" class="roy-pad-btn" data-pad-dir="right" aria-label="Вправо"><i class="fa-solid fa-caret-right"></i></button>
           <div></div>
           <button type="button" class="roy-pad-btn" data-pad-dir="down" aria-label="Вниз"><i class="fa-solid fa-caret-down"></i></button>
           <div></div>
         </div>`;

    overlay.innerHTML = `
      ${leftHtml}
      <div class="roy-gamepad-cluster roy-gamepad-actions">
        <button type="button" class="roy-pad-mode-pill" data-pad-mode-toggle title="Переключить Стрелки / WASD">${useWasd ? 'WASD' : 'Стрелки'}</button>
        ${extraButtons.length > 0 ? `<div style="display:flex; gap:8px; justify-content:flex-end;">${extraButtons.map(b => `<button type="button" class="roy-pad-btn roy-pad-action" style="width:42px;height:42px;font-size:12px;" data-pad-dir="extra:${esc(b.code)}" aria-label="${esc(b.code)}">${esc(b.label)}</button>`).join('')}</div>` : ''}
        <div style="display:flex; gap:12px; align-items:flex-end;">
          <button type="button" class="roy-pad-btn roy-pad-action roy-pad-b" data-pad-dir="b" aria-label="Enter">B</button>
          <button type="button" class="roy-pad-btn roy-pad-action roy-pad-a" data-pad-dir="a" aria-label="Space">A</button>
        </div>
      </div>
    `;
    bindOverlayEvents(overlay);
  }

  function setConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (typeof cfg.wasd === 'boolean') useWasd = cfg.wasd;
    if (typeof cfg.stick === 'boolean') useStick = cfg.stick;
    if (Array.isArray(cfg.extras)) {
      extraButtons = cfg.extras.slice(0, 3).map(item => {
        if (typeof item === 'string') {
          if (!KEY_DEFS[item]) KEY_DEFS[item] = { code: item, key: item.replace(/^Key/, '').toLowerCase(), keyCode: 0 };
          return { code: item, label: item.replace(/^Key|^Shift/, '').slice(0, 3).toUpperCase() };
        }
        const code = String(item.code || 'KeyE');
        if (!KEY_DEFS[code]) KEY_DEFS[code] = { code, key: item.key || code.replace(/^Key/, '').toLowerCase(), keyCode: 0 };
        return { code, label: String(item.label || code).slice(0, 4) };
      });
    }
    const overlay = typeof getOverlayEl === 'function' ? getOverlayEl() : null;
    if (overlay) {
      if (active) renderMarkup(overlay);
      else overlay.innerHTML = '';
    }
    if (typeof cfg.visible === 'boolean') setVisible(cfg.visible);
  }

  function resetConfig() {
    releaseAll();
    useWasd = false;
    useStick = false;
    extraButtons = [];
    const overlay = typeof getOverlayEl === 'function' ? getOverlayEl() : null;
    if (overlay) {
      overlay.innerHTML = '';
    }
    setVisible(false);
  }

  if (typeof window !== 'undefined' && !window._royGamepadMsgBound) {
    window._royGamepadMsgBound = true;
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      if (!d || d.type !== 'roy-gamepad-config') return;
      const iframe = typeof getIframeEl === 'function' ? getIframeEl() : null;
      if (iframe && iframe.contentWindow && e.source === iframe.contentWindow) {
        setConfig(d);
      }
    });
  }

  function setVisible(show) {
    active = !!show;
    const overlay = typeof getOverlayEl === 'function' ? getOverlayEl() : null;
    if (overlay) {
      if (!active) {
        releaseAll();
        overlay.style.display = 'none';
      } else {
        if (!overlay.innerHTML.trim()) renderMarkup(overlay);
        overlay.style.display = 'flex';
      }
    }
    if (typeof onVisibilityChange === 'function') {
      try { onVisibilityChange(active); } catch (_) {}
    }
    return active;
  }

  function toggle() {
    return setVisible(!active);
  }

  function isVisible() {
    return active;
  }

  return { setVisible, toggle, isVisible, releaseAll, setConfig, resetConfig };
}
