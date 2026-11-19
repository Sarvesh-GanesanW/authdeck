// A Node stand-in for the parts of expo-file-system's File/Directory/Paths API the app uses, over
// a fresh temporary folder. Registered by test/native.ts. `faults` lets a test crash a write.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'authdeck-fs-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

/**
 * `tearNext(match, keep)`: the next write to a file whose name matches writes only the first
 * `keep` characters, then throws as a crash would. `failNext(match)`: it throws before writing.
 */
const faults = {
  pending: [],
  tearNext(match, keep) {
    this.pending.push({ match, keep });
  },
  failNext(match) {
    this.pending.push({ match, keep: 0 });
  },
  take(name) {
    const i = this.pending.findIndex((f) => (f.match instanceof RegExp ? f.match.test(name) : f.match === name));
    return i < 0 ? null : this.pending.splice(i, 1)[0];
  },
  writes: 0,
};

function joined(parts) {
  return path.join(...parts.map((part) => (typeof part === 'string' ? part.replace(/^file:\/\//, '') : part.path)));
}

class Directory {
  constructor(...parts) {
    this.path = joined(parts);
  }
  get uri() {
    return `file://${this.path}`;
  }
  get name() {
    return path.basename(this.path);
  }
  get exists() {
    return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
  }
  create(options = {}) {
    if (this.exists && options.idempotent) return;
    fs.mkdirSync(this.path, { recursive: Boolean(options.intermediates) });
  }
  delete() {
    fs.rmSync(this.path, { recursive: true });
  }
  list() {
    return fs.readdirSync(this.path).map((name) => {
      const full = path.join(this.path, name);
      return fs.statSync(full).isDirectory() ? new Directory(full) : new File(full);
    });
  }
}

class File {
  constructor(...parts) {
    this.path = joined(parts);
  }
  get uri() {
    return `file://${this.path}`;
  }
  get name() {
    return path.basename(this.path);
  }
  get exists() {
    return fs.existsSync(this.path) && fs.statSync(this.path).isFile();
  }
  async text() {
    return fs.readFileSync(this.path, 'utf8');
  }
  textSync() {
    return fs.readFileSync(this.path, 'utf8');
  }
  async write(content, options = {}) {
    this.writeSync(content, options);
  }
  writeSync(content, options = {}) {
    faults.writes++;
    const fault = faults.take(this.name);
    const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    const write = options.append ? fs.appendFileSync : fs.writeFileSync;
    if (fault) {
      if (fault.keep > 0) write(this.path, text.slice(0, fault.keep));
      throw new Error(`Simulated crash while writing ${this.name}`);
    }
    write(this.path, text);
  }
  delete() {
    fs.rmSync(this.path);
  }
  create() {
    fs.writeFileSync(this.path, '');
  }
}

const Paths = {
  get document() {
    return new Directory(path.join(root, 'document'));
  },
  get cache() {
    return new Directory(path.join(root, 'cache'));
  },
};

module.exports = { File, Directory, Paths, faults, root };
