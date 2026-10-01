const { TXN_TYPES, CBR1_COLS, CBR2_FIELDS, WLA_FIELDS, AXIS_FIELDS } = require("../ops/ops.model");

const TEMPLATES = {
  "TXN-daily": ["atmId", "date", ...TXN_TYPES.flatMap((t) => [t + "Count", t + "Amount"]), "issuedIndent", "failedCount"],
  "TXN-daily-long": ["atmId", "date", "type", "count", "amount"],
  "TXN-grid": ["atmId", "metric", "2026-09-01", "2026-09-02", "2026-09-03"],
  "CBR-1": ["atmId", "date", "deno", "indent", "eodTime", ...CBR1_COLS.flatMap((c) => [c + "Notes", c + "Amount"]), "remarks", "switchCounter", "cra", "fr", "location", "bank"],
  "CBR-2": ["date", "atmId", "mfName", "indentNo", "eodTime", ...CBR2_FIELDS.filter((f) => f !== "switchBalance"), "remarks", "switchBalance"],
  "CBR-3-WLA": ["date", "atmId", ...WLA_FIELDS],
  "CBR-3-Axis": ["date", "atmId", ...AXIS_FIELDS],
  "CBR-3-ICD": ["date", "atmId", ...AXIS_FIELDS],
};

const IMPORTERS = {};

function registerImporter(template, spec) {
  TEMPLATES[template] = spec.headers;
  IMPORTERS[template] = spec;
}

module.exports = { TEMPLATES, IMPORTERS, registerImporter };
