// The Analytics Engine SQL API (read only). The token and the account id are
// Worker secrets; they go only to api.cloudflare.com.

export const SQL_TIMEOUT_MS = 20_000;

export interface SqlSecrets {
  AE_READ_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

export class SqlError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = "SqlError";
  }
}

export async function querySql(secrets: SqlSecrets, sql: string): Promise<unknown[]> {
  const token = secrets.AE_READ_TOKEN;
  const account = secrets.CF_ACCOUNT_ID;
  if (typeof token !== "string" || token === "" || typeof account !== "string" || !/^[0-9a-f]{32}$/.test(account)) {
    throw new SqlError("config");
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain; charset=utf-8" },
    body: sql,
    signal: AbortSignal.timeout(SQL_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SqlError(`status_${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new SqlError("malformed");
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { data?: unknown }).data)) {
    throw new SqlError("malformed");
  }
  return (parsed as { data: unknown[] }).data;
}

// A count from SUM(_sample_interval): a non-negative integer, as a number or
// as a decimal string (64-bit integers can come back as strings).
export function countValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,14})$/.test(value)) return Number(value);
  return null;
}
