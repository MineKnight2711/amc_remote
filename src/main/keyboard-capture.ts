/**
 * Windows global keyboard pass-through (like RDP / AnyDesk): while the viewer window is focused and
 * capture is on, every key — including OS-reserved combos the window never normally sees (Win+C,
 * Win+V, Alt+Tab, Ctrl+Esc...) — is swallowed system-wide with a low-level keyboard hook and
 * forwarded to the remote machine instead.
 *
 * Escape hatch: the mouse is never captured, so clicking another window blurs the viewer and releases
 * the keyboard at once. Ctrl+Alt+Del and Win+L cannot be hooked by design, so they always work too.
 */

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const LLKHF_EXTENDED = 0x01;
const LLKHF_INJECTED = 0x10;

export interface CapturedKey {
  code: string;
  keyCode: number; // Windows virtual-key code
  isDown: boolean;
}

// Windows virtual-key code -> DOM code. The low-level hook reports left/right modifiers distinctly.
const VK_TO_CODE: Record<number, string> = {
  0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x1b: 'Escape', 0x20: 'Space',
  0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home',
  0x25: 'ArrowLeft', 0x26: 'ArrowUp', 0x27: 'ArrowRight', 0x28: 'ArrowDown',
  0x2c: 'PrintScreen', 0x2d: 'Insert', 0x2e: 'Delete',
  0x5b: 'MetaLeft', 0x5c: 'MetaRight', 0x5d: 'ContextMenu',
  0x6a: 'NumpadMultiply', 0x6b: 'NumpadAdd', 0x6d: 'NumpadSubtract', 0x6e: 'NumpadDecimal', 0x6f: 'NumpadDivide',
  0x90: 'NumLock', 0x91: 'ScrollLock',
  0x10: 'ShiftLeft', 0x11: 'ControlLeft', 0x12: 'AltLeft', // generic fallbacks
  0xa0: 'ShiftLeft', 0xa1: 'ShiftRight', 0xa2: 'ControlLeft', 0xa3: 'ControlRight', 0xa4: 'AltLeft', 0xa5: 'AltRight',
  0xba: 'Semicolon', 0xbb: 'Equal', 0xbc: 'Comma', 0xbd: 'Minus', 0xbe: 'Period', 0xbf: 'Slash',
  0xc0: 'Backquote', 0xdb: 'BracketLeft', 0xdc: 'Backslash', 0xdd: 'BracketRight', 0xde: 'Quote',
};

function vkToDomCode(vk: number, extended: boolean): string {
  if (vk === 0x0d && extended) return 'NumpadEnter';
  if (vk >= 0x41 && vk <= 0x5a) return `Key${String.fromCharCode(vk)}`;
  if (vk >= 0x30 && vk <= 0x39) return `Digit${vk - 0x30}`;
  if (vk >= 0x60 && vk <= 0x69) return `Numpad${vk - 0x60}`;
  if (vk >= 0x70 && vk <= 0x7b) return `F${vk - 0x6f}`;
  return VK_TO_CODE[vk] || '';
}

export class KeyboardCapture {
  private available = false;
  private capturing = false;
  private hook: unknown = null;
  private callbackPtr: unknown = null;
  private koffi: any = null;
  private fnSetHook: ((idHook: number, lpfn: unknown, hmod: unknown, threadId: number) => unknown) | null = null;
  private fnCallNext: ((hhk: unknown, nCode: number, wParam: number | bigint, lParam: unknown) => number | bigint) | null = null;
  private fnUnhook: ((hhk: unknown) => boolean) | null = null;
  private kbdStruct: unknown = null;

  constructor(private readonly onKey: (key: CapturedKey) => void) {
    if (process.platform !== 'win32') return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const koffi = require('koffi');
      this.koffi = koffi;
      const user32 = koffi.load('user32.dll');
      this.kbdStruct = koffi.struct('KBDLLHOOKSTRUCT_CAP', {
        vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
      });
      const HOOKPROC = koffi.proto('intptr_t __stdcall SwiftKbHook(int code, uintptr_t wParam, void* lParam)');
      this.fnSetHook = user32.func('void* __stdcall SetWindowsHookExW(int idHook, void* lpfn, void* hmod, uint32_t dwThreadId)');
      this.fnCallNext = user32.func('intptr_t __stdcall CallNextHookEx(void* hhk, int nCode, uintptr_t wParam, void* lParam)');
      this.fnUnhook = user32.func('bool __stdcall UnhookWindowsHookEx(void* hhk)');
      this.callbackPtr = koffi.register((code: number, wParam: number | bigint, lParam: unknown) => {
        return this.handleHook(code, wParam, lParam);
      }, koffi.pointer(HOOKPROC));
      this.available = true;
    } catch (err) {
      console.warn('[KeyboardCapture] Unavailable:', (err as Error).message);
    }
  }

  public isAvailable(): boolean {
    return this.available;
  }

  /** Installs the hook lazily on first enable; keeps it installed but only suppresses while capturing. */
  public setCapturing(on: boolean): void {
    if (!this.available) return;
    if (on && !this.hook) {
      try {
        this.hook = this.fnSetHook!(WH_KEYBOARD_LL, this.callbackPtr, null, 0);
        if (!this.hook) console.warn('[KeyboardCapture] SetWindowsHookEx returned null');
        else console.log('[KeyboardCapture] Hook installed');
      } catch (err) {
        console.warn('[KeyboardCapture] Install failed:', (err as Error).message);
        this.available = false;
        return;
      }
    }
    this.capturing = on && !!this.hook;
  }

  public dispose(): void {
    this.capturing = false;
    if (this.hook && this.fnUnhook) {
      try {
        this.fnUnhook(this.hook);
      } catch {}
      this.hook = null;
    }
  }

  private handleHook(code: number, wParam: number | bigint, lParam: unknown): number | bigint {
    const passThrough = () => this.fnCallNext!(null, code, wParam, lParam);
    try {
      if (code !== 0 || !this.capturing) return passThrough();
      const ks: any = this.koffi.decode(lParam, this.kbdStruct);
      if (ks.flags & LLKHF_INJECTED) return passThrough(); // leave synthetic keys (IME, macros) alone
      const w = Number(wParam);
      const isDown = w === WM_KEYDOWN || w === WM_SYSKEYDOWN;
      const isUp = w === WM_KEYUP || w === WM_SYSKEYUP;
      if (!isDown && !isUp) return passThrough();
      const domCode = vkToDomCode(ks.vkCode, !!(ks.flags & LLKHF_EXTENDED));
      // Unknown key: let Windows handle it rather than swallowing a key we can't forward
      if (!domCode) return passThrough();
      this.onKey({ code: domCode, keyCode: ks.vkCode, isDown });
      return 1; // swallow: the focused viewer window (and the OS) never sees this key
    } catch (err) {
      console.warn('[KeyboardCapture] Hook error:', (err as Error).message);
      return passThrough();
    }
  }
}
