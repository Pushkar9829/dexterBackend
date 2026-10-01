const { GridFSBucket } = require("mongodb");
const { connect } = require("../config/db");
const config = require("../config/env");
const repo = require("./shared.repository");

const BUCKET = "files";

const STORE = config.FILE_STORE || "gridfs";

let bucket;

async function getBucket() {
  if (!bucket) bucket = new GridFSBucket(await connect(), { bucketName: BUCKET });
  return bucket;
}

async function storeFile(buf, fileName, mime) {
  if (STORE !== "gridfs") return { data: buf, size: buf.length };
  const b = await getBucket();
  const up = b.openUploadStream(String(fileName || "file"), { metadata: { mime: mime || "application/octet-stream" } });
  await new Promise((resolve, reject) => up.on("error", reject).on("finish", resolve).end(buf));
  return { fileId: up.id, size: buf.length };
}

async function readFileData(doc) {
  if (doc.data) return Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer || doc.data);
  if (!doc.fileId) return Buffer.alloc(0);
  const b = await getBucket();
  const parts = [];
  await new Promise((resolve, reject) => {
    b.openDownloadStream(doc.fileId).on("data", (c) => parts.push(c)).on("error", reject).on("end", resolve);
  });
  return Buffer.concat(parts);
}

async function removeFile(doc) {
  if (!doc || !doc.fileId) return;
  const b = await getBucket();
  await b.delete(doc.fileId).catch(() => {});
}

async function migrateFiles() {
  if (STORE !== "gridfs") return 0;
  let moved = 0;
  for (const name of ["documents", "affidavit_formats"]) {
    const cursor = repo.collection(name).find({ data: { $exists: true, $ne: null } }).project({ _id: 1, fileName: 1, mime: 1, data: 1 });
    for await (const d of cursor) {
      const buf = Buffer.isBuffer(d.data) ? d.data : Buffer.from(d.data.buffer || d.data);
      const s = await storeFile(buf, d.fileName, d.mime);
      await repo.collection(name).updateById(d._id, { $set: { fileId: s.fileId, size: s.size }, $unset: { data: "" } });
      moved++;
    }
  }
  return moved;
}

module.exports = { BUCKET, STORE, bucket, getBucket, storeFile, readFileData, removeFile, migrateFiles };
