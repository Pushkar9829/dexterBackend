const { col } = require("../../config/db");
const { named } = require("../../utils/named-collection");

// Data access for the documents module. Services reach MongoDB only through these collection handles.
module.exports = {
  get applications() {
    return named("applications");
  },
  get documents() {
    return named("documents");
  },
  get franchises() {
    return named("franchises");
  },
  get users() {
    return named("users");
  },
  collection: (name) => named(name),
  nextVersion,
};

// Concurrent uploads of the same file type must not share a version number. The counter is seeded from the
// highest stored version so records created before the counter existed keep counting from where they are.
async function nextVersion(companyId, parentId, type) {
  const last = await col("documents").find({ companyId, parentId, type }).sort({ version: -1 }).limit(1).next();
  const key = "docver:" + String(companyId) + ":" + String(parentId) + ":" + type;
  await col("counters").updateOne({ _id: key }, { $max: { seq: last ? last.version : 0 } }, { upsert: true });
  const r = await col("counters").findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { returnDocument: "after" });
  return (r && r.value ? r.value : r).seq;
}
