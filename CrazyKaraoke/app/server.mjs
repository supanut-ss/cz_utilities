import { createServer } from "node:http";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, "public");
const host = process.env.KARAOKE_HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const sessionCookie = "karaoke_session";
const maxPlayersPerRoom = 16;
const maxSongsPerPlayer = 3;
const maxQueueSize = 50;
const maxQueueAddsPerWindow = 10;
const rooms = new Map();
const sessions = new Map();
const searchCache = new Map();
const searchHistory = new Map();
const queueAddHistory = new Map();

class HttpError extends Error {
  constructor(status, message, code = "request_failed") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function secureHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com https://www.gstatic.com; style-src 'self'; img-src 'self' data: https://i.ytimg.com; connect-src 'self' https://www.youtube.com https://www.googleapis.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function sendJson(response, status, body) {
  secureHeaders(response);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendError(response, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "internal_error";
  const message = error instanceof HttpError ? error.message : "เกิดข้อผิดพลาดในเซิร์ฟเวอร์";
  if (status >= 500) process.stderr.write(`${code}\n`);
  sendJson(response, status, { error: code, message });
}

async function readJson(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > 16_384) throw new HttpError(413, "ข้อมูลคำขอยาวเกินไป", "body_too_large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "ข้อมูลคำขอไม่ถูกต้อง", "invalid_json");
  }
}

function normalizeRoomCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeNickname(value) {
  const nickname = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const length = Array.from(nickname).length;
  if (!nickname) throw new HttpError(400, "ใส่ชื่อเล่นก่อนเข้าห้อง", "nickname_required");
  if (length > 24) throw new HttpError(400, "ชื่อเล่นต้องไม่เกิน 24 ตัวอักษร", "nickname_too_long");
  return nickname;
}

function makeRoomCode() {
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => roomAlphabet[randomInt(roomAlphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function getCookie(request, name) {
  const cookies = request.headers.cookie || "";
  for (const item of cookies.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return "";
}

function setSessionCookie(request, response, token) {
  const trustedHttps = process.env.KARAOKE_TRUST_PROXY === "1" && request.headers["x-forwarded-proto"] === "https";
  const secure = request.socket.encrypted || trustedHttps ? "; Secure" : "";
  response.setHeader("set-cookie", `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=172800${secure}`);
}

function clearSessionCookie(response) {
  response.setHeader("set-cookie", `${sessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function getSession(request) {
  const token = getCookie(request, sessionCookie);
  return token ? sessions.get(token) || null : null;
}

function getPlayer(request, room) {
  const session = getSession(request);
  if (!session || session.roomCode !== room.code) throw new HttpError(401, "เซสชันห้องหมดอายุ กรุณาเข้าห้องอีกครั้ง", "session_required");
  const player = room.players.get(session.playerId);
  if (!player) throw new HttpError(401, "ไม่พบผู้เล่นในห้องนี้ กรุณาเข้าห้องอีกครั้ง", "player_not_found");
  return player;
}

function stateFor(room, viewerId = null) {
  const votes = [...room.score.votes.values()];
  const canVote = Boolean(viewerId && room.currentSong && room.playbackState === "awaiting_score" && viewerId !== room.currentSingerId && !room.score.votes.has(viewerId) && !room.score.automaticScore);
  const reportReasons = {};
  for (const reason of room.songReports.values()) reportReasons[reason] = (reportReasons[reason] || 0) + 1;
  return {
    roomCode: room.code,
    status: room.status,
    revision: room.revision,
    hostPlayerId: room.hostPlayerId,
    currentSingerId: room.currentSingerId,
    currentSong: room.currentSong ? { ...room.currentSong } : null,
    playbackState: room.playbackState,
    playbackErrorCode: room.playbackErrorCode,
    scoring: {
      automaticScore: room.score.automaticScore,
      voteCount: votes.length,
      averageVote: votes.length ? Math.round(votes.reduce((total, vote) => total + vote, 0) / votes.length * 10) / 10 : null,
      hasVoted: Boolean(viewerId && room.score.votes.has(viewerId)),
      canVote,
    },
    songReports: {
      count: room.songReports.size,
      hasReported: Boolean(viewerId && room.songReports.has(viewerId)),
      reasons: reportReasons,
    },
    viewerId,
    createdAt: room.createdAt,
    players: [...room.players.values()]
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map((player) => ({
        id: player.id,
        nickname: player.nickname,
        joinedAt: player.joinedAt,
        isOnline: player.activeConnections > 0,
      })),
    queue: room.queue.map((item) => ({ ...item })),
  };
}

function parseDuration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || "");
  if (!match) return { seconds: null, label: "ไม่ทราบเวลา" };
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return { seconds, label: `${minutes}:${remainder}` };
}

function safeYoutubeMessage(message) {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  return key ? String(message || "").split(key).join("[redacted]") : String(message || "");
}

async function youtubeRequest(resource, params) {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) throw new HttpError(503, "ยังไม่ได้ตั้งค่า YouTube API key บนเซิร์ฟเวอร์", "youtube_key_missing");
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [name, value] of Object.entries(params)) {
    if (value) url.searchParams.set(name, value);
  }
  url.searchParams.set("key", key);

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, "เชื่อมต่อ YouTube ไม่สำเร็จ ลองใหม่ภายหลัง", "youtube_unavailable");
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    throw new HttpError(502, "YouTube ส่งข้อมูลกลับมาไม่สมบูรณ์", "youtube_invalid_response");
  }
  if (!response.ok) {
    const message = safeYoutubeMessage(body?.error?.message || "คำขอไปยัง YouTube ไม่สำเร็จ");
    const status = response.status === 403 ? 503 : 502;
    throw new HttpError(status, message, body?.error?.errors?.[0]?.reason || "youtube_api_error");
  }
  return body;
}

async function searchYoutube(request, room, url) {
  const player = getPlayer(request, room);
  if (!process.env.YOUTUBE_API_KEY?.trim()) throw new HttpError(503, "ยังไม่ได้ตั้งค่า YouTube API key บนเซิร์ฟเวอร์", "youtube_key_missing");
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) throw new HttpError(400, "ใส่ชื่อเพลงหรือศิลปินก่อนค้นหา", "query_required");
  if (Array.from(query).length > 120) throw new HttpError(400, "คำค้นต้องไม่เกิน 120 ตัวอักษร", "query_too_long");

  const pageToken = (url.searchParams.get("pageToken") || "").trim();
  if (pageToken.length > 200) throw new HttpError(400, "รหัสหน้าผลค้นหาไม่ถูกต้อง", "invalid_page_token");
  const cacheKey = `${query.toLocaleLowerCase()}|${pageToken}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const now = Date.now();
  const recentSearches = (searchHistory.get(player.id) || []).filter((time) => now - time < 10 * 60_000);
  if (recentSearches.length && now - recentSearches.at(-1) < 1800) {
    throw new HttpError(429, "รอสักครู่ก่อนค้นหาอีกครั้ง", "search_rate_limited");
  }
  if (recentSearches.length >= 10) {
    throw new HttpError(429, "ค้นหาได้ไม่เกิน 10 ครั้งใน 10 นาที", "search_window_limit");
  }
  recentSearches.push(now);
  searchHistory.set(player.id, recentSearches);

  const search = await youtubeRequest("search", {
    part: "snippet",
    type: "video",
    videoEmbeddable: "true",
    maxResults: "10",
    q: query,
    pageToken,
  });
  const videoIds = (search.items || []).map((item) => item.id?.videoId).filter(Boolean);
  let details = new Map();
  let statusWarning = null;
  if (videoIds.length) {
    try {
      const videos = await youtubeRequest("videos", { part: "snippet,status,contentDetails", id: videoIds.join(",") });
      details = new Map((videos.items || []).map((item) => [item.id, item]));
    } catch {
      statusWarning = "อ่านสถานะและความยาววิดีโอไม่สำเร็จ";
    }
  }

  const result = {
    items: (search.items || []).flatMap((item) => {
      const videoId = item.id?.videoId;
      if (!videoId) return [];
      const video = details.get(videoId);
      const duration = parseDuration(video?.contentDetails?.duration);
      const thumbnails = item.snippet?.thumbnails || {};
      return [{
        videoId,
        title: item.snippet?.title || "ไม่มีชื่อวิดีโอ",
        channelTitle: item.snippet?.channelTitle || "",
        thumbnail: thumbnails.medium?.url || thumbnails.default?.url || "",
        durationSeconds: duration.seconds,
        durationLabel: duration.label,
        embeddable: typeof video?.status?.embeddable === "boolean" ? video.status.embeddable : null,
        madeForKids: typeof video?.status?.madeForKids === "boolean" ? video.status.madeForKids : null,
      }];
    }),
    nextPageToken: search.nextPageToken || null,
    statusWarning,
  };
  searchCache.set(cacheKey, { result, expiresAt: Date.now() + 30_000 });
  if (searchCache.size > 150) searchCache.delete(searchCache.keys().next().value);
  return result;
}

function recordQueueAdd(playerId) {
  const now = Date.now();
  const recent = (queueAddHistory.get(playerId) || []).filter((time) => now - time < 10 * 60_000);
  if (recent.length && now - recent.at(-1) < 1200) {
    throw new HttpError(429, "รอสักครู่ก่อนเพิ่มเพลงอีกครั้ง", "queue_add_rate_limited");
  }
  if (recent.length >= maxQueueAddsPerWindow) {
    throw new HttpError(429, `เพิ่มเพลงได้ไม่เกิน ${maxQueueAddsPerWindow} ครั้งใน 10 นาที`, "queue_add_window_limit");
  }
  recent.push(now);
  queueAddHistory.set(playerId, recent);
}

async function verifyVideo(videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new HttpError(400, "รหัสวิดีโอไม่ถูกต้อง", "invalid_video_id");
  const response = await youtubeRequest("videos", { part: "snippet,status,contentDetails", id: videoId });
  const video = response.items?.[0];
  if (!video) throw new HttpError(404, "ไม่พบวิดีโอนี้ อาจถูกลบหรือเป็นส่วนตัว", "video_not_found");
  if (video.status?.privacyStatus === "private") throw new HttpError(422, "วิดีโอนี้เป็นส่วนตัวและเล่นไม่ได้", "video_private");
  if (video.status?.embeddable !== true) throw new HttpError(422, "วิดีโอนี้ไม่อนุญาตให้เล่นแบบฝัง", "video_not_embeddable");
  const duration = parseDuration(video.contentDetails?.duration);
  const thumbnail = video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || "";
  return {
    videoId,
    title: video.snippet?.title || "ไม่มีชื่อวิดีโอ",
    channelTitle: video.snippet?.channelTitle || "",
    thumbnail,
    durationSeconds: duration.seconds,
    durationLabel: duration.label,
    embeddable: true,
    madeForKids: typeof video.status?.madeForKids === "boolean" ? video.status.madeForKids : null,
  };
}

function writeEvent(response, eventName, data, revision = null) {
  const idLine = revision === null ? "" : `id: ${revision}\n`;
  response.write(`${idLine}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room, eventName = "state", extra = {}) {
  room.revision += 1;
  for (const client of [...room.clients]) {
    if (client.response.destroyed || client.response.writableEnded) {
      room.clients.delete(client);
      continue;
    }
    try {
      writeEvent(client.response, eventName, eventName === "state" ? stateFor(room, client.playerId) : extra, room.revision);
    } catch {
      room.clients.delete(client);
    }
  }
}

function createPlayer(nickname, role = "member") {
  return {
    id: randomUUID(),
    nickname,
    role,
    joinedAt: Date.now(),
    activeConnections: 0,
  };
}

function issueSession(request, response, room, player) {
  const previousToken = getCookie(request, sessionCookie);
  const previous = previousToken ? sessions.get(previousToken) : null;
  if (previousToken) sessions.delete(previousToken);
  if (previous && (previous.roomCode !== room.code || previous.playerId !== player.id)) {
    const oldRoom = rooms.get(previous.roomCode);
    if (oldRoom?.players.has(previous.playerId)) removePlayer(oldRoom, previous.playerId);
  }

  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { roomCode: room.code, playerId: player.id });
  setSessionCookie(request, response, token);
}

function createRoom(nickname) {
  const code = makeRoomCode();
  const player = createPlayer(nickname, "host");
  const room = {
    code,
    status: "waiting",
    revision: 0,
    hostPlayerId: player.id,
    currentSingerId: null,
    currentSong: null,
    playbackState: "idle",
    playbackErrorCode: null,
    score: { automaticScore: null, votes: new Map() },
    songReports: new Map(),
    createdAt: Date.now(),
    players: new Map([[player.id, player]]),
    queue: [],
    clients: new Set(),
  };
  rooms.set(code, room);
  return { room, player };
}

function findRoom(code) {
  const room = rooms.get(normalizeRoomCode(code));
  if (!room) throw new HttpError(404, "ไม่พบห้องนี้ ตรวจรหัสแล้วลองอีกครั้ง", "room_not_found");
  return room;
}

function closeRoom(room, reason = "closed") {
  broadcast(room, "closed", { reason, roomCode: room.code });
  for (const client of [...room.clients]) client.response.end();
  room.clients.clear();
  for (const player of room.players.values()) searchHistory.delete(player.id);
  for (const player of room.players.values()) queueAddHistory.delete(player.id);
  for (const [token, session] of sessions) {
    if (session.roomCode === room.code) sessions.delete(token);
  }
  rooms.delete(room.code);
}

function removePlayer(room, playerId, departureEvent = "left", removeQueuedSongs = false) {
  const player = room.players.get(playerId);
  if (!player) return;
  for (const client of [...room.clients]) {
    if (client.playerId === playerId) {
      writeEvent(client.response, departureEvent, { roomCode: room.code });
      client.response.end();
      room.clients.delete(client);
    }
  }
  for (const [token, session] of sessions) {
    if (session.roomCode === room.code && session.playerId === playerId) sessions.delete(token);
  }
  room.players.delete(playerId);
  searchHistory.delete(playerId);
  queueAddHistory.delete(playerId);
  if (removeQueuedSongs) room.queue = room.queue.filter((song) => song.requesterId !== playerId);
  if (!room.players.size) {
    closeRoom(room, "empty");
    return;
  }
  if (room.hostPlayerId === playerId) {
    const nextHost = [...room.players.values()].sort((left, right) => left.joinedAt - right.joinedAt)[0];
    room.hostPlayerId = nextHost.id;
    if (room.playbackState === "playing" || room.playbackState === "paused") {
      room.playbackState = "paused";
      room.status = "paused";
    }
  }
  broadcast(room);
}

function openEventStream(request, response, room, player) {
  secureHeaders(response);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write("retry: 3000\n\n");

  const client = { response, playerId: player.id };
  room.clients.add(client);
  player.activeConnections += 1;
  broadcast(room);

  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(": keep-alive\n\n");
  }, 20_000);

  response.on("close", () => {
    clearInterval(heartbeat);
    room.clients.delete(client);
    const currentPlayer = room.players.get(player.id);
    if (!currentPlayer) return;
    currentPlayer.activeConnections = Math.max(0, currentPlayer.activeConnections - 1);
    if (rooms.get(room.code) === room) broadcast(room);
  });
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, roomCount: rooms.size });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rooms") {
    const body = await readJson(request);
    const { room, player } = createRoom(normalizeNickname(body.nickname));
    issueSession(request, response, room, player);
    sendJson(response, 201, { room: stateFor(room, player.id) });
    return;
  }

  const route = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/(join|events|host|leave|close|search|play|playback|skip|score|kick|report|queue(?:\/(?:remove|reorder))?))?$/i);
  if (!route) throw new HttpError(404, "ไม่พบเส้นทางนี้", "route_not_found");
  const roomCode = normalizeRoomCode(route[1]);
  const action = route[2] || "state";

  if (request.method === "POST" && action === "join") {
    const room = findRoom(roomCode);
    const body = await readJson(request);
    if (rooms.get(room.code) !== room) throw new HttpError(404, "ไม่พบห้องนี้ ตรวจรหัสแล้วลองอีกครั้ง", "room_not_found");
    const nickname = normalizeNickname(body.nickname);
    const previous = getSession(request);
    if (previous?.roomCode === room.code && room.players.has(previous.playerId)) {
      const player = room.players.get(previous.playerId);
      issueSession(request, response, room, player);
      sendJson(response, 200, { room: stateFor(room, player.id) });
      return;
    }
    if (room.players.size >= maxPlayersPerRoom) throw new HttpError(429, `ห้องเต็มแล้ว (สูงสุด ${maxPlayersPerRoom} คน)`, "room_full");
    const player = createPlayer(nickname);
    room.players.set(player.id, player);
    issueSession(request, response, room, player);
    broadcast(room);
    sendJson(response, 201, { room: stateFor(room, player.id) });
    return;
  }

  const room = findRoom(roomCode);
  if (request.method === "GET" && action === "search") {
    const result = await searchYoutube(request, room, url);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && action === "state") {
    const player = getPlayer(request, room);
    sendJson(response, 200, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "GET" && action === "events") {
    const player = getPlayer(request, room);
    openEventStream(request, response, room, player);
    return;
  }

  if (request.method === "POST" && action === "host") {
    const currentPlayer = getPlayer(request, room);
    if (room.hostPlayerId !== currentPlayer.id) throw new HttpError(403, "เฉพาะโฮสต์เท่านั้นที่โอนสิทธิ์ได้", "host_required");
    const body = await readJson(request);
    if (room.hostPlayerId !== currentPlayer.id) throw new HttpError(403, "สิทธิ์โฮสต์เปลี่ยนแล้ว", "host_required");
    const target = room.players.get(String(body.playerId || ""));
    if (!target) throw new HttpError(404, "ไม่พบผู้เล่นที่เลือก", "player_not_found");
    if (target.id === currentPlayer.id) throw new HttpError(400, "คุณเป็นโฮสต์อยู่แล้ว", "already_host");
    room.hostPlayerId = target.id;
    if (room.playbackState === "playing") {
      room.playbackState = "paused";
      room.status = "paused";
    }
    broadcast(room);
    sendJson(response, 200, { room: stateFor(room, currentPlayer.id) });
    return;
  }

  if (request.method === "POST" && action === "kick") {
    const player = getPlayer(request, room);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "เฉพาะโฮสต์เท่านั้นที่นำผู้เล่นออกได้", "host_required");
    const body = await readJson(request);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "สิทธิ์โฮสต์เปลี่ยนแล้ว", "host_required");
    const targetId = String(body.playerId || "");
    if (targetId === player.id) throw new HttpError(400, "โฮสต์นำตัวเองออกไม่ได้", "cannot_kick_self");
    if (!room.players.has(targetId)) throw new HttpError(404, "ไม่พบผู้เล่นที่เลือก", "player_not_found");
    removePlayer(room, targetId, "removed", true);
    sendJson(response, 200, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "POST" && action === "play") {
    const player = getPlayer(request, room);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "เฉพาะโฮสต์เท่านั้นที่เริ่มเพลงได้", "host_required");
    if (room.currentSong && ["ready", "playing", "paused"].includes(room.playbackState)) {
      throw new HttpError(409, "ยังมีเพลงปัจจุบันอยู่ ให้เล่นต่อหรือข้ามเพลงก่อน", "current_song_active");
    }
    const nextSong = room.queue.shift();
    if (!nextSong) throw new HttpError(409, "คิวยังไม่มีเพลงถัดไป", "queue_empty");
    room.currentSong = nextSong;
    room.currentSingerId = nextSong.requesterId;
    room.playbackState = "ready";
    room.playbackErrorCode = null;
    room.score = { automaticScore: null, votes: new Map() };
    room.songReports = new Map();
    room.status = "ready";
    broadcast(room);
    sendJson(response, 200, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "POST" && action === "playback") {
    const player = getPlayer(request, room);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "เฉพาะโฮสต์เท่านั้นที่ควบคุมการเล่นได้", "host_required");
    const body = await readJson(request);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "สิทธิ์โฮสต์เปลี่ยนแล้ว", "host_required");
    const state = String(body.state || "");
    const videoId = String(body.videoId || "");
    if (!room.currentSong || room.currentSong.id !== String(body.entryId || "") || room.currentSong.videoId !== videoId) {
      throw new HttpError(409, "สถานะเพลงเปลี่ยนแล้ว", "stale_playback_event");
    }
    if (!["playing", "paused", "ended", "error"].includes(state)) {
      throw new HttpError(400, "สถานะการเล่นไม่ถูกต้อง", "invalid_playback_state");
    }
    room.playbackState = state === "ended" ? "awaiting_score" : state;
    room.status = room.playbackState;
    room.playbackErrorCode = state === "error" && [2, 5, 100, 101, 150, 153].includes(Number(body.errorCode))
      ? Number(body.errorCode)
      : null;
    broadcast(room);
    sendJson(response, 200, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "POST" && action === "skip") {
    const player = getPlayer(request, room);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "เฉพาะโฮสต์เท่านั้นที่ข้ามเพลงได้", "host_required");
    room.currentSong = null;
    room.currentSingerId = null;
    room.playbackState = "idle";
    room.playbackErrorCode = null;
    room.score = { automaticScore: null, votes: new Map() };
    room.songReports = new Map();
    room.status = "waiting";
    broadcast(room);
    sendJson(response, 200, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "POST" && action === "score") {
    const player = getPlayer(request, room);
    const body = await readJson(request);
    getPlayer(request, room);
    const kind = String(body.kind || "");
    if (!room.currentSong || room.playbackState !== "awaiting_score" || room.currentSong.id !== String(body.entryId || "") || room.currentSong.videoId !== String(body.videoId || "")) {
      throw new HttpError(409, "เพลงนี้ยังไม่พร้อมรับคะแนนแล้ว", "score_not_ready");
    }
    if (kind === "vote") {
      if (player.id === room.currentSingerId) throw new HttpError(403, "ผู้ร้องให้คะแนนตัวเองไม่ได้", "singer_cannot_vote");
      if (room.score.automaticScore) throw new HttpError(409, "เพลงนี้มีคะแนนอัตโนมัติแล้ว", "automatic_score_available");
      if (room.score.votes.has(player.id)) throw new HttpError(409, "คุณให้คะแนนเพลงนี้แล้ว", "vote_already_submitted");
      const vote = Number(body.vote);
      if (!Number.isInteger(vote) || vote < 1 || vote > 5) throw new HttpError(400, "เลือกคะแนนตั้งแต่ 1 ถึง 5", "invalid_vote");
      room.score.votes.set(player.id, vote);
    } else if (kind === "automatic") {
      if (player.id !== room.currentSingerId) throw new HttpError(403, "ส่งคะแนนไมค์ได้เฉพาะผู้ร้อง", "singer_required");
      if (room.score.automaticScore) throw new HttpError(409, "ส่งคะแนนเพลงนี้แล้ว", "score_already_submitted");
      const activeFrames = Number(body.activeFrames);
      const totalFrames = Number(body.totalFrames);
      const pitchStability = Number(body.pitchStability);
      if (!Number.isInteger(activeFrames) || !Number.isInteger(totalFrames) || activeFrames < 8 || totalFrames < 20 || activeFrames > totalFrames || totalFrames > 100_000 || !Number.isFinite(pitchStability) || pitchStability < 0 || pitchStability > 100) {
        throw new HttpError(400, "ข้อมูลคะแนนไมค์ไม่ถูกต้อง", "invalid_automatic_score");
      }
      const voiceCoverage = activeFrames / totalFrames * 100;
      const participationScore = Math.min(100, voiceCoverage / 35 * 100);
      const score = Math.round(participationScore * 0.6 + pitchStability * 0.4);
      room.score.automaticScore = {
        score,
        voiceCoverage: Math.round(voiceCoverage * 10) / 10,
        pitchStability: Math.round(pitchStability),
        activeFrames,
        totalFrames,
        submittedAt: Date.now(),
      };
    } else {
      throw new HttpError(400, "ชนิดคะแนนไม่ถูกต้อง", "invalid_score_kind");
    }
    broadcast(room);
    sendJson(response, 200, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "POST" && action === "report") {
    const player = getPlayer(request, room);
    const body = await readJson(request);
    getPlayer(request, room);
    if (!room.currentSong || room.currentSong.id !== String(body.entryId || "") || !["ready", "playing", "paused", "awaiting_score", "error"].includes(room.playbackState)) {
      throw new HttpError(409, "เพลงนี้ไม่พร้อมรับรายงานแล้ว", "report_not_available");
    }
    if (room.songReports.has(player.id)) throw new HttpError(409, "คุณรายงานเพลงนี้แล้ว", "report_already_submitted");
    const reason = String(body.reason || "");
    if (!["video_unavailable", "wrong_video", "audio_problem", "other"].includes(reason)) {
      throw new HttpError(400, "เลือกเหตุผลรายงานที่ถูกต้อง", "invalid_report_reason");
    }
    room.songReports.set(player.id, reason);
    broadcast(room);
    sendJson(response, 200, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "POST" && action === "queue") {
    const player = getPlayer(request, room);
    const body = await readJson(request);
    getPlayer(request, room);
    const videoId = String(body.videoId || "").trim();
    if (room.queue.length >= maxQueueSize) throw new HttpError(429, `คิวเต็มแล้ว (สูงสุด ${maxQueueSize} เพลง)`, "queue_full");
    if (room.queue.some((item) => item.videoId === videoId) || room.currentSong?.videoId === videoId) {
      throw new HttpError(409, "เพลงนี้อยู่ในคิวแล้ว", "duplicate_queue_item");
    }
    const songsByPlayer = room.queue.filter((item) => item.requesterId === player.id).length;
    if (songsByPlayer >= maxSongsPerPlayer) {
      throw new HttpError(429, `เพิ่มเพลงได้ไม่เกิน ${maxSongsPerPlayer} เพลงต่อคน`, "queue_limit_reached");
    }
    recordQueueAdd(player.id);
    const video = await verifyVideo(videoId);
    if (rooms.get(room.code) !== room) throw new HttpError(404, "ไม่พบห้องนี้ ตรวจรหัสแล้วลองอีกครั้ง", "room_not_found");
    getPlayer(request, room);
    if (room.queue.length >= maxQueueSize) throw new HttpError(429, `คิวเต็มแล้ว (สูงสุด ${maxQueueSize} เพลง)`, "queue_full");
    if (room.queue.some((item) => item.videoId === video.videoId) || room.currentSong?.videoId === video.videoId) {
      throw new HttpError(409, "เพลงนี้อยู่ในคิวแล้ว", "duplicate_queue_item");
    }
    if (room.queue.filter((item) => item.requesterId === player.id).length >= maxSongsPerPlayer) {
      throw new HttpError(429, `เพิ่มเพลงได้ไม่เกิน ${maxSongsPerPlayer} เพลงต่อคน`, "queue_limit_reached");
    }
    room.queue.push({
      id: randomUUID(),
      ...video,
      requesterId: player.id,
      requesterName: player.nickname,
      addedAt: Date.now(),
    });
    broadcast(room);
    sendJson(response, 201, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "POST" && action === "queue/remove") {
    const player = getPlayer(request, room);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "เฉพาะโฮสต์เท่านั้นที่นำเพลงออกได้", "host_required");
    const body = await readJson(request);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "สิทธิ์โฮสต์เปลี่ยนแล้ว", "host_required");
    const index = room.queue.findIndex((item) => item.id === String(body.entryId || ""));
    if (index < 0) throw new HttpError(404, "ไม่พบเพลงในคิว", "queue_item_not_found");
    room.queue.splice(index, 1);
    broadcast(room);
    sendJson(response, 200, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "POST" && action === "queue/reorder") {
    const player = getPlayer(request, room);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "เฉพาะโฮสต์เท่านั้นที่จัดคิวได้", "host_required");
    const body = await readJson(request);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "สิทธิ์โฮสต์เปลี่ยนแล้ว", "host_required");
    const index = room.queue.findIndex((item) => item.id === String(body.entryId || ""));
    if (index < 0) throw new HttpError(404, "ไม่พบเพลงในคิว", "queue_item_not_found");
    const offset = body.direction === "up" ? -1 : body.direction === "down" ? 1 : 0;
    if (!offset) throw new HttpError(400, "เลือกทิศทางจัดคิวไม่ถูกต้อง", "invalid_direction");
    const nextIndex = index + offset;
    if (nextIndex >= 0 && nextIndex < room.queue.length) {
      [room.queue[index], room.queue[nextIndex]] = [room.queue[nextIndex], room.queue[index]];
      broadcast(room);
    }
    sendJson(response, 200, { room: stateFor(room, player.id) });
    return;
  }

  if (request.method === "POST" && action === "leave") {
    const player = getPlayer(request, room);
    removePlayer(room, player.id);
    clearSessionCookie(response);
    sendJson(response, 200, { left: true });
    return;
  }

  if (request.method === "POST" && action === "close") {
    const player = getPlayer(request, room);
    if (room.hostPlayerId !== player.id) throw new HttpError(403, "เฉพาะโฮสต์เท่านั้นที่ปิดห้องได้", "host_required");
    closeRoom(room);
    clearSessionCookie(response);
    sendJson(response, 200, { closed: true });
    return;
  }

  throw new HttpError(405, "ไม่รองรับคำขอนี้", "method_not_allowed");
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "ไม่รองรับคำขอนี้", "method_not_allowed");
    const files = new Map([
      ["/", ["index.html", "text/html; charset=utf-8"]],
      ["/index.html", ["index.html", "text/html; charset=utf-8"]],
      ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
      ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
      ["/qrcodegen.js", ["qrcodegen.js", "text/javascript; charset=utf-8"]],
    ]);
    const file = files.get(url.pathname);
    if (!file) throw new HttpError(404, "ไม่พบหน้านี้", "not_found");
    const content = await readFile(path.join(publicRoot, file[0]));
    secureHeaders(response);
    response.writeHead(200, {
      "content-type": file[1],
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (!response.headersSent) sendError(response, error);
    else response.destroy();
  }
}

const server = createServer(handleRequest);
server.listen(port, host, () => {
  process.stdout.write(`Karaoke Club: http://${host}:${port}\n`);
});

server.on("close", () => {
  for (const room of rooms.values()) closeRoom(room, "server_stopped");
});
