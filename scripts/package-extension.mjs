#!/usr/bin/env node
/**
 * Package the built extension into a Chrome Web Store-ready zip.
 *
 * R42: produces dist-store/starkit-extension-v{VERSION}.zip from the
 * already-built `apps/extension/dist/` directory. Reads version from
 * `apps/extension/manifest.json` so the artifact name auto-tracks
 * manifest bumps — no second source of truth to forget updating.
 *
 * Implementation: pure Node 20 + zlib deflate-raw frames per the
 * PKZIP spec. No native deps, no npm install required to package.
 * If your CI lacks the ability to run native zip binaries (some
 * lambda-like sandboxes), this still works because it's pure JS.
 *
 * Usage:
 *   pnpm extension:build      # produce dist/
 *   pnpm extension:package    # produce dist-store/starkit-extension-v{X}.zip
 */
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { deflateRawSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = join(__dirname, '..');

function walk(dir, base = dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walk(abs, base));
    } else if (ent.isFile()) {
      out.push({ abs, rel: relative(base, abs).split('\\').join('/') });
    }
  }
  return out;
}

/**
 * Build a minimal PKZIP archive (store + deflate). One method (deflate-raw)
 * + CRC32 + local-header + central-dir is the entire spec for V3.
 */
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    // Local file header (signature 0x04034b50)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(8, 8);         // method = deflate
    local.writeUInt16LE(0, 10);        // mod time
    local.writeUInt16LE(0, 12);        // mod date
    local.writeUInt32LE(crc, 14);      // crc32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22);       // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);    // name length
    local.writeUInt16LE(0, 28);                  // extra length
    localChunks.push(local, nameBuf, compressed);

    // Central dir header (signature 0x02014b50)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);      // version needed
    central.writeUInt16LE(0, 8);       // flags
    central.writeUInt16LE(8, 10);      // method
    central.writeUInt16LE(0, 12);      // mod time
    central.writeUInt16LE(0, 14);      // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);      // extra
    central.writeUInt16LE(0, 32);      // comment
    central.writeUInt16LE(0, 34);      // disk start
    central.writeUInt16LE(0, 36);      // internal attrs
    central.writeUInt32LE(0, 38);      // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralChunks.push(central, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralSize = centralChunks.reduce((a, b) => a + b.length, 0);
  const centralOffset = offset;
  // End-of-central-dir record (signature 0x06054b50)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                 // disk
  eocd.writeUInt16LE(0, 6);                 // central dir disk
  eocd.writeUInt16LE(entries.length, 8);    // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);   // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);                // comment length

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

function main() {
  const distDir = join(REPO, 'apps', 'extension', 'dist');
  if (!existsSync(distDir)) {
    console.error('dist/ not found — run `pnpm extension:build` first.');
    process.exit(1);
  }
  const manifest = JSON.parse(
    readFileSync(join(REPO, 'apps', 'extension', 'manifest.json'), 'utf8')
  );
  const version = manifest.version;
  if (!version) {
    console.error('manifest.json has no version field.');
    process.exit(1);
  }

  const files = walk(distDir);
  if (files.length === 0) {
    console.error('dist/ is empty.');
    process.exit(1);
  }

  // Also ensure icons/ is in dist (crxjs may or may not have copied it
  // depending on build config — this script makes it explicit).
  const iconsDir = join(REPO, 'apps', 'extension', 'icons');
  const iconFiles = existsSync(iconsDir) ? walk(iconsDir, iconsDir) : [];
  const entries = [
    ...files.map((f) => ({ name: f.rel, data: readFileSync(f.abs) })),
    ...iconFiles
      .filter((f) => !files.some((x) => x.rel === `icons/${f.rel}`))
      .map((f) => ({ name: `icons/${f.rel}`, data: readFileSync(f.abs) })),
  ];

  const outDir = join(REPO, 'dist-store');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `starkit-extension-v${version}.zip`);

  const zipBuf = buildZip(entries);
  writeFileSync(outPath, zipBuf);
  const sizeKB = (statSync(outPath).size / 1024).toFixed(1);
  console.log(`packaged ${entries.length} files → ${outPath} (${sizeKB} KB)`);
}

main();
