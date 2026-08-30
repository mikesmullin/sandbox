/**
 * Image detection + optional 2000×2000 resize (ffmpeg when available).
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extname } from 'node:path';

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function startsWithAscii(buf, offset, ascii) {
  for (let i = 0; i < ascii.length; i++) {
    if (buf[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function readUint32BE(buf, offset) {
  return buf.readUInt32BE(offset);
}

export function detectImageMimeType(buffer) {
  if (!buffer || buffer.length < 8) return null;
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7 ? null : 'image/jpeg';
  }
  if (startsWith(buffer, PNG_SIGNATURE)) return 'image/png';
  if (startsWithAscii(buffer, 0, 'GIF')) return 'image/gif';
  if (startsWithAscii(buffer, 0, 'RIFF') && startsWithAscii(buffer, 8, 'WEBP')) {
    return 'image/webp';
  }
  if (startsWithAscii(buffer, 0, 'BM')) return 'image/bmp';
  return null;
}

export function mimeFromExt(filePath) {
  const ext = extname(filePath || '').slice(1).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  return null;
}

export function readImageDimensions(buffer, mimeType) {
  try {
    if (mimeType === 'image/png' && buffer.length >= 24) {
      return { width: readUint32BE(buffer, 16), height: readUint32BE(buffer, 20) };
    }
    if (mimeType === 'image/gif' && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mimeType === 'image/bmp' && buffer.length >= 26) {
      const dib = buffer.readUInt32LE(14);
      if (dib === 12) {
        return { width: buffer.readUInt16LE(18), height: buffer.readUInt16LE(20) };
      }
      return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
    }
    if (mimeType === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) break;
        const marker = buffer[i + 1];
        const size = buffer.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
        }
        i += 2 + size;
      }
    }
    if (mimeType === 'image/webp' && buffer.length >= 30) {
      if (startsWithAscii(buffer, 12, 'VP8X') && buffer.length >= 30) {
        const w = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
        const h = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
        return { width: w, height: h };
      }
      if (startsWithAscii(buffer, 12, 'VP8 ') && buffer.length >= 30) {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
      if (startsWithAscii(buffer, 12, 'VP8L') && buffer.length >= 25) {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function runFfmpeg(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `ffmpeg exited ${code}`));
        return;
      }
      resolvePromise(Buffer.concat(chunks));
    });
  });
}

/**
 * Resize to max 2000×2000 if needed. Returns { data (base64), mimeType, hints[] }.
 */
export async function processImageFile(absPath) {
  const buf = await readFile(absPath);
  const extMime = mimeFromExt(absPath);
  const sniffed = detectImageMimeType(buf);
  const mimeType = sniffed || extMime;
  if (!mimeType) return null;

  const hints = [];
  const dims = readImageDimensions(buf, mimeType);
  const needsResize = dims && (dims.width > 2000 || dims.height > 2000);

  if (!needsResize) {
    return { data: buf.toString('base64'), mimeType, hints, width: dims?.width, height: dims?.height };
  }

  try {
    const dir = join(tmpdir(), 'angela-img');
    await mkdir(dir, { recursive: true });
    const src = join(dir, `in-${process.pid}-${Date.now()}`);
    const dest = `${src}.png`;
    await writeFile(src, buf);
    try {
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        src,
        '-vf',
        "scale='min(2000,iw)':'min(2000,ih)':force_original_aspect_ratio=decrease",
        dest,
      ]);
      const out = await readFile(dest);
      hints.push(`[Image resized from ${dims.width}x${dims.height} to fit 2000x2000.]`);
      return { data: out.toString('base64'), mimeType: 'image/png', hints };
    } finally {
      try { await unlink(src); } catch { /* ignore */ }
      try { await unlink(dest); } catch { /* ignore */ }
    }
  } catch {
    hints.push('[Image could not be resized; sending original.]');
    return { data: buf.toString('base64'), mimeType, hints, width: dims?.width, height: dims?.height };
  }
}

export function looksLikeImagePath(filePath) {
  return mimeFromExt(filePath) != null;
}
