import { loadConfig } from "./config.js";
import { Database } from "./database.js";

const database = new Database(loadConfig().databaseUrl);
try { await database.migrate(); console.info("migrations applied"); }
finally { await database.close(); }
