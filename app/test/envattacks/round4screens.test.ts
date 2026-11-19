// Security review of env sets (0.4), round 4, screens. A static proof of concept (there is no
// renderer in this suite): it fails while the weakness is there and passes once it is fixed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const SHEET = path.join(__dirname, '../../src/screens/env/EnvJoinApproveSheet.tsx');

describe("ENV-23: the owner's 4th-word pick is answered from the owner's own screen", () => {
  it("the teammate's key words are not drawn on the approve sheet until the word check is done", () => {
    const source = fs.readFileSync(SHEET, 'utf8');
    // Every place the sheet draws the requester's words (request.keyWords) as SixWords.
    const drawn = source.split('\n').filter((line) => /<SixWords\b[^>]*words=\{request\.keyWords\}/.test(line));
    const ungated = drawn.filter((line) => !/check\.matched/.test(line));
    assert.deepEqual(
      ungated.map((line) => line.trim()),
      [],
      'the six words the pick asks about are on screen above the pick, so the pick checks that the owner can read, not what the teammate reads',
    );
  });
});
