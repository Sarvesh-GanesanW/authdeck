/**
 * C# for the persistent Windows helper: SendInput for keys and text, the foreground app, and
 * raising an app's window. Compiled once by Add-Type when the helper starts.
 */
export const WIN_HELPER_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public class AuthDeckWindowApp {
  public string Exe;
  public string Aumid;
  public string Name;
}

public static class AuthDeckNative {
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const ushort VK_RETURN = 0x0D;
  const ushort VK_TAB = 0x09;
  const ushort VK_MENU = 0x12;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int SW_RESTORE = 9;

  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  // The union must be as large as MOUSEINPUT or SendInput rejects the array on 64-bit Windows.
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr hProcess, uint flags, StringBuilder exeName, ref uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr hProcess, ref uint length, StringBuilder id);

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = flags;
    return input;
  }

  static bool IsExtended(int vk) {
    // Navigation keys, Delete/Insert and the Windows keys live on the extended part of the keyboard.
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0x90;
  }

  static void AddVk(List<INPUT> inputs, int vk, bool up) {
    uint flags = (IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0);
    inputs.Add(Key((ushort)vk, (ushort)MapVirtualKey((uint)vk, 0), flags));
  }

  static void Send(List<INPUT> inputs) {
    if (inputs.Count == 0) return;
    INPUT[] array = inputs.ToArray();
    uint sent = SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT)));
    if (sent != array.Length) {
      throw new Exception("Windows blocked the key presses (the app in front may be running as administrator).");
    }
  }

  public static void SendKeys(int[] modifiers, int vk) {
    List<INPUT> inputs = new List<INPUT>();
    if (modifiers != null) foreach (int m in modifiers) AddVk(inputs, m, false);
    AddVk(inputs, vk, false);
    AddVk(inputs, vk, true);
    if (modifiers != null) for (int i = modifiers.Length - 1; i >= 0; i--) AddVk(inputs, modifiers[i], true);
    Send(inputs);
  }

  public static void TypeText(string text) {
    List<INPUT> inputs = new List<INPUT>();
    string normalized = text.Replace("\r\n", "\n").Replace('\r', '\n');
    foreach (char c in normalized) {
      if (c == '\n') { AddVk(inputs, VK_RETURN, false); AddVk(inputs, VK_RETURN, true); continue; }
      if (c == '\t') { AddVk(inputs, VK_TAB, false); AddVk(inputs, VK_TAB, true); continue; }
      inputs.Add(Key(0, c, KEYEVENTF_UNICODE));
      inputs.Add(Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    Send(inputs);
  }

  static string ProcessExe(IntPtr process) {
    StringBuilder sb = new StringBuilder(1024);
    uint size = (uint)sb.Capacity;
    return QueryFullProcessImageName(process, 0, sb, ref size) ? sb.ToString() : null;
  }

  static string ProcessAumid(IntPtr process) {
    uint length = 512;
    StringBuilder sb = new StringBuilder((int)length);
    return GetApplicationUserModelId(process, ref length, sb) == 0 ? sb.ToString() : null;
  }

  static AuthDeckWindowApp AppForProcess(uint pid) {
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return null;
    try {
      AuthDeckWindowApp app = new AuthDeckWindowApp();
      app.Exe = ProcessExe(process);
      app.Aumid = ProcessAumid(process);
      app.Name = DescriptionOf(app.Exe);
      return app;
    } finally { CloseHandle(process); }
  }

  static string DescriptionOf(string exe) {
    if (exe == null) return "";
    try {
      string description = FileVersionInfo.GetVersionInfo(exe).FileDescription;
      if (!string.IsNullOrEmpty(description)) return description.Trim();
    } catch { }
    return Path.GetFileNameWithoutExtension(exe);
  }

  // Store apps are hosted in ApplicationFrameHost.exe; the real app owns a child window.
  static AuthDeckWindowApp AppForWindow(IntPtr hwnd) {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    AuthDeckWindowApp app = AppForProcess(pid);
    if (app == null || app.Exe == null || !app.Exe.EndsWith("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) return app;
    AuthDeckWindowApp hosted = null;
    EnumChildWindows(hwnd, delegate (IntPtr child, IntPtr unused) {
      uint childPid;
      GetWindowThreadProcessId(child, out childPid);
      if (childPid != pid) { hosted = AppForProcess(childPid); return false; }
      return true;
    }, IntPtr.Zero);
    return hosted ?? app;
  }

  public static AuthDeckWindowApp Foreground() {
    IntPtr hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero) return null;
    return AppForWindow(hwnd);
  }

  static bool Matches(AuthDeckWindowApp app, string exe, string aumid) {
    if (app == null) return false;
    if (!string.IsNullOrEmpty(aumid) && string.Equals(app.Aumid, aumid, StringComparison.OrdinalIgnoreCase)) return true;
    return !string.IsNullOrEmpty(exe) && string.Equals(app.Exe, exe, StringComparison.OrdinalIgnoreCase);
  }

  /** Raises the first visible top-level window of the app; false when it has none. */
  public static bool Focus(string exe, string aumid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr hwnd, IntPtr unused) {
      if (!IsWindowVisible(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero || GetWindowTextLength(hwnd) == 0) return true; // 4 = GW_OWNER
      if (Matches(AppForWindow(hwnd), exe, aumid)) { found = hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, SW_RESTORE);
    // Windows only lets the process that received the last input change the foreground window;
    // tapping Alt makes this process that one.
    List<INPUT> alt = new List<INPUT>();
    AddVk(alt, VK_MENU, false);
    AddVk(alt, VK_MENU, true);
    Send(alt);
    SetForegroundWindow(found);
    BringWindowToTop(found);
    return true;
  }
}
`;
