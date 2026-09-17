import { loadConfig } from "./config/config.js";
import { Database } from "./persistence/database.js";

const database = new Database(loadConfig().databaseUrl);
try { await database.migrate(); console.info("migrations applied"); }
finally { await database.close(); }
