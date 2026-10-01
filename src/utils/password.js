const crypto = require("crypto");

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, useSalt, 32).toString("hex");
  return { salt: useSalt, hash };
}

function checkPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(password, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(next, "hex"));
}

function randomOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function passwordProblem(pw) {
  const s = String(pw || "");
  if (s.length < 8) return "password must be at least 8 characters";
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return "password needs letters and numbers";
  if (s.length > 128) return "password too long";
  return "";
}

module.exports = { hashPassword, checkPassword, randomOtp, passwordProblem };
