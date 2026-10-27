import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PHASE0_PORT || 4173);

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function safeErrorMessage(error) {
  const message = error?.message || "เชื่อมต่อบริการไม่สำเร็จ";
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

async function youtubeRequest(resource, params) {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("YOUTUBE_API_KEY is not configured on the local server.");
    error.status = 503;
    throw error;
  }

  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set("key", apiKey);

  const result = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await result.json();
  if (!result.ok) {
    const error = new Error(body?.error?.message || `YouTube API returned HTTP ${result.status}.`);
    error.status = result.status;
    error.reason = body?.error?.errors?.[0]?.reason || "youtube_api_error";
    throw error;
  }
  return body;
}

async function searchVideos(url) {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) throw Object.assign(new Error("ตั้งค่า YOUTUBE_API_KEY บนเซิร์ฟเวอร์ทดลองก่อนค้นหา"), { status: 503 });

  const query = (url.searchParams.get("q") || "").trim();
  if (!query) throw Object.assign(new Error("กรุณาใส่คำค้น"), { status: 400 });
  if (query.length > 120) throw Object.assign(new Error("คำค้นยาวเกินไป"), { status: 400 });

  const embeddable = url.searchParams.get("embeddable") === "any" ? "any" : "true";
  const search = await youtubeRequest("search", {
    part: "snippet",
    type: "video",
    videoEmbeddable: embeddable,
    maxResults: "10",
    q: query,
  });

  const ids = (search.items || []).map((item) => item.id?.videoId).filter(Boolean);
  let statuses = new Map();
  let statusWarning = null;
  if (ids.length) {
    try {
      const details = await youtubeRequest("videos", { part: "status", id: ids.join(",") });
      statuses = new Map((details.items || []).map((item) => [item.id, item.status || {}]));
    } catch (error) {
      statusWarning = safeErrorMessage(error);
    }
  }

  return {
    items: (search.items || []).map((item) => {
      const videoId = item.id.videoId;
      const status = statuses.get(videoId);
      return {
        videoId,
        title: item.snippet?.title || "(ไม่มีชื่อวิดีโอ)",
        channelTitle: item.snippet?.channelTitle || "",
        embeddable: typeof status?.embeddable === "boolean" ? status.embeddable : null,
        madeForKids: typeof status?.madeForKids === "boolean" ? status.madeForKids : null,
      };
    }),
    nextPageToken: search.nextPageToken || null,
    statusWarning,
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);

  try {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, apiKeyConfigured: Boolean(process.env.YOUTUBE_API_KEY?.trim()) });
      return;
    }

    if (url.pathname === "/api/search") {
      sendJson(response, 200, await searchVideos(url));
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(path.join(root, "public", "index.html"));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "strict-origin-when-cross-origin",
      });
      response.end(html);
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, error.status || 502, {
      error: error.reason || "request_failed",
      message: safeErrorMessage(error),
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Phase 0 probe: http://127.0.0.1:${port}\n`);
  process.stdout.write(`YouTube API key configured: ${Boolean(process.env.YOUTUBE_API_KEY?.trim())}\n`);
});
