import { app } from "./app";
import { config } from "./config";

// Express 5 also calls this when listening fails, such as when the port is in use.
function handleListenResult(error?: Error): void {
  if (error !== undefined) {
    throw error;
  }

  console.log(`QuoteDesk listening on http://localhost:${config.PORT}`);
}

app.listen(config.PORT, handleListenResult);
