import { screen, clipboard, systemPreferences } from 'electron';
import { RemoteInputEvent } from '../shared/types';

// Windows Mouse Flags
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;

// Windows Keyboard Flags
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;

// macOS CGEvent Constants
const kCGHIDEventTap = 0;
const kCGEventLeftMouseDown = 1;
const kCGEventLeftMouseUp = 2;
const kCGEventRightMouseDown = 3;
const kCGEventRightMouseUp = 4;
const kCGEventMouseMoved = 5;
const kCGEventLeftMouseDragged = 6;
const kCGEventRightMouseDragged = 7;
const kCGEventOtherMouseDown = 25;
const kCGEventOtherMouseUp = 26;
const kCGEventOtherMouseDragged = 27;
const kCGScrollEventUnitPixel = 0;
const kCGEventFlagMaskShift = 0x20000;
const kCGEventFlagMaskControl = 0x40000;
const kCGEventFlagMaskAlternate = 0x80000;
const kCGEventFlagMaskCommand = 0x100000;

interface ModifierState {
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

function macModifierFlags(m: ModifierState): number {
  return (
    (m.shiftKey ? kCGEventFlagMaskShift : 0) |
    (m.ctrlKey ? kCGEventFlagMaskControl : 0) |
    (m.altKey ? kCGEventFlagMaskAlternate : 0) |
    (m.metaKey ? kCGEventFlagMaskCommand : 0)
  );
}

// Extended keys on Windows that require KEYEVENTF_EXTENDEDKEY
const WIN_EXTENDED_VKS = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // PgUp, PgDn, End, Home, Arrows
  0x2d, 0x2e, // Insert, Delete
  0x5b, 0x5c, // LWin, RWin
  0xa3, 0xa5, // RControl, RMenu
]);

// DOM Event.code -> macOS Quartz Virtual Keycode (kVK_*)
const CODE_TO_MAC_VK: Record<string, number> = {
  KeyA: 0x00, KeyS: 0x01, KeyD: 0x02, KeyF: 0x03, KeyH: 0x04, KeyG: 0x05, KeyZ: 0x06, KeyX: 0x07,
  KeyC: 0x08, KeyV: 0x09, KeyB: 0x0b, KeyQ: 0x0c, KeyW: 0x0d, KeyE: 0x0e, KeyR: 0x0f, KeyY: 0x10,
  KeyT: 0x11, Digit1: 0x12, Digit2: 0x13, Digit3: 0x14, Digit4: 0x15, Digit6: 0x16, Digit5: 0x17,
  Equal: 0x18, Digit9: 0x19, Digit7: 0x1a, Minus: 0x1b, Digit8: 0x1c, Digit0: 0x1d, BracketRight: 0x1e,
  KeyO: 0x1f, KeyU: 0x20, BracketLeft: 0x21, KeyI: 0x22, KeyP: 0x23, Enter: 0x24, KeyL: 0x25,
  KeyJ: 0x26, Quote: 0x27, KeyK: 0x28, Semicolon: 0x29, Backslash: 0x2a, Comma: 0x2b, Slash: 0x2c,
  KeyN: 0x2d, KeyM: 0x2e, Period: 0x2f, Tab: 0x30, Space: 0x31, Backquote: 0x32, Backspace: 0x33,
  Escape: 0x35, MetaLeft: 0x37, MetaRight: 0x36, ShiftLeft: 0x38, CapsLock: 0x39, AltLeft: 0x3a,
  ControlLeft: 0x3b, ShiftRight: 0x3c, AltRight: 0x3d, ControlRight: 0x3e,
  F17: 0x40, NumpadDecimal: 0x41, NumpadMultiply: 0x43, NumpadAdd: 0x45, NumLock: 0x47,
  NumpadDivide: 0x4b, NumpadEnter: 0x4c, NumpadSubtract: 0x4e,
  Numpad0: 0x52, Numpad1: 0x53, Numpad2: 0x54, Numpad3: 0x55, Numpad4: 0x56,
  Numpad5: 0x57, Numpad6: 0x58, Numpad7: 0x59, Numpad8: 0x5b, Numpad9: 0x5c,
  F5: 0x60, F6: 0x61, F7: 0x62, F3: 0x63, F8: 0x64, F9: 0x65, F11: 0x67,
  F13: 0x69, F14: 0x6b, F10: 0x6d, F12: 0x6f, F15: 0x71, Help: 0x72, Home: 0x73,
  PageUp: 0x74, Delete: 0x75, F4: 0x76, End: 0x77, F2: 0x78, PageDown: 0x79, F1: 0x7a,
  ArrowLeft: 0x7b, ArrowRight: 0x7c, ArrowDown: 0x7d, ArrowUp: 0x7e,
};

// DOM Event.code -> Windows Virtual Keycode (VK_*)
const CODE_TO_WIN_VK: Record<string, number> = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, NumpadEnter: 0x0d,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3,
  AltLeft: 0xa4, AltRight: 0xa5, Pause: 0x13, CapsLock: 0x14, Escape: 0x1b,
  Space: 0x20, PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  PrintScreen: 0x2c, Insert: 0x2d, Delete: 0x2e,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46,
  KeyG: 0x47, KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4a, KeyK: 0x4b, KeyL: 0x4c,
  KeyM: 0x4d, KeyN: 0x4e, KeyO: 0x4f, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52,
  KeyS: 0x53, KeyT: 0x54, KeyU: 0x55, KeyV: 0x56, KeyW: 0x57, KeyX: 0x58,
  KeyY: 0x59, KeyZ: 0x5a,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  NumLock: 0x90, ScrollLock: 0x91,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe,
  Slash: 0xbf, Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde,
};

export class InputController {
  private winSetCursorPos: ((x: number, y: number) => boolean) | null = null;
  private winMouseEvent: ((flags: number, dx: number, dy: number, data: number, extra: number) => void) | null = null;
  private winKeybdEvent: ((vk: number, scan: number, flags: number, extra: number) => void) | null = null;
  private winMapVirtualKey: ((code: number, mapType: number) => number) | null = null;

  private macCreateMouseEvent: ((source: null, type: number, pos: { x: number; y: number }, btn: number) => unknown) | null = null;
  private macCreateKeyboardEvent: ((source: null, vk: number, keyDown: boolean) => unknown) | null = null;
  private macCreateScrollEvent: ((source: null, units: number, wheelCount: number, wheel1: number, wheel2: number, wheel3: number) => unknown) | null = null;
  private macPostEvent: ((tap: number, ev: unknown) => void) | null = null;
  private macCFRelease: ((cf: unknown) => void) | null = null;
  private macSetFlags: ((ev: unknown, flags: number) => void) | null = null;

  private lastMousePos = { x: 0, y: 0 };
  private buttonsDown = { left: false, middle: false, right: false };
  // Keys currently held down remotely (code -> keyCode), released if the session ends mid-press
  private keysDown = new Map<string, number>();

  constructor() {
    this.initNativeBindings();
  }

  private initNativeBindings(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const koffi = require('koffi');

      if (process.platform === 'win32') {
        const user32 = koffi.load('user32.dll');
        this.winSetCursorPos = user32.func('bool __stdcall SetCursorPos(int X, int Y)');
        this.winMouseEvent = user32.func(
          'void __stdcall mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, int32_t dwData, uintptr_t dwExtraInfo)'
        );
        this.winKeybdEvent = user32.func(
          'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'
        );
        this.winMapVirtualKey = user32.func(
          'uint32_t __stdcall MapVirtualKeyW(uint32_t uCode, uint32_t uMapType)'
        );
        console.log('[InputController] Loaded ultra-low-latency Windows user32.dll FFI');
      } else if (process.platform === 'darwin') {
        const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
        const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
        koffi.struct('CGPoint', { x: 'double', y: 'double' });

        this.macCreateMouseEvent = cg.func(
          'void* CGEventCreateMouseEvent(void* source, uint32_t mouseType, CGPoint mouseCursorPosition, uint32_t mouseButton)'
        );
        this.macCreateKeyboardEvent = cg.func(
          'void* CGEventCreateKeyboardEvent(void* source, uint16_t virtualKey, bool keyDown)'
        );
        this.macCreateScrollEvent = cg.func(
          'void* CGEventCreateScrollWheelEvent2(void* source, uint32_t units, uint32_t wheelCount, int32_t wheel1, int32_t wheel2, int32_t wheel3)'
        );
        this.macPostEvent = cg.func('void CGEventPost(uint32_t tap, void* event)');
        this.macSetFlags = cg.func('void CGEventSetFlags(void* event, uint64_t flags)');
        this.macCFRelease = cf.func('void CFRelease(void* cf)');
        console.log('[InputController] Loaded ultra-low-latency macOS CoreGraphics FFI');
      }
    } catch (err) {
      console.error('[InputController] Failed to load native FFI:', err);
    }
  }

  public checkMacPermissions(promptUser = false): { accessibility: boolean; screen: boolean } {
    if (process.platform !== 'darwin') {
      return { accessibility: true, screen: true };
    }
    const accessibility = systemPreferences.isTrustedAccessibilityClient(promptUser);
    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    return {
      accessibility,
      screen: screenStatus === 'granted',
    };
  }

  private resolveScreenCoordinates(normX: number, normY: number, displayId?: string): { x: number; y: number } {
    const clampedX = Math.max(0, Math.min(1, normX));
    const clampedY = Math.max(0, Math.min(1, normY));

    const displays = screen.getAllDisplays();
    let targetDisplay = screen.getPrimaryDisplay();

    if (displayId) {
      const found = displays.find((d) => String(d.id) === String(displayId));
      if (found) targetDisplay = found;
    }

    const dipX = targetDisplay.bounds.x + clampedX * targetDisplay.bounds.width;
    const dipY = targetDisplay.bounds.y + clampedY * targetDisplay.bounds.height;

    if (process.platform === 'win32') {
      try {
        const physPt = screen.dipToScreenPoint({ x: Math.round(dipX), y: Math.round(dipY) });
        return { x: physPt.x, y: physPt.y };
      } catch {
        return {
          x: Math.round(dipX * targetDisplay.scaleFactor),
          y: Math.round(dipY * targetDisplay.scaleFactor),
        };
      }
    }

    // macOS Quartz uses logical DIP points directly
    return { x: dipX, y: dipY };
  }

  public handleEvent(event: RemoteInputEvent, allowClipboard = true): void {
    try {
      switch (event.type) {
        case 'mousemove': {
          const pt = this.resolveScreenCoordinates(event.x, event.y, event.displayId);
          this.lastMousePos = pt;
          this.moveMouse(pt.x, pt.y);
          break;
        }
        case 'mousedown':
        case 'mouseup': {
          const pt = this.resolveScreenCoordinates(event.x, event.y, event.displayId);
          this.lastMousePos = pt;
          this.moveMouse(pt.x, pt.y);
          this.mouseButton(event.button, event.type === 'mousedown', pt.x, pt.y, event);
          break;
        }
        case 'wheel': {
          this.scrollWheel(event.deltaX, event.deltaY);
          break;
        }
        case 'keydown':
        case 'keyup': {
          this.keyboardEvent(event.code, event.keyCode, event.type === 'keydown', event);
          break;
        }
        case 'special-combo': {
          this.triggerSpecialCombo(event.combo);
          break;
        }
        case 'clipboard-set': {
          if (allowClipboard && typeof event.text === 'string') {
            clipboard.writeText(event.text);
          }
          break;
        }
      }
    } catch (err) {
      console.error('[InputController] Error handling input event:', err);
    }
  }

  private moveMouse(x: number, y: number): void {
    if (process.platform === 'win32' && this.winSetCursorPos) {
      this.winSetCursorPos(Math.round(x), Math.round(y));
    } else if (process.platform === 'darwin' && this.macCreateMouseEvent && this.macPostEvent && this.macCFRelease) {
      let eventType = kCGEventMouseMoved;
      let btn = 0;
      if (this.buttonsDown.left) {
        eventType = kCGEventLeftMouseDragged;
        btn = 0;
      } else if (this.buttonsDown.right) {
        eventType = kCGEventRightMouseDragged;
        btn = 1;
      } else if (this.buttonsDown.middle) {
        eventType = kCGEventOtherMouseDragged;
        btn = 2;
      }
      const ev = this.macCreateMouseEvent(null, eventType, { x, y }, btn);
      if (ev) {
        this.macPostEvent(kCGHIDEventTap, ev);
        this.macCFRelease(ev);
      }
    }
  }

  private mouseButton(
    button: 'left' | 'middle' | 'right',
    isDown: boolean,
    x: number,
    y: number,
    modifiers?: ModifierState
  ): void {
    this.buttonsDown[button] = isDown;

    if (process.platform === 'win32' && this.winMouseEvent) {
      let flag = 0;
      if (button === 'left') flag = isDown ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
      else if (button === 'right') flag = isDown ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
      else if (button === 'middle') flag = isDown ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;

      if (flag !== 0) {
        this.winMouseEvent(flag, 0, 0, 0, 0);
      }
    } else if (process.platform === 'darwin' && this.macCreateMouseEvent && this.macPostEvent && this.macCFRelease) {
      let type = kCGEventLeftMouseDown;
      let btnIndex = 0;
      if (button === 'left') {
        type = isDown ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
        btnIndex = 0;
      } else if (button === 'right') {
        type = isDown ? kCGEventRightMouseDown : kCGEventRightMouseUp;
        btnIndex = 1;
      } else {
        type = isDown ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
        btnIndex = 2;
      }
      const ev = this.macCreateMouseEvent(null, type, { x, y }, btnIndex);
      if (ev) {
        if (modifiers && this.macSetFlags) this.macSetFlags(ev, macModifierFlags(modifiers));
        this.macPostEvent(kCGHIDEventTap, ev);
        this.macCFRelease(ev);
      }
    }
  }

  private scrollWheel(deltaX: number, deltaY: number): void {
    if (process.platform === 'win32' && this.winMouseEvent) {
      if (deltaY !== 0) {
        // Browser wheel deltaY > 0 means scroll down; Windows WHEEL_DELTA is -120 for down
        const winDeltaY = Math.round(-deltaY * 1.2);
        this.winMouseEvent(MOUSEEVENTF_WHEEL, 0, 0, winDeltaY, 0);
      }
      if (deltaX !== 0) {
        const winDeltaX = Math.round(deltaX * 1.2);
        this.winMouseEvent(MOUSEEVENTF_HWHEEL, 0, 0, winDeltaX, 0);
      }
    } else if (process.platform === 'darwin' && this.macCreateScrollEvent && this.macPostEvent && this.macCFRelease) {
      const macY = Math.round(-deltaY);
      const macX = Math.round(-deltaX);
      const ev = this.macCreateScrollEvent(null, kCGScrollEventUnitPixel, 2, macY, macX, 0);
      if (ev) {
        this.macPostEvent(kCGHIDEventTap, ev);
        this.macCFRelease(ev);
      }
    }
  }

  private keyboardEvent(code: string, keyCode: number, isDown: boolean, modifiers?: ModifierState): void {
    if (isDown) this.keysDown.set(code, keyCode);
    else this.keysDown.delete(code);

    if (process.platform === 'win32' && this.winKeybdEvent) {
      const vk = CODE_TO_WIN_VK[code] || keyCode;
      if (!vk) return;
      const scan = this.winMapVirtualKey ? this.winMapVirtualKey(vk, 0) : 0;
      let flags = isDown ? 0 : KEYEVENTF_KEYUP;
      if (WIN_EXTENDED_VKS.has(vk)) {
        flags |= KEYEVENTF_EXTENDEDKEY;
      }
      this.winKeybdEvent(vk, scan, flags, 0);
    } else if (process.platform === 'darwin' && this.macCreateKeyboardEvent && this.macPostEvent && this.macCFRelease) {
      const macVk = CODE_TO_MAC_VK[code];
      if (macVk === undefined) {
        console.warn(`[InputController] No macOS keycode for "${code}" (keyCode ${keyCode})`);
        return;
      }
      const ev = this.macCreateKeyboardEvent(null, macVk, isDown);
      if (ev) {
        // Stamp the viewer's real modifier state on every event: otherwise a modifier whose keyup was
        // lost (Win/Alt+Tab steal focus on the viewer) stays "held" in macOS, so every letter becomes
        // a ⌘-shortcut and nothing can be typed (⌘Q even quits SwiftDesk itself)
        if (modifiers && this.macSetFlags) this.macSetFlags(ev, macModifierFlags(modifiers));
        this.macPostEvent(kCGHIDEventTap, ev);
        this.macCFRelease(ev);
      }
    }
  }

  private triggerSpecialCombo(combo: string): void {
    if (combo === 'alt-tab' && process.platform === 'darwin') {
      // The macOS app switcher is ⌘Tab
      this.keyboardEvent('MetaLeft', 91, true, { metaKey: true });
      this.keyboardEvent('Tab', 9, true, { metaKey: true });
      setTimeout(() => {
        this.keyboardEvent('Tab', 9, false, { metaKey: true });
        this.keyboardEvent('MetaLeft', 91, false, {});
      }, 60);
    } else if (combo === 'alt-tab') {
      this.keyboardEvent('AltLeft', 18, true);
      this.keyboardEvent('Tab', 9, true);
      setTimeout(() => {
        this.keyboardEvent('Tab', 9, false);
        this.keyboardEvent('AltLeft', 18, false);
      }, 60);
    } else if (combo === 'win-key') {
      this.keyboardEvent('MetaLeft', 91, true);
      setTimeout(() => this.keyboardEvent('MetaLeft', 91, false), 60);
    } else if (combo === 'task-manager') {
      if (process.platform === 'win32') {
        this.keyboardEvent('ControlLeft', 17, true);
        this.keyboardEvent('ShiftLeft', 16, true);
        this.keyboardEvent('Escape', 27, true);
        setTimeout(() => {
          this.keyboardEvent('Escape', 27, false);
          this.keyboardEvent('ShiftLeft', 16, false);
          this.keyboardEvent('ControlLeft', 17, false);
        }, 60);
      } else if (process.platform === 'darwin') {
        this.keyboardEvent('MetaLeft', 91, true);
        this.keyboardEvent('AltLeft', 18, true);
        this.keyboardEvent('Escape', 27, true);
        setTimeout(() => {
          this.keyboardEvent('Escape', 27, false);
          this.keyboardEvent('AltLeft', 18, false);
          this.keyboardEvent('MetaLeft', 91, false);
        }, 60);
      }
    }
  }

  public releaseAllInputs(): void {
    if (this.buttonsDown.left) this.mouseButton('left', false, this.lastMousePos.x, this.lastMousePos.y);
    if (this.buttonsDown.right) this.mouseButton('right', false, this.lastMousePos.x, this.lastMousePos.y);
    if (this.buttonsDown.middle) this.mouseButton('middle', false, this.lastMousePos.x, this.lastMousePos.y);
    // A key left held after the session ends (e.g. ⌘) would keep hijacking the host's own keyboard
    const held = [...this.keysDown.entries()];
    if (held.length > 0) {
      console.log(`[InputController] Releasing held keys: ${held.map(([code]) => code).join(', ')}`);
    }
    for (const [code, keyCode] of held) {
      this.keyboardEvent(code, keyCode, false, {});
    }
  }
}
