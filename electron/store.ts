// Small JSON store with atomic, debounced writes (write temp file + rename),
// so a crash or power loss can never leave a half-written settings file.
import fs from 'node:fs';
import path from 'node:path';

export class JsonStore<T extends object> {
  private data: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    defaults: T,
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    this.data = defaults;
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object') this.data = { ...defaults, ...parsed };
      }
    } catch (err) {
      // Keep the corrupt file for inspection and start fresh.
      onError(err);
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
    }
  }

  get(): T {
    return this.data;
  }

  set(patch: Partial<T>) {
    this.data = { ...this.data, ...patch };
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.onError(err);
    }
  }
}
