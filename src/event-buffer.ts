// ── Event Ring Buffer for CC process observability ──

export interface LogLine {
  ts: number;
  type: 'text' | 'thinking' | 'tool' | 'error' | 'system' | 'user';
  text: string;
}

export interface LogQueryOpts {
  offset?: number;
  limit?: number;
  grep?: string;
  since?: number;  // ms ago
  type?: string;
}

export interface LogQueryResult {
  totalLines: number;
  returnedLines: number;
  offset: number;
  lines: LogLine[];
}

export class EventBuffer {
  private buffer: LogLine[] = [];
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  push(line: LogLine): void {
    this.buffer.push(line);
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxSize);
    }
  }

  query(opts: LogQueryOpts = {}): LogQueryResult {
    let lines = this.buffer;

    if (opts.type) {
      lines = lines.filter(l => l.type === opts.type);
    }

    if (opts.since) {
      const cutoff = Date.now() - opts.since;
      lines = lines.filter(l => l.ts >= cutoff);
    }

    if (opts.grep) {
      try {
        const re = new RegExp(opts.grep, 'i');
        lines = lines.filter(l => re.test(l.text));
      } catch {
        // Invalid regex — skip filter
      }
    }

    const totalLines = lines.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    const sliced = lines.slice(offset, offset + limit);

    return {
      totalLines,
      returnedLines: sliced.length,
      offset,
      lines: sliced,
    };
  }

  get totalLines(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }
}
