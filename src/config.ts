// Runtime configuration. Everything sensitive comes from environment
// variables (node --env-file or the shell); nothing is hard-coded.

const env = (k: string, d = ""): string => {
  const v = (process.env[k] ?? d).trim();
  // Placeholders from .env.example count as unset.
  return /^(PASTE_|your-|change-me$)/i.test(v) ? d : v;
};
const bool = (k: string, d = false): boolean => {
  const v = env(k);
  return v ? ["1", "true", "yes", "on"].includes(v.toLowerCase()) : d;
};

export const config = {
  port: Number(env("PORT", "8000")),
  host: env("HOST", "0.0.0.0"),
  // SAMPLE_MODE: no live credentials needed. Zetaris answers from the query
  // cache in data/cache and the agents fall back to their deterministic
  // reasoning path. Real agent logic still runs on the cached rows.
  sampleMode: bool("SAMPLE_MODE"),
  logLevel: env("LOG_LEVEL", "INFO"),
  dataDir: env("CAUSA_DATA", "data/runtime"),

  meterless: {
    baseUrl: env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1"),
    token: env("METERLESS_RUNTIME_TOKEN"),
    app: env("METERLESS_APP", "causa"),
    // Routing modes exposed by Nightshift. "fast" handles intake and SQL,
    // "deep" handles planning, critique and writing. Pin Nemotron-backed
    // lanes here to make the NVIDIA evidence unambiguous.
    fastModel: env("METERLESS_MODEL_FAST", env("METERLESS_MODEL", "meterless/fast")),
    deepModel: env("METERLESS_MODEL_DEEP", env("METERLESS_MODEL", "meterless/deep")),
    timeoutMs: Number(env("METERLESS_TIMEOUT_MS", "180000")),
  },

  zetaris: {
    restUrl: env("ZETARIS_REST_URL", "http://localhost:8888/api/v1.0"),
    orgId: env("ZETARIS_ORG_ID", "1"),
    apiKey: env("ZETARIS_API_KEY"),
    timeoutMs: Number(env("ZETARIS_TIMEOUT_MS", "60000")),
    rowLimit: Number(env("ZETARIS_ROW_LIMIT", "200")),
    // RECORD_CACHE: write every live query result into data/cache so the
    // project ships a sample-mode dataset that matches real runs.
    recordCache: bool("RECORD_CACHE", true),
  },

  budget: {
    maxRounds: Number(env("CAUSA_MAX_ROUNDS", "4")),
    maxQueries: Number(env("CAUSA_MAX_QUERIES", "24")),
    maxModelCalls: Number(env("CAUSA_MAX_MODEL_CALLS", "40")),
    maxSeconds: Number(env("CAUSA_MAX_SECONDS", "480")),
  },
};

export type Config = typeof config;
