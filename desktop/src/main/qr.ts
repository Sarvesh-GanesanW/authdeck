import { qrModules } from '../../../agent/src/banner';
import type { QrImage } from '../shared/state';

/** One SVG path for the dark modules, drawn as horizontal runs to keep the path short. */
export function qrImage(text: string): QrImage {
  const modules = qrModules(text);
  const runs: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (row[x]) x += 1;
      runs.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  });
  return { size: modules.length, path: runs.join('') };
}
