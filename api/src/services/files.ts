// Photos of machines, people and machine reports (API.md §3 Files).
//
// The type is read from the bytes, not from what the client says, and so
// are the width and height (the headers of JPEG, PNG and WebP hold them; no
// image library needed).

import { createHash, randomUUID } from 'node:crypto';
import type { ActionKey, FilePurpose, FileRef } from '@stitchflow/contract';
import type { Tx } from '../db/db.ts';
import { ApiError, notFound } from '../http/errors.ts';
import type { Member } from '../http/types.ts';
import type { Storage } from '../storage/storage.ts';

export const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** What uploading a file for a purpose needs. */
export const UPLOAD_ACTION: Record<FilePurpose, ActionKey> = {
  machinePhoto: 'machines.update',
  staffPhoto: 'staff.update',
  slipPhoto: 'production.record',
};

/** Any one of these lets a member see a file for a purpose. A person's photo
 *  shows in the operator picker and on attendance, which carry no pay. */
export const VIEW_ACTIONS: Record<FilePurpose, ActionKey[]> = {
  machinePhoto: ['machines.view'],
  staffPhoto: ['staff.view', 'production.view', 'attendance.view'],
  slipPhoto: ['production.view'],
};

interface Image {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: string;
  width: number | null;
  height: number | null;
}

/** The image's type and size from its header, or null if it is not a JPEG, PNG or WebP. */
export function sniffImage(b: Buffer): Image | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { contentType: 'image/png', ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    return { contentType: 'image/jpeg', ext: 'jpg', ...jpegSize(b) };
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', ext: 'webp', ...webpSize(b) };
  }
  return null;
}

function jpegSize(b: Buffer): { width: number | null; height: number | null } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    // Start-of-frame markers carry the size; C4, C8 and CC are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5) || null, width: b.readUInt16BE(i + 7) || null };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { width: null, height: null };
}

function webpSize(b: Buffer): { width: number | null; height: number | null } {
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]];
    return { width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) };
  }
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return { width: null, height: null };
}

export async function upload(
  tx: Tx, storage: Storage, member: Member, purpose: FilePurpose, bytes: Buffer,
): Promise<FileRef> {
  if (bytes.length === 0) throw new ApiError('validation_failed', 'Empty file.', { fields: { file: 'empty' } });
  if (bytes.length > MAX_FILE_BYTES) throw new ApiError('file_too_large', 'Over 15 MB.');
  const image = sniffImage(bytes);
  if (!image) {
    throw new ApiError('validation_failed', 'Only JPEG, PNG or WebP.', { fields: { file: 'type' } });
  }
  const id = randomUUID();
  const key = `${member.propertyId}/${id}.${image.ext}`;
  await tx.exec(
    `insert into files (id, property_id, purpose, storage_key, content_type, byte_size, sha256,
                        width, height, created_by_member_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, member.propertyId, purpose, key, image.contentType, bytes.length,
     createHash('sha256').update(bytes).digest('hex'), image.width, image.height, member.memberId],
  );
  // Written last: if the insert fails, nothing is left on disk. If the
  // commit fails after this, an orphan file is left, which is harmless.
  await storage.put(key, bytes, image.contentType);
  return { id, purpose, url: storage.signedPath(key), width: image.width, height: image.height };
}

export async function find(tx: Tx, id: string): Promise<{ purpose: FilePurpose; key: string }> {
  const f = await tx.one<{ purpose: FilePurpose; key: string }>(
    `select purpose, storage_key as key from files where id = $1`, [id]);
  if (!f) throw notFound('No such file.');
  return f;
}
