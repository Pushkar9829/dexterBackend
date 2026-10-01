const { col } = require("../config/db");

// A collection handle with the named data-access functions repositories expose. Driver methods that have no named
// form (aggregate, updateMany, findOneAndUpdate, distinct, find cursors...) pass straight through.
const NAMED = {
  findById: (c) => (id, projection) => c.findOne({ _id: id }, projection ? { projection } : undefined),
  list:
    (c) =>
    (filter = {}, { sort, limit, skip, projection } = {}) => {
      let cur = c.find(filter);
      if (projection) cur = cur.project(projection);
      if (sort) cur = cur.sort(sort);
      if (skip) cur = cur.skip(skip);
      if (limit) cur = cur.limit(limit);
      return cur.toArray();
    },
  insert: (c) => (doc) => c.insertOne(doc),
  updateById: (c) => (id, update, options) => c.updateOne({ _id: id }, update, options),
  deleteById: (c) => (id) => c.deleteOne({ _id: id }),
  count: (c) => (filter = {}) => c.countDocuments(filter),
};

function named(name) {
  const c = col(name);
  return new Proxy(c, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(NAMED, prop)) return NAMED[prop](target);
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

module.exports = { named };
