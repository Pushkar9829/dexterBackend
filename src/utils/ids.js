const { ObjectId } = require("mongodb");

function oid(id) {
  if (id === undefined || id === null || id === "") return null;
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

module.exports = { oid };
