/**
 * Load relay-server/.env (when there is one) into process.env, before anything reads it. Imported first by index.js
 * and worker.js. Variables already set in the environment win, so systemd or the shell can override the file.
 */
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch (e) {
  if (e?.code !== "ENOENT") throw e;
}
