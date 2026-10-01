const { MongoClient } = require("mongodb");
const config = require("./env");

const uri = config.MONGO_URL || "mongodb://127.0.0.1:27017";

const dbName = config.MONGO_DB || "advocateflow";

let client;

let db;

async function connect() {
  if (db) return db;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  return db;
}

function col(name) {
  if (!db) throw new Error("database not connected");
  return db.collection(name);
}

module.exports = { uri, dbName, client, db, connect, col };
