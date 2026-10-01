const { createApp } = require("./app");
const { connect, col } = require("./config/db");
const { PORT, DEMO_OTP, MFA_CHANNEL } = require("./config/env");
const { ensureIndexes } = require("./config/indexes");
const { startJobs } = require("./jobs");
const { seedLookups } = require("./modules/lookups/lookups.service");
const { backfillProjects } = require("./modules/projects/projects.service");
const { migrateFiles } = require("./utils/files");

process.on("unhandledRejection", (err) => console.error("unhandled rejection", err));

async function start() {
  await connect();
  for (const c of await col("companies").find({}).project({ _id: 1 }).toArray()) await seedLookups(c._id);
  await ensureIndexes();
  await backfillProjects();
  const moved = await migrateFiles();
  if (moved) console.log("moved " + moved + " stored files to GridFS");
  const app = createApp();
  app.listen(PORT, () => {
    console.log("API http://127.0.0.1:" + PORT);
    if (DEMO_OTP && ["demo", "totp"].includes(MFA_CHANNEL || "demo")) {
      console.warn("WARNING: demo one-time codes are returned in login responses. Set MFA_CHANNEL to mail/sms/whatsapp, or NODE_ENV=production / DEMO_OTP=off, before going live.");
    }
  });
  startJobs();
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
