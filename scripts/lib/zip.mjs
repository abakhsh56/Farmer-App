/**
 * A minimal ZIP writer, so the live-update bundle needs no dependency and no
 * platform tool.
 *
 * The alternatives were both wrong here: `zip` is not present on Windows, and
 * PowerShell's Compress-Archive is known to write entry names with backslashes,
 * which an Android unzip reads as a single flat file name — the app would update
 * to a bundle it cannot open. This writes the structure the format actually
 * specifies, with forward slashes, and is the same code on every machine.
 *
 * Entries are deflated when that makes them smaller, because the whole point of
 * the bundle is what a phone downloads over a rural connection: the bundled WASM
 * runtime and the phonemiser's data are the two large items left once the voice
 * model is excluded, and both compress by roughly two thirds. Anything that does
 * not shrink (already-compressed bytes) is stored instead, since deflating it
 * would cost time and accuracy for nothing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/** CRC-32, the checksum ZIP requires per entry. Table built once, lazily. */
let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** Every file under `dir`, as paths relative to it, in a stable order. */
function walk(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, base));
    else if (entry.isFile()) found.push(relative(base, full).split(sep).join('/'));
  }
  return found;
}

/** DOS date/time, which is what the format stores. */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * Writes `dir` as a zip whose root is `dir`'s contents, so the bundle's
 * `index.html` sits at the archive root — the layout the plugin expects.
 *
 * `exclude` receives each relative path and skips what it returns true for; the
 * publisher uses it to leave the voice folder out of the bundle.
 */
export function zipDirectory(dir, { exclude } = {}) {
  const files = walk(dir).filter((name) => !exclude?.(name));
  const { time, day } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const name of files) {
    const raw = readFileSync(join(dir, name));
    const deflated = deflateRawSync(raw, { level: 9 });
    const payload = deflated.length < raw.length ? deflated : raw;
    const method = deflated.length < raw.length ? 8 : 0;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, payload);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralSize = centrals.reduce((total, buffer) => total + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}
