import { Zip, ZipDeflate } from 'fflate';

/** The deflate level of every entry (Global Constraints, Determinism). */
const DEFLATE_LEVEL = 6;

/**
 * Every entry's modification time, 1980-01-01 00:00:00, built from local components: fflate writes the DOS date and time
 * from the local getters, which then read 1980-01-01 00:00:00 in every time zone, so the bytes are the same everywhere.
 * This assumes local 1980-01-01 00:00 exists in every zone (no zone skipped that hour); none is known to have.
 */
function entryTime(): Date {
  return new Date(1980, 0, 1, 0, 0, 0);
}

/** An entry that holds its place in the zip and is written later, once. */
export interface ReservedEntry {
  write(data: Uint8Array): void;
}

/**
 * A zip written in the order entries are added, through fflate's streaming `Zip`, each entry deflated at level 6 with the
 * fixed time. An added entry is compressed at once, so the caller's bytes are not kept. A reserved entry keeps its place:
 * the entries added after it wait, already compressed, inside fflate until it is written.
 */
export class PackageZip {
  private readonly chunks: Uint8Array[] = [];
  private failure: Error | null = null;
  private ended = false;
  private readonly zip = new Zip((error, chunk, final) => {
    if (error) {
      this.failure ??= error;
      return;
    }
    this.chunks.push(chunk);
    if (final) this.ended = true;
  });

  /** Adds the entry `name` with `data`. */
  add(name: string, data: Uint8Array): void {
    this.reserve(name).write(data);
  }

  /** Adds the entry `name` here in the order; its bytes come with `write`. */
  reserve(name: string): ReservedEntry {
    const entry = new ZipDeflate(name, { level: DEFLATE_LEVEL });
    entry.mtime = entryTime();
    this.zip.add(entry);
    this.check();
    let written = false;
    return {
      write: (data) => {
        if (written) throw new Error(`zip entry ${name} is already written`);
        written = true;
        entry.push(data, true);
        this.check();
      },
    };
  }

  /** Ends the zip and returns its bytes. Every reserved entry must have been written. */
  finish(): Uint8Array {
    this.zip.end();
    this.check();
    if (!this.ended) throw new Error('the zip has a reserved entry that was never written');
    // By necessity this briefly holds the output twice: the chunks and the one array they are copied into.
    let length = 0;
    for (const chunk of this.chunks) length += chunk.length;
    const out = new Uint8Array(length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    this.chunks.length = 0;
    return out;
  }

  private check(): void {
    if (this.failure) throw this.failure;
  }
}
