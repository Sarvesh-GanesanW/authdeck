import fs from 'node:fs/promises';
import { runProcess } from '../proc';

export const ICON_SIZE = 128;

/**
 * JXA run by `osascript -l JavaScript -e <script> -- <jobs json>`. NSWorkspace renders every kind of
 * app icon (including asset-catalog icons with no .icns) into a 128×128 PNG written to `dest`.
 * Jobs travel as an argv item, so no path is ever spliced into the script.
 * 2 = NSCompositingOperationSourceOver (the enum constant is not bridged in JXA).
 */
const MAC_ICON_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const jobs = JSON.parse(argv[0]);
  const size = ${ICON_SIZE};
  return JSON.stringify(jobs.map((job) => {
    try {
      const image = $.NSWorkspace.sharedWorkspace.iconForFile(job.src);
      const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
      rep.size = $.NSMakeSize(size, size);
      $.NSGraphicsContext.saveGraphicsState;
      $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
      image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, 2, 1.0);
      $.NSGraphicsContext.restoreGraphicsState;
      const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
      return png.writeToFileAtomically(job.dest, true) ? true : false;
    } catch (e) {
      return false;
    }
  }));
}
`;

export interface IconJob {
  /** App bundle to render. */
  src: string;
  /** PNG file to write. */
  dest: string;
}

function macIconCommand(jobs: readonly IconJob[]): { cmd: string; args: string[] } {
  return { cmd: 'osascript', args: ['-l', 'JavaScript', '-e', MAC_ICON_SCRIPT, '--', JSON.stringify(jobs)] };
}

/** Renders icons for several bundles in one osascript run; returns which jobs produced a file. */
export async function renderMacIcons(jobs: readonly IconJob[]): Promise<boolean[]> {
  // A symlinked bundle (e.g. /Applications/Safari.app) would get an alias arrow badge.
  const resolved = await Promise.all(jobs.map(async (job) => ({ ...job, src: await fs.realpath(job.src).catch(() => job.src) })));
  const { cmd, args } = macIconCommand(resolved);
  const outcome = await runProcess(cmd, args, { timeoutMs: 60_000, tailChars: 2000 });
  if (outcome.exitCode !== 0) throw new Error(`osascript could not render icons: ${outcome.stderr.trim()}`);
  return JSON.parse(outcome.stdout) as boolean[];
}
