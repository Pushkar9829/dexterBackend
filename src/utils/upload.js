const config = require("../config/env");

const FILE_TYPES = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  eml: "message/rfc822",
};

const VIDEO_TYPES = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  "3gp": "video/3gpp",
};

const MAX_FILE_BYTES = Number(config.MAX_FILE_MB || 10) * 1024 * 1024;

// Uploads arrive base64 inside a 20 MB JSON body, so a video can be at most ~14 MB.
const MAX_VIDEO_BYTES = Math.min(Number(config.MAX_VIDEO_MB) || 12, 14) * 1024 * 1024;

function checkFile(fileName, base64, maxBytes, opts = {}) {
  const name = String(fileName || "").trim();
  const ext = ((name.match(/\.([a-z0-9]+)$/i) || [])[1] || "").toLowerCase();
  const video = !!opts.video && !!VIDEO_TYPES[ext];
  if (!ext || (!FILE_TYPES[ext] && !video)) return { error: "file type not allowed; use " + Object.keys(FILE_TYPES).join(", ") + (opts.video ? ", or video " + Object.keys(VIDEO_TYPES).join(", ") : "") };
  const data = Buffer.from(String(base64 || ""), "base64");
  if (!data.length) return { error: "file is empty" };
  const limit = video ? MAX_VIDEO_BYTES : maxBytes || MAX_FILE_BYTES;
  if (data.length > limit) return { error: (video ? "video" : "file") + " over " + Math.round(limit / 1048576) + " MB" };
  return { name: name.slice(0, 200), mime: video ? VIDEO_TYPES[ext] : FILE_TYPES[ext], data, video };
}

module.exports = { FILE_TYPES, VIDEO_TYPES, MAX_FILE_BYTES, MAX_VIDEO_BYTES, checkFile };
