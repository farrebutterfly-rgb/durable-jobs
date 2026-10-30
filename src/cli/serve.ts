/** Start the HTTP API on PORT (default 8787). Run a worker separately with `npm run worker`. */
import { startApiServer } from "../server.ts";
import { createJobStore } from "../store.ts";

const store = createJobStore(process.env.DJ_DB ?? ".data/jobs.db");
const api = await startApiServer(store, Number(process.env.PORT ?? 8787));
console.log(`durable-jobs API on ${api.url}  (POST /jobs with Idempotency-Key, GET /jobs/:id)  db=${store.path}`);
