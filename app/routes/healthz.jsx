import db from "../db.server";

// Railway's health check: a new version only takes over once this answers,
// so updates don't cut people off with 502s. Checks the database too.
export const loader = async () => {
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("database didn't answer in 5 s")), 5000)),
    ]);
    return new Response("ok", { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });
  } catch (e) {
    return new Response(`not ready: ${e?.message ?? e}`, { status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });
  }
};
