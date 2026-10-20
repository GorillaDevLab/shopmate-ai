/* global AbortController */
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";

const ORIGIN = "https://api.github.com";

async function send(fetch, token, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw new Error(
      `GitHub API transport failed: ${error.name === "AbortError" ? "timeout" : "network error"}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(fetch, token, path, options = {}) {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password)
    throw new Error("unsafe GitHub API origin");
  const response = await send(fetch, token, url, options);
  if (response.status >= 300 && response.status < 400)
    throw new Error("GitHub API redirect refused");
  if (!response.ok) {
    const limited = response.headers.get("x-ratelimit-remaining") === "0";
    throw new Error(`GitHub API HTTP ${response.status}${limited ? " rate limited" : ""}`);
  }
  try {
    return { data: await response.json(), headers: response.headers };
  } catch {
    throw new Error("GitHub API invalid JSON");
  }
}

export function createHttp(fetch, token) {
  if (!token) throw new Error("GitHub credential missing");
  const request = (path, options) => requestJson(fetch, token, path, options);
  const graphql = async (query, variables = {}) => {
    const { data } = await request("/graphql", { method: "POST", body: { query, variables } });
    if (!data || data.errors?.length || !data.data)
      throw new Error("GitHub GraphQL request failed");
    return data.data;
  };
  return { request, graphql };
}

function validateRestCount(data, key, prior, length) {
  if (!key) return null;
  const count = data.total_count;
  if (!Number.isSafeInteger(count) || count < 0 || (prior !== null && prior !== count))
    throw new Error("REST pagination count missing or changed");
  if (length > count) throw new Error("REST pagination count exceeded");
  return count;
}

export async function restPages(http, path, key) {
  const result = [];
  const seen = new Set();
  let current = new URL(path, ORIGIN);
  let totalCount = null;
  for (let page = 0; page < 100; page += 1) {
    if (seen.has(current.href)) throw new Error("REST pagination repeated cursor");
    seen.add(current.href);
    const { data, headers } = await http.request(current.href);
    const rows = key ? data?.[key] : data;
    if (!Array.isArray(rows)) throw new Error("REST pagination invalid response");
    result.push(...rows);
    totalCount = validateRestCount(data, key, totalCount, result.length);
    const link = headers
      .get("link")
      ?.split(",")
      .find((part) => /rel="next"/.test(part));
    if (link) {
      const next = /<([^>]+)>/.exec(link)?.[1];
      if (!next) throw new Error("REST pagination missing next URL");
      current = new URL(next, ORIGIN);
      continue;
    }
    if (rows.length < 100) {
      if (totalCount !== null && result.length !== totalCount)
        throw new Error("REST pagination count mismatch");
      return result;
    }
    current.searchParams.set("page", String(Number(current.searchParams.get("page") ?? 1) + 1));
  }
  throw new Error("REST pagination limit exceeded");
}

export async function graphPages(fetchPage) {
  const result = [];
  const seen = new Set();
  let cursor = null;
  let totalCount = null;
  for (let page = 0; page < 100; page += 1) {
    const connection = await fetchPage(cursor);
    if (
      !Array.isArray(connection?.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean" ||
      !Number.isSafeInteger(connection.totalCount) ||
      connection.totalCount < 0
    )
      throw new Error("GraphQL pagination invalid response");
    if (totalCount !== null && totalCount !== connection.totalCount)
      throw new Error("GraphQL pagination count changed");
    totalCount = connection.totalCount;
    result.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) {
      if (result.length !== totalCount) throw new Error("GraphQL pagination count mismatch");
      return result;
    }
    cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error("GraphQL pagination missing/repeated cursor");
    seen.add(cursor);
  }
  throw new Error("GraphQL pagination limit exceeded");
}
