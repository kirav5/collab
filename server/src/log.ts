// Structured logs: one JSON line per entry, which Cloud Logging reads as severity + fields, and which Error Reporting
// groups when an error carries its stack. Request bodies are never logged (they may hold what someone typed).
type Fields = Record<string, unknown>;

function write(severity: "DEBUG" | "INFO" | "WARNING" | "ERROR", message: string, fields: Fields = {}) {
  const entry = { severity, message, ...fields, time: new Date().toISOString() };
  (severity === "ERROR" ? process.stderr : process.stdout).write(JSON.stringify(entry) + "\n");
}

/** Product events for analytics: a name and small non-personal numbers only (never text, prices with names, or ids of people). */
export const event = (name: string, data: Record<string, string | number | boolean> = {}) => log.info("event", { event: name, ...data });

export const log = {
  info: (message: string, fields?: Fields) => write("INFO", message, fields),
  warn: (message: string, fields?: Fields) => write("WARNING", message, fields),
  /** An error with its stack, reported to Error Reporting. */
  error: (message: string, err?: unknown, fields?: Fields) => write("ERROR", err instanceof Error ? `${message}: ${err.stack ?? err.message}` : message, {
    ...fields, ...(err && !(err instanceof Error) ? { detail: String(err).slice(0, 500) } : {}),
    "@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent", serviceContext: { service: "collab-market" },
  }),
};
