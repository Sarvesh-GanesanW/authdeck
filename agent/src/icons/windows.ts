import { powerShellEmitJson, powerShellJsonLiteral, runPowerShellJson } from '../platform/powershell';
import { ICON_SIZE } from './mac';

const RENDER_TIMEOUT_MS = 60_000;

/**
 * C# compiled by Add-Type. IShellItemImageFactory gives crisp, large icons for .lnk files and for
 * packaged apps via "shell:AppsFolder\<AUMID>"; ExtractAssociatedIcon (32 px) is the fallback.
 * Image.FromHbitmap drops alpha, so the 32-bit bits are re-read as premultiplied ARGB.
 */
const WINDOWS_ICON_SOURCE = String.raw`
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class AuthDeckIcons {
  [StructLayout(LayoutKind.Sequential)]
  struct SIZE { public int cx; public int cy; }

  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory {
    [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc,
    [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
    [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr hObject);

  const int SIIGBF_BIGGERSIZEOK = 0x1;
  const int SIIGBF_ICONONLY = 0x4;

  public static string Png(string path, int size) {
    Bitmap bmp = null;
    try { bmp = FromShell(path, size); } catch { bmp = null; }
    if (bmp == null && File.Exists(path)) {
      try {
        using (Icon icon = Icon.ExtractAssociatedIcon(path)) { if (icon != null) bmp = icon.ToBitmap(); }
      } catch { bmp = null; }
    }
    if (bmp == null) return null;
    // Never more than the size asked for: the app takes icons up to 256 pixels a side.
    if (bmp.Width > size || bmp.Height > size) {
      Bitmap scaled = new Bitmap(bmp, new Size(Math.Min(bmp.Width, size), Math.Min(bmp.Height, size)));
      bmp.Dispose();
      bmp = scaled;
    }
    using (bmp)
    using (MemoryStream ms = new MemoryStream()) {
      bmp.Save(ms, ImageFormat.Png);
      return Convert.ToBase64String(ms.ToArray());
    }
  }

  static Bitmap FromShell(string path, int size) {
    IShellItemImageFactory factory;
    SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out factory);
    IntPtr hbm;
    SIZE wanted;
    wanted.cx = size;
    wanted.cy = size;
    int hr = factory.GetImage(wanted, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK, out hbm);
    Marshal.ReleaseComObject(factory);
    if (hr != 0 || hbm == IntPtr.Zero) return null;
    try { return WithAlpha(hbm); } finally { DeleteObject(hbm); }
  }

  static Bitmap WithAlpha(IntPtr hbm) {
    using (Bitmap opaque = Image.FromHbitmap(hbm)) {
      if (Image.GetPixelFormatSize(opaque.PixelFormat) != 32) return new Bitmap(opaque);
      Rectangle rect = new Rectangle(0, 0, opaque.Width, opaque.Height);
      BitmapData data = opaque.LockBits(rect, ImageLockMode.ReadOnly, opaque.PixelFormat);
      byte[] bits = new byte[Math.Abs(data.Stride) * data.Height];
      int stride = data.Stride;
      Marshal.Copy(data.Scan0, bits, 0, bits.Length);
      opaque.UnlockBits(data);

      bool hasAlpha = false;
      for (int i = 3; i < bits.Length; i += 4) { if (bits[i] != 0) { hasAlpha = true; break; } }
      if (!hasAlpha) return new Bitmap(opaque);

      using (Bitmap premultiplied = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppPArgb)) {
        BitmapData target = premultiplied.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        for (int y = 0; y < rect.Height; y++) {
          Marshal.Copy(bits, y * Math.Abs(stride), IntPtr.Add(target.Scan0, y * target.Stride), rect.Width * 4);
        }
        premultiplied.UnlockBits(target);
        Bitmap straight = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(straight)) {
          g.DrawImage(premultiplied, rect, rect, GraphicsUnit.Pixel);
        }
        return straight;
      }
    }
  }
}
`;

export interface WindowsIconJob {
  /** .lnk path, or "shell:AppsFolder\<AUMID>" for packaged apps. */
  path: string;
}

/** One PowerShell run rendering every job; returns base64 PNGs (or null) in job order. */
export function windowsIconScript(jobs: readonly WindowsIconJob[]): string {
  return `
$ErrorActionPreference = 'Stop'
$source = @'
${WINDOWS_ICON_SOURCE}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing
$request = ${powerShellJsonLiteral({ jobs })}
$pngs = New-Object System.Collections.Generic.List[object]
foreach ($job in $request.jobs) {
  $png = $null
  try { $png = [AuthDeckIcons]::Png([string]$job.path, ${ICON_SIZE}) } catch { $png = $null }
  $pngs.Add($png)
}
${powerShellEmitJson('@{ pngs = $pngs.ToArray() }')}
`;
}

export function aumidShellPath(aumid: string): string {
  return `shell:AppsFolder\\${aumid}`;
}

export async function renderWindowsIcons(jobs: readonly WindowsIconJob[]): Promise<(string | null)[]> {
  const output = (await runPowerShellJson(windowsIconScript(jobs), RENDER_TIMEOUT_MS)) as { pngs?: (string | null)[] | null };
  return jobs.map((_, index) => output.pngs?.[index] ?? null);
}
