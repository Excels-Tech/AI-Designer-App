import { GridFSBucket, ObjectId } from 'mongodb';
import { getDb } from './db.js';
import fs from 'node:fs';

let bucket: GridFSBucket | null = null;

export async function getGridFSBucket() {
  if (!bucket) {
    const db = await getDb();
    bucket = new GridFSBucket(db!, { bucketName: 'designFiles' });
  }
  return bucket;
}

export async function uploadDataUrlToGridFS(dataUrl: string, filename: string) {
  const match = /^data:(image\/png);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Only PNG data URLs are supported for upload.');
  }
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const bucket = await getGridFSBucket();
  return new Promise<ObjectId>((resolve, reject) => {
    const uploadStream = bucket!.openUploadStream(filename, { metadata: { contentType: mime } });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => {
      resolve(uploadStream.id as ObjectId);
    });
    uploadStream.end(buffer);
  });
}

export async function uploadFileToGridFS(filePath: string, filename: string, contentType: string) {
  const bucket = await getGridFSBucket();
  return new Promise<ObjectId>((resolve, reject) => {
    const uploadStream = bucket!.openUploadStream(filename, { metadata: { contentType } });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(uploadStream.id as ObjectId));
    fs.createReadStream(filePath)
      .on('error', reject)
      .pipe(uploadStream);
  });
}

export async function downloadGridFSFile(fileId: string) {
  const bucket = await getGridFSBucket();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    bucket
      .openDownloadStream(new ObjectId(fileId))
      .on('data', (chunk) => chunks.push(chunk))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export async function deleteGridFSFile(fileId: string) {
  const bucket = await getGridFSBucket();
  return bucket.delete(new ObjectId(fileId));
}

export async function getFileInfo(fileId: string) {
  const bucket = await getGridFSBucket();
  return bucket.find({ _id: new ObjectId(fileId) }).next();
}

export async function getReadStream(fileId: string) {
  const bucket = await getGridFSBucket();
  return bucket.openDownloadStream(new ObjectId(fileId));
}

export async function getReadStreamRange(fileId: string, start: number, endInclusive: number) {
  const bucket = await getGridFSBucket();
  return bucket.openDownloadStream(new ObjectId(fileId), { start, end: endInclusive + 1 });
}
