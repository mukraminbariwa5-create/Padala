// Encrypted file pieces on disk: data/blobs/<team>/<blob id>/<piece number>.
// The server only ever sees encrypted bytes; blob ids are keyed hashes, so files can't be guessed from them.
import fs from 'node:fs';
import path from 'node:path';

export const BLOB_ID = /^[0-9a-f]{64}$/;

export class BlobStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  #blobDir(teamId, blobId) {
    if (!BLOB_ID.test(blobId)) throw new Error('bad blob id');
    return path.join(this.dir, String(Number(teamId)), blobId);
  }

  chunkPath(teamId, blobId, n) {
    return path.join(this.#blobDir(teamId, blobId), String(Number(n)));
  }

  /** Piece numbers already stored (for resuming an interrupted upload). */
  have(teamId, blobId) {
    const dir = this.#blobDir(teamId, blobId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /^\d+$/.test(f)).map(Number).sort((a, b) => a - b);
  }

  write(teamId, blobId, n, buf) {
    const dir = this.#blobDir(teamId, blobId);
    fs.mkdirSync(dir, { recursive: true });
    const final = path.join(dir, String(Number(n)));
    const tmp = final + '.part';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, final); // a piece is either fully there or not at all
  }

  read(teamId, blobId, n) {
    const p = this.chunkPath(teamId, blobId, n);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  pieceSize(teamId, blobId, n) {
    try { return fs.statSync(this.chunkPath(teamId, blobId, n)).size; } catch { return null; }
  }

  removeTeam(teamId) {
    fs.rmSync(path.join(this.dir, String(Number(teamId))), { recursive: true, force: true });
  }

  remove(teamId, blobId) {
    fs.rmSync(this.#blobDir(teamId, blobId), { recursive: true, force: true });
  }
}
