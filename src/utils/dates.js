function istToday() {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function normDate(v) {
  const s = String(v || "").trim();
  let y, m, d;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (hit) [, y, m, d] = hit;
  else {
    hit = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
    if (!hit) return null;
    [, d, m, y] = hit;
  }
  const iso = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  const dt = new Date(iso + "T00:00:00Z");
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? null : iso;
}

function shiftDate(iso, days) {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

module.exports = { istToday, normDate, shiftDate };
