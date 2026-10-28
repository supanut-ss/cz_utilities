const entryView = document.querySelector("#entry-view");
const roomView = document.querySelector("#room-view");
const skipLink = document.querySelector(".skip-link");
const entryFeedback = document.querySelector("#entry-feedback");
const roomFeedback = document.querySelector("#room-feedback");
const inviteDialog = document.querySelector("#invite-dialog");
const activeRoomKey = "karaoke-club-room";
const nicknameKey = "karaoke-club-nickname";
let eventSource = null;
let roomState = null;
let currentResults = [];
let nextPageToken = null;
let activeQuery = "";
let searchRequestId = 0;
let youtubeApiPromise = null;
let youtubePlayerPromise = null;
let youtubePlayer = null;
let youtubePlayerReady = false;
let youtubePlayerLoading = false;
let youtubePlayerError = false;
let pendingPlayerEvent = null;
let lastReportedPlayback = "";
let ignoredVideoId = "";
let cuedVideoId = "";
let playerNeedsRestart = false;
let expectedPlayback = null;
let micStream = null;
let micAudioContext = null;
let micAnalyser = null;
let micSource = null;
let micBuffer = null;
let micAnimationId = 0;
let micEntryId = "";
let micCanScore = false;
let micPermissionPending = false;
let micFrames = [];
let micPlaybackSeconds = 0;
let micSegmentStartedAt = 0;
let micLastSampleAt = 0;
let lastScoredEntryId = "";
let scoreSubmissionPending = false;
let reportSubmissionPending = false;
let reportFeedbackMessage = "";
let roomRecoveryPending = false;
let externalYoutubeCastEntryId = "";

function setEntryMessage(message, isError = false) {
  entryFeedback.textContent = message;
  entryFeedback.classList.toggle("is-error", isError);
}

function setRoomMessage(message, isError = false) {
  roomFeedback.textContent = message;
  roomFeedback.classList.toggle("is-error", isError);
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(body.message || "ทำรายการไม่สำเร็จ ลองอีกครั้ง");
  return body;
}

function savePlayerPreferences(nickname, roomCode) {
  localStorage.setItem(nicknameKey, nickname);
  localStorage.setItem(activeRoomKey, roomCode);
}

function showEntry(message = "") {
  const leavingRoom = !roomView.hidden;
  if (inviteDialog.open) inviteDialog.close();
  releaseMicrophone();
  lastScoredEntryId = "";
  if (eventSource) eventSource.close();
  eventSource = null;
  roomState = null;
  pendingPlayerEvent = null;
  lastReportedPlayback = "";
  ignoredVideoId = "";
  cuedVideoId = "";
  playerNeedsRestart = false;
  expectedPlayback = null;
  externalYoutubeCastEntryId = "";
  if (youtubePlayerReady) {
    try {
      youtubePlayer.stopVideo();
      youtubePlayer.clearVideo();
    } catch {}
  }
  currentResults = [];
  nextPageToken = null;
  activeQuery = "";
  searchRequestId += 1;
  document.querySelector("#search-results").replaceChildren();
  document.querySelector("#search-feedback").textContent = "";
  document.querySelector("#search-feedback").classList.remove("is-error");
  setRoomMessage("");
  roomView.hidden = true;
  entryView.hidden = false;
  skipLink.href = "#entry-title";
  if (leavingRoom) document.querySelector("#entry-title").focus();
  if (message) setEntryMessage(message);
}

function showRoom(room) {
  if (roomState?.roomCode === room.roomCode && roomState.revision > room.revision) return;
  const enteringRoom = roomView.hidden;
  const previousVideoId = roomState?.currentSong?.videoId || "";
  const previousEntryId = roomState?.currentSong?.id || "";
  const currentEntryId = room.currentSong?.id || "";
  if (previousEntryId !== currentEntryId) {
    externalYoutubeCastEntryId = "";
    lastScoredEntryId = "";
    if (micStream && micEntryId !== currentEntryId) releaseMicrophone();
    document.querySelector("#scoring-feedback").textContent = "";
    document.querySelector("#scoring-feedback").classList.remove("is-error");
    reportFeedbackMessage = "";
  }
  if (previousVideoId !== (room.currentSong?.videoId || "") || room.playbackState === "ready") {
    lastReportedPlayback = "";
  }
  if (expectedPlayback && expectedPlayback.entryId === room.currentSong?.id) {
    if (ignoredVideoId === expectedPlayback.videoId) ignoredVideoId = "";
    expectedPlayback = null;
  }
  if (ignoredVideoId && room.currentSong?.videoId && room.currentSong.videoId !== ignoredVideoId) ignoredVideoId = "";
  roomState = room;
  entryView.hidden = true;
  roomView.hidden = false;
  skipLink.href = "#room-title";
  if (enteringRoom) document.querySelector("#room-title").focus();
  document.querySelector("#room-code-display").textContent = room.roomCode;
  const statusLabels = {
    waiting: "ห้องกำลังรอเพลงแรก",
    ready: "พร้อมเริ่มเพลง",
    playing: "กำลังเล่นเพลง",
    paused: "หยุดเพลงชั่วคราว",
    awaiting_score: "เพลงจบแล้ว · รอเพลงถัดไป",
    error: "วิดีโอเล่นไม่สำเร็จ",
  };
  document.querySelector("#room-status").textContent = statusLabels[room.status] || "ห้องกำลังรอเพลงแรก";
  document.querySelector("#player-count").textContent = `${room.players.length} คนในห้อง`;
  document.querySelector("#player-count-badge").textContent = String(room.players.length);

  const hostControls = document.querySelector("#host-controls");
  const isHost = room.viewerId === room.hostPlayerId;
  hostControls.hidden = !isHost;

  const singer = room.players.find((player) => player.id === room.currentSingerId);
  const currentSong = room.currentSong;
  const stageKicker = document.querySelector("#stage-kicker");
  if (currentSong) {
    const stageHints = {
      awaiting_score: "เพลงจบแล้ว โฮสต์เริ่มเพลงถัดไปได้เมื่อพร้อม",
      ready: "ผู้ร้องเปิดไมค์คิดคะแนนได้ก่อนโฮสต์เริ่มเพลง",
      error: "ตรวจสถานะวิดีโอแล้วลองเพลงถัดไป หรือข้ามเพลงนี้",
      paused: "โฮสต์กดเล่นต่อจาก YouTube Player ได้",
    };
    const playbackLabels = {
      ready: "เพลงถัดไปบนเวที",
      playing: "กำลังเล่น",
      paused: "หยุดชั่วคราว",
      awaiting_score: "เพลงจบแล้ว",
      error: "เล่นวิดีโอไม่สำเร็จ",
    };
    stageKicker.textContent = playbackLabels[room.playbackState] || "เพลงบนเวที";
    document.querySelector("#stage-title").textContent = currentSong.title;
    document.querySelector("#singer-label").textContent = `ร้องโดย ${singer?.nickname || currentSong.requesterName}`;
    document.querySelector("#stage-hint").textContent = externalYoutubeCastEntryId === currentSong.id
      ? "เปิดเพลงใน YouTube เพื่อ Cast แล้ว · แอปไม่รับสถานะจากทีวี กลับมาแจ้งเพลงจบเอง"
      : stageHints[room.playbackState] || "ทุกคนเห็นเพลงและผู้ร้องคนเดียวกันในห้องนี้";
  } else {
    stageKicker.textContent = "ไมค์อยู่ที่ใคร";
    document.querySelector("#stage-title").textContent = "เวทีว่างอยู่";
    document.querySelector("#singer-label").textContent = "ยังไม่มีผู้ร้อง · รอเริ่มรอบแรก";
    document.querySelector("#stage-hint").textContent = "ชวนเพื่อนเข้าห้องได้เลย แล้วเลือกเพลงแรกด้วยกัน";
  }

  renderPlayers(room, isHost);
  renderQueue(room.queue || [], isHost);
  renderPlayback(room, isHost);
  renderScoring(room);
  if (currentResults.length) renderSearchResults(currentResults);
  flushPendingPlayerEvent();
}

function setPlayerMessage(message, isError = false) {
  const feedback = document.querySelector("#player-feedback");
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

function loadYoutubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise((resolve, reject) => {
    let script = document.querySelector("script[data-karaoke-youtube-api]");
    if (!script) {
      script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.dataset.karaokeYoutubeApi = "true";
    }
    let settled = false;
    const timeout = setTimeout(() => fail("YouTube Player API ไม่ตอบสนองภายใน 10 วินาที"), 10_000);
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      script.remove();
      youtubeApiPromise = null;
      reject(new Error(message));
    };
    window.onYouTubeIframeAPIReady = () => {
      if (settled) return;
      if (!window.YT?.Player) {
        fail("YouTube Player API โหลดไม่สมบูรณ์");
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    script.onerror = () => fail("เชื่อมต่อ YouTube Player API ไม่สำเร็จ");
    if (!script.isConnected) document.head.append(script);
  });
  return youtubeApiPromise;
}

function ensureYoutubePlayer() {
  if (youtubePlayerReady) return Promise.resolve(youtubePlayer);
  if (youtubePlayerPromise) return youtubePlayerPromise;
  youtubePlayerLoading = true;
  youtubePlayerError = false;
  setPlayerMessage("กำลังโหลด YouTube Player...");

  youtubePlayerPromise = loadYoutubeIframeApi().then(() => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      youtubePlayerLoading = false;
      youtubePlayerError = true;
      youtubePlayerPromise = null;
      setPlayerMessage("ตัวเล่นไม่พร้อมภายใน 10 วินาที ลองโหลดอีกครั้ง", true);
      reject(new Error("ตัวเล่น YouTube ไม่พร้อม"));
    }, 10_000);

    try {
      const initialVideoId = roomState?.currentSong?.videoId;
      if (initialVideoId) cuedVideoId = initialVideoId;
      playerNeedsRestart = ["playing", "paused"].includes(roomState?.playbackState);
      youtubePlayer = new window.YT.Player("youtube-player-target", {
        width: "100%",
        height: "100%",
        videoId: initialVideoId,
        playerVars: {
          controls: 1,
          fs: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            clearTimeout(timeout);
            youtubePlayerReady = true;
            youtubePlayerLoading = false;
            youtubePlayerError = false;
            setPlayerMessage("ตัวเล่นพร้อม · ใช้ปุ่มเปิด YouTube เพื่อส่งเพลงไปทีวี");
            syncPlayerToRoom();
            if (initialVideoId && roomState?.currentSong?.videoId === initialVideoId && roomState.playbackState === "playing" && roomState.viewerId === roomState.hostPlayerId) {
              playerNeedsRestart = true;
              setPlayerMessage("Player ใหม่จะเริ่มเพลงนี้ตั้งแต่ต้น");
              reportPlaybackState("paused", initialVideoId, roomState.currentSong.id);
            }
            if (roomState) renderPlayback(roomState, roomState.viewerId === roomState.hostPlayerId);
            resolve(youtubePlayer);
          },
          onStateChange: handlePlayerStateChange,
          onError: handlePlayerError,
        },
      });
    } catch {
      clearTimeout(timeout);
      youtubePlayerLoading = false;
      youtubePlayerError = true;
      youtubePlayerPromise = null;
      reject(new Error("สร้าง YouTube Player ไม่สำเร็จ"));
    }
  })).catch((error) => {
    youtubePlayerLoading = false;
    youtubePlayerError = true;
    youtubePlayerPromise = null;
    setPlayerMessage(error.message || "โหลด YouTube Player ไม่สำเร็จ", true);
    if (roomState) renderPlayback(roomState, roomState.viewerId === roomState.hostPlayerId);
    throw error;
  });
  return youtubePlayerPromise;
}

function getYoutubeVideoId() {
  try {
    return youtubePlayer?.getVideoData()?.video_id || "";
  } catch {
    return "";
  }
}

function syncPlayerToRoom() {
  if (!youtubePlayerReady || !roomState) return;
  const isHost = roomState.viewerId === roomState.hostPlayerId;
  if (!isHost) {
    try {
      if (youtubePlayer.getPlayerState() === window.YT.PlayerState.PLAYING) youtubePlayer.pauseVideo();
    } catch {}
    return;
  }
  const song = roomState.currentSong;
  if (!song || !["ready", "playing", "paused"].includes(roomState.playbackState)) return;
  if (getYoutubeVideoId() === song.videoId || cuedVideoId === song.videoId) return;

  pendingPlayerEvent = null;
  cuedVideoId = song.videoId;
  youtubePlayer.cueVideoById({ videoId: song.videoId, startSeconds: 0 });
  if (["playing", "paused"].includes(roomState.playbackState)) {
    playerNeedsRestart = true;
    setPlayerMessage("Player ใหม่จะเริ่มเพลงนี้ตั้งแต่ต้น");
  }
  if (roomState.playbackState === "playing") {
    reportPlaybackState("paused", song.videoId, song.id);
  }
}

function handlePlayerStateChange(event) {
  const videoId = event.target.getVideoData()?.video_id || "";
  if (videoId && videoId === ignoredVideoId) {
    if (event.data === window.YT.PlayerState.PLAYING && expectedPlayback?.videoId === videoId) ignoredVideoId = "";
    else return;
  }
  if (!videoId || ![window.YT.PlayerState.PLAYING, window.YT.PlayerState.PAUSED, window.YT.PlayerState.ENDED].includes(event.data)) return;
  if (expectedPlayback?.videoId === videoId && roomState?.currentSong?.id !== expectedPlayback.entryId) {
    pendingPlayerEvent = { kind: "state", ...expectedPlayback, state: event.data };
    return;
  }
  if (!roomState?.currentSong || roomState.currentSong.videoId !== videoId) return;
  const playerEvent = { kind: "state", videoId, entryId: roomState.currentSong.id, state: event.data };
  applyPlayerEvent(playerEvent);
}

function handlePlayerError(event) {
  const videoId = event.target.getVideoData()?.video_id || "";
  if (!videoId) return;
  if (videoId === ignoredVideoId) {
    if (expectedPlayback?.videoId === videoId) ignoredVideoId = "";
    else return;
  }
  if (expectedPlayback?.videoId === videoId && roomState?.currentSong?.id !== expectedPlayback.entryId) {
    pendingPlayerEvent = { kind: "error", ...expectedPlayback, errorCode: Number(event.data) };
    return;
  }
  if (!roomState?.currentSong || roomState.currentSong.videoId !== videoId) return;
  const playerEvent = { kind: "error", videoId, entryId: roomState.currentSong.id, errorCode: Number(event.data) };
  applyPlayerEvent(playerEvent);
}

function flushPendingPlayerEvent() {
  if (!pendingPlayerEvent) return;
  if (!roomState?.currentSong) {
    if (!expectedPlayback) pendingPlayerEvent = null;
    return;
  }
  if (pendingPlayerEvent.entryId !== roomState.currentSong.id) {
    if (!expectedPlayback || pendingPlayerEvent.entryId !== expectedPlayback.entryId) pendingPlayerEvent = null;
    return;
  }
  if (pendingPlayerEvent.videoId !== roomState.currentSong.videoId) {
    pendingPlayerEvent = null;
    return;
  }
  const playerEvent = pendingPlayerEvent;
  pendingPlayerEvent = null;
  applyPlayerEvent(playerEvent);
}

function applyPlayerEvent(playerEvent) {
  if (!roomState || roomState.viewerId !== roomState.hostPlayerId || roomState.currentSong?.id !== playerEvent.entryId || roomState.currentSong.videoId !== playerEvent.videoId) return;
  if (playerEvent.kind === "error") {
    const errors = {
      2: "รหัสวิดีโอไม่ถูกต้อง",
      5: "วิดีโอนี้เล่นด้วย HTML5 Player ไม่ได้",
      100: "วิดีโอถูกลบหรือเป็นส่วนตัว",
      101: "เจ้าของวิดีโอไม่อนุญาตให้ฝัง",
      150: "เจ้าของวิดีโอไม่อนุญาตให้ฝัง",
      153: "YouTube ไม่พบข้อมูลระบุตัวผู้เล่น",
    };
    setPlayerMessage(`เล่นวิดีโอไม่ได้: ${errors[playerEvent.errorCode] || "เกิดข้อผิดพลาด"}`, true);
    reportPlaybackState("error", playerEvent.videoId, playerEvent.entryId, playerEvent.errorCode);
    return;
  }
  const states = new Map([
    [window.YT.PlayerState.PLAYING, "playing"],
    [window.YT.PlayerState.PAUSED, "paused"],
    [window.YT.PlayerState.ENDED, "ended"],
  ]);
  const state = states.get(playerEvent.state);
  if (state === "playing") playerNeedsRestart = false;
  if (state) reportPlaybackState(state, playerEvent.videoId, playerEvent.entryId);
}

async function reportPlaybackState(state, videoId, entryId, errorCode = null) {
  if (!roomState || roomState.viewerId !== roomState.hostPlayerId || roomState.currentSong?.id !== entryId || roomState.currentSong.videoId !== videoId) return false;
  const signature = `${entryId}:${videoId}:${state}:${errorCode || ""}`;
  if (lastReportedPlayback === signature) return false;
  lastReportedPlayback = signature;
  const roomCode = roomState.roomCode;
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/playback`, {
      method: "POST",
      body: JSON.stringify({ state, videoId, entryId, errorCode }),
    });
    if (roomState?.roomCode === roomCode && roomState.currentSong?.id === entryId) showRoom(response.room);
    return true;
  } catch (error) {
    if (roomState?.roomCode !== roomCode || roomState.currentSong?.id !== entryId) return false;
    if (error.message !== "สถานะเพลงเปลี่ยนแล้ว") {
      lastReportedPlayback = "";
      setPlayerMessage(error.message, true);
    }
    return false;
  }
}

function renderPlayback(room, isHost) {
  const frame = document.querySelector("#player-frame");
  const artwork = document.querySelector("#stage-art");
  const stageMain = document.querySelector(".stage-main");
  const playButton = document.querySelector("#play-song-button");
  const youtubeCastLink = document.querySelector("#youtube-cast-link");
  const finishCastButton = document.querySelector("#finish-cast-button");
  const skipButton = document.querySelector("#skip-song-button");
  const currentSong = room.currentSong;
  const activePlayback = currentSong && ["ready", "playing", "paused"].includes(room.playbackState);
  const showPlayer = Boolean(isHost && activePlayback);
  frame.hidden = !showPlayer;
  artwork.hidden = Boolean(showPlayer);
  stageMain.classList.toggle("is-focused", Boolean(showPlayer));

  const canStartNext = !currentSong || ["awaiting_score", "error", "idle"].includes(room.playbackState);
  const canResume = currentSong && room.playbackState === "paused";
  const canStartCurrent = currentSong && room.playbackState === "ready";
  const canStart = Boolean(canStartNext && room.queue.length) || Boolean(canResume) || Boolean(canStartCurrent);
  youtubeCastLink.hidden = !isHost || !activePlayback;
  youtubeCastLink.href = currentSong ? `https://www.youtube.com/watch?v=${encodeURIComponent(currentSong.videoId)}` : "https://www.youtube.com/";
  youtubeCastLink.setAttribute("aria-label", currentSong ? `เปิด ${currentSong.title} บน YouTube ในแท็บใหม่เพื่อ Cast` : "เปิด YouTube เพื่อ Cast");
  finishCastButton.hidden = !isHost || externalYoutubeCastEntryId !== currentSong?.id || !["playing", "paused"].includes(room.playbackState);
  playButton.hidden = !isHost || room.playbackState === "playing";
  playButton.disabled = !canStart || (youtubePlayerLoading && (canResume || canStartCurrent));
  if (externalYoutubeCastEntryId === currentSong?.id && canResume) playButton.textContent = "กลับมาเล่นในแอป";
  else if (canResume) playButton.textContent = playerNeedsRestart ? "เริ่มเพลงนี้อีกครั้ง" : youtubePlayerReady ? "เล่นต่อ" : youtubePlayerLoading ? "กำลังโหลด Player" : "โหลด Player เพื่อเล่นต่อ";
  else if (canStartCurrent) playButton.textContent = youtubePlayerReady ? "แตะเพื่อเริ่มเพลงนี้" : youtubePlayerLoading ? "กำลังโหลด Player" : "โหลด Player อีกครั้ง";
  else playButton.textContent = room.queue.length ? "เริ่มเพลงถัดไป" : "คิวหมดแล้ว";
  skipButton.hidden = !isHost || !currentSong || room.playbackState === "awaiting_score";

  if (!isHost) {
    setPlayerMessage("");
    syncPlayerToRoom();
  } else if (showPlayer && !youtubePlayerReady && !youtubePlayerLoading && !youtubePlayerError) {
    ensureYoutubePlayer().catch(() => {});
    playButton.disabled = true;
  } else if (showPlayer && youtubePlayerError) {
    setPlayerMessage("เชื่อมต่อ YouTube Player ไม่สำเร็จ · กดปุ่มเพื่อโหลดใหม่", true);
  } else if (showPlayer && youtubePlayerReady) {
    syncPlayerToRoom();
  } else if (currentSong && room.playbackState === "awaiting_score") {
    setPlayerMessage("เพลงจบแล้ว · เลือกเพลงถัดไปจากคิวได้เลย");
  } else if (currentSong && room.playbackState === "error") {
    setPlayerMessage(`YouTube Player แจ้งข้อผิดพลาด${room.playbackErrorCode ? ` ${room.playbackErrorCode}` : ""}`, true);
  } else if (isHost) {
    setPlayerMessage("");
  }
}

function setScoringMessage(message, isError = false) {
  const feedback = document.querySelector("#scoring-feedback");
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

function releaseMicrophone() {
  if (micAnimationId) cancelAnimationFrame(micAnimationId);
  micAnimationId = 0;
  const stream = micStream;
  micStream = null;
  if (micSource) {
    try { micSource.disconnect(); } catch {}
  }
  micSource = null;
  micAnalyser = null;
  micBuffer = null;
  if (micAudioContext && micAudioContext.state !== "closed") micAudioContext.close().catch(() => {});
  micAudioContext = null;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  micEntryId = "";
  micCanScore = false;
  micFrames = [];
  micPlaybackSeconds = 0;
  micSegmentStartedAt = 0;
  micLastSampleAt = 0;
  const meter = document.querySelector("#mic-level-meter");
  if (meter) meter.value = 0;
}

function stopMicSegment() {
  if (!micSegmentStartedAt) return;
  micPlaybackSeconds += (performance.now() - micSegmentStartedAt) / 1000;
  micSegmentStartedAt = 0;
}

function startMicSegment() {
  if (!micAnalyser || !micCanScore || micSegmentStartedAt) return;
  micSegmentStartedAt = performance.now();
  micLastSampleAt = 0;
}

function estimatePitch(buffer, sampleRate) {
  let mean = 0;
  let squareSum = 0;
  for (let index = 0; index < buffer.length; index += 2) {
    mean += buffer[index];
  }
  const sampleCount = Math.ceil(buffer.length / 2);
  mean /= sampleCount;
  for (let index = 0; index < buffer.length; index += 2) {
    const centered = buffer[index] - mean;
    squareSum += centered * centered;
  }
  const rms = Math.sqrt(squareSum / sampleCount);
  if (rms < 0.009) return { midi: null, rms };

  const effectiveRate = sampleRate / 2;
  const effectiveLength = sampleCount;
  const minimumLag = Math.max(2, Math.floor(effectiveRate / 1000));
  const maximumLag = Math.min(Math.floor(effectiveRate / 55), Math.floor(effectiveLength / 2));
  let bestLag = 0;
  let bestCorrelation = 0;
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let product = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index < effectiveLength - lag; index += 1) {
      const left = buffer[index * 2] - mean;
      const right = buffer[(index + lag) * 2] - mean;
      product += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const correlation = product / Math.sqrt(leftEnergy * rightEnergy || 1);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  if (!bestLag || bestCorrelation < 0.62) return { midi: null, rms };
  const frequency = effectiveRate / bestLag;
  return { midi: 69 + 12 * Math.log2(frequency / 440), rms };
}

function sampleMicrophone() {
  if (!micAnalyser || !micBuffer) return;
  micAnalyser.getFloatTimeDomainData(micBuffer);
  let squareSum = 0;
  for (const value of micBuffer) squareSum += value * value;
  const rms = Math.sqrt(squareSum / micBuffer.length);
  const meter = document.querySelector("#mic-level-meter");
  if (meter) meter.value = Math.min(1, rms * 8);

  const now = performance.now();
  if (micSegmentStartedAt && now - micLastSampleAt >= 80) {
    const estimate = estimatePitch(micBuffer, micAudioContext.sampleRate);
    micFrames.push({
      time: micPlaybackSeconds + (now - micSegmentStartedAt) / 1000,
      midi: estimate.midi,
      rms: estimate.rms,
      voiced: estimate.midi !== null && estimate.rms >= 0.009,
    });
    micLastSampleAt = now;
  }
  micAnimationId = requestAnimationFrame(sampleMicrophone);
}

async function enableMicrophone() {
  const song = roomState?.currentSong;
  if (!song || roomState.viewerId !== roomState.currentSingerId || roomState.playbackState !== "ready" || micPermissionPending) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setScoringMessage("เบราว์เซอร์นี้ใช้ไมค์ไม่ได้ หรือหน้าเว็บต้องเปิดผ่าน HTTPS", true);
    return;
  }

  const roomCode = roomState.roomCode;
  const entryId = song.id;
  micPermissionPending = true;
  renderScoring(roomState);
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("เบราว์เซอร์นี้ไม่รองรับการวิเคราะห์เสียง");
    micAudioContext = new AudioContextClass();
    const audioResume = micAudioContext.resume().then(() => null, (error) => error);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (roomState?.roomCode !== roomCode || roomState.currentSong?.id !== entryId || roomState.playbackState !== "ready" || roomState.viewerId !== roomState.currentSingerId) {
      stream.getTracks().forEach((track) => track.stop());
      releaseMicrophone();
      setScoringMessage("เพลงเริ่มหรือเปลี่ยนไปก่อนเปิดไมค์เสร็จ ใช้โหวตหลังเพลงจบได้");
      return;
    }

    micStream = stream;
    micEntryId = entryId;
    micFrames = [];
    micPlaybackSeconds = 0;
    const resumeError = await audioResume;
    if (resumeError) throw resumeError;
    if (roomState?.roomCode !== roomCode || roomState.currentSong?.id !== entryId || roomState.playbackState !== "ready" || roomState.viewerId !== roomState.currentSingerId) {
      releaseMicrophone();
      setScoringMessage("เพลงเริ่มหรือเปลี่ยนไปก่อนเปิดไมค์พร้อม ใช้โหวตหลังเพลงจบได้");
      return;
    }
    micCanScore = true;
    micAnalyser = micAudioContext.createAnalyser();
    micAnalyser.fftSize = 4096;
    micAnalyser.smoothingTimeConstant = 0;
    micSource = micAudioContext.createMediaStreamSource(stream);
    micSource.connect(micAnalyser);
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (micStream !== stream) return;
        releaseMicrophone();
        setScoringMessage("ไมค์ถูกปิดแล้ว ใช้คะแนนโหวตหลังเพลงจบได้", true);
        if (roomState) renderScoring(roomState);
      }, { once: true });
    }
    micBuffer = new Float32Array(micAnalyser.fftSize);
    micAnimationId = requestAnimationFrame(sampleMicrophone);
    setScoringMessage("เปิดไมค์แล้ว · วิเคราะห์เสียงและ pitch ในเครื่องเท่านั้น");
  } catch (error) {
    releaseMicrophone();
    const message = error.name === "NotAllowedError"
      ? "ไม่ได้รับอนุญาตใช้ไมค์ · ตรวจสิทธิ์ไมค์ของเบราว์เซอร์แล้วลองอีกครั้ง"
      : error.name === "NotFoundError"
        ? "ไม่พบไมโครโฟนที่ใช้ได้"
        : error.message || "เปิดไมค์ไม่สำเร็จ";
    setScoringMessage(message, true);
  } finally {
    micPermissionPending = false;
    if (roomState) renderScoring(roomState);
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function calculateVoiceScore(frames) {
  const voicedFrames = frames.filter((frame) => frame.voiced && Number.isFinite(frame.midi));
  if (frames.length < 20 || voicedFrames.length < 8) return null;

  const localDeviations = [];
  let left = 0;
  let right = 0;
  for (let index = 0; index < voicedFrames.length; index += 1) {
    const current = voicedFrames[index];
    while (left < index && current.time - voicedFrames[left].time > 0.2) left += 1;
    if (right < index) right = index;
    while (right + 1 < voicedFrames.length && voicedFrames[right + 1].time - current.time <= 0.2) right += 1;
    const local = voicedFrames.slice(left, right + 1).map((frame) => frame.midi);
    if (local.length < 3) continue;
    const center = median(local);
    localDeviations.push(median(local.map((pitch) => Math.abs(pitch - center))));
  }
  if (localDeviations.length < 3) return null;

  const pitchStability = Math.max(0, Math.min(100, 100 - median(localDeviations) * 30));
  return {
    activeFrames: voicedFrames.length,
    totalFrames: frames.length,
    pitchStability: Math.round(pitchStability),
  };
}

async function submitScore(kind, details) {
  if (!roomState?.currentSong || scoreSubmissionPending) return;
  const roomCode = roomState.roomCode;
  const song = roomState.currentSong;
  scoreSubmissionPending = true;
  renderScoring(roomState);
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/score`, {
      method: "POST",
      body: JSON.stringify({ kind, entryId: song.id, videoId: song.videoId, ...details }),
    });
    if (roomState?.roomCode === roomCode && roomState.currentSong?.id === song.id) showRoom(response.room);
  } catch (error) {
    if (roomState?.roomCode === roomCode && roomState.currentSong?.id === song.id) setScoringMessage(error.message, true);
  } finally {
    scoreSubmissionPending = false;
    if (roomState) renderScoring(roomState);
  }
}

function finishMicrophoneScoring(room) {
  const song = room.currentSong;
  if (!song || lastScoredEntryId === song.id) return;
  if (!micStream || micEntryId !== song.id || !micCanScore) {
    if (micStream) releaseMicrophone();
    return;
  }
  lastScoredEntryId = song.id;
  stopMicSegment();
  const score = calculateVoiceScore([...micFrames]);
  releaseMicrophone();
  if (!score) {
    setScoringMessage("เสียงที่จับได้ยังไม่พอสำหรับคิดคะแนนอัตโนมัติ ใช้คะแนนโหวตแทนได้");
    return;
  }
  setScoringMessage("กำลังบันทึกคะแนนสรุป...");
  submitScore("automatic", score);
}

function syncMicrophoneWithRoom(room) {
  const song = room.currentSong;
  if (micStream && (!song || micEntryId !== song.id || room.viewerId !== room.currentSingerId)) {
    releaseMicrophone();
    return;
  }
  if (!micStream) return;
  if (room.playbackState === "awaiting_score") {
    finishMicrophoneScoring(room);
    return;
  }
  if (room.playbackState === "error" || room.playbackState === "idle") {
    releaseMicrophone();
    return;
  }
  if (room.playbackState === "playing" && micCanScore) startMicSegment();
  else stopMicSegment();
}

function renderScoring(room) {
  const panel = document.querySelector("#scoring-panel");
  const song = room.currentSong;
  panel.hidden = !song;
  if (!song) {
    syncMicrophoneWithRoom(room);
    return;
  }
  syncMicrophoneWithRoom(room);

  const isSinger = room.viewerId === room.currentSingerId;
  const awaitingScore = room.playbackState === "awaiting_score";
  const microphoneActiveStage = ["ready", "playing", "paused"].includes(room.playbackState);
  const modeBadge = document.querySelector("#scoring-mode-badge");
  const status = document.querySelector("#scoring-status");
  const micControls = document.querySelector("#mic-controls");
  const enableMicButton = document.querySelector("#enable-mic-button");
  const stopMicButton = document.querySelector("#stop-mic-button");
  const micStatus = document.querySelector("#mic-status");
  const automaticResult = document.querySelector("#automatic-score-result");
  const votePanel = document.querySelector("#vote-panel");
  const automaticScore = room.scoring?.automaticScore;

  modeBadge.textContent = "คะแนนประมาณการ";
  micControls.hidden = !(isSinger && microphoneActiveStage);
  enableMicButton.hidden = Boolean(micStream);
  enableMicButton.disabled = micPermissionPending || room.playbackState !== "ready";
  stopMicButton.hidden = !micStream;
  micStatus.textContent = micStream
    ? micCanScore ? "ไมค์พร้อม · วิเคราะห์ค่าระดับเสียงและ pitch ในเครื่อง ไม่บันทึกเสียง" : "ไมค์เปิดหลังเพลงเริ่ม จึงใช้คะแนนโหวตแทน"
    : room.playbackState === "ready" ? "เปิดไมค์ก่อนเริ่มเพลง · ประเมินเสียงที่มี pitch ไม่เทียบกับทำนอง" : "เปิดไมค์ก่อนเริ่มเพลงจึงจะคิดคะแนนจากเสียงได้";

  if (isSinger) {
    status.textContent = awaitingScore
      ? automaticScore ? "คำนวณคะแนนจากสัญญาณไมค์เสร็จแล้ว" : "ไม่มีข้อมูลเสียงพอสำหรับคะแนนไมค์ · ใช้คะแนนโหวตได้"
      : "คะแนนประเมินจากสัดส่วนเสียงที่มี pitch และความนิ่ง · ไม่ตรวจความตรงกับเพลง";
  } else {
    status.textContent = awaitingScore
      ? automaticScore ? "แสดงคะแนนประเมินจากไมค์ของผู้ร้อง" : "ยังไม่มีคะแนนไมค์ · ช่วยโหวตให้ผู้ร้องได้"
      : "เมื่อเพลงจบ จะแสดงคะแนนจากไมค์หรือเปิดให้ผู้ฟังโหวต";
  }

  automaticResult.hidden = !automaticScore;
  if (automaticScore) {
    document.querySelector("#automatic-score-value").textContent = `${automaticScore.score}/100`;
    document.querySelector("#automatic-score-detail").textContent = `สัญญาณมี pitch ${automaticScore.voiceCoverage}% · ความนิ่ง ${automaticScore.pitchStability}/100`;
  }

  votePanel.hidden = !awaitingScore || Boolean(automaticScore && !room.scoring?.voteCount);
  const votePrompt = document.querySelector("#vote-prompt");
  const voteSummary = document.querySelector("#vote-summary");
  const voteButtons = [...votePanel.querySelectorAll("[data-vote]")];
  if (automaticScore && room.scoring?.voteCount) votePrompt.textContent = "คะแนนโหวตที่ส่งก่อนคะแนนไมค์";
  else if (room.scoring?.canVote) votePrompt.textContent = "ให้คะแนนเสียงร้อง 1–5";
  else if (room.scoring?.hasVoted) votePrompt.textContent = "คุณให้คะแนนเพลงนี้แล้ว";
  else if (isSinger) votePrompt.textContent = "ผู้ร้องให้คะแนนตัวเองไม่ได้";
  else votePrompt.textContent = "ปิดรับคะแนนจากเพลงนี้แล้ว";
  voteSummary.textContent = room.scoring?.voteCount
    ? `คะแนนเฉลี่ย ${room.scoring.averageVote}/5 จาก ${room.scoring.voteCount} คน`
    : "ยังไม่มีคะแนนโหวต";
  for (const button of voteButtons) button.disabled = !room.scoring?.canVote || scoreSubmissionPending;

  const reportButton = document.querySelector("#song-report-button");
  const reportReason = document.querySelector("#song-report-reason");
  const reportStatus = document.querySelector("#song-report-status");
  const reportSummary = room.songReports || { count: 0, hasReported: false };
  const reasonLabels = {
    video_unavailable: "เปิดไม่ได้",
    wrong_video: "ผิดเพลง",
    audio_problem: "เสียงมีปัญหา",
    other: "อื่นๆ",
  };
  const reportBreakdown = Object.entries(reportSummary.reasons || {})
    .map(([reason, count]) => `${reasonLabels[reason] || "อื่นๆ"} ${count}`)
    .join(" · ");
  reportButton.disabled = reportSubmissionPending || reportSummary.hasReported;
  reportReason.disabled = reportSubmissionPending || reportSummary.hasReported;
  reportStatus.textContent = reportFeedbackMessage || (reportSummary.hasReported
    ? `ส่งรายงานแล้ว · รวม ${reportSummary.count} รายการ${reportBreakdown ? ` · ${reportBreakdown}` : ""}`
    : reportSummary.count
      ? `มีรายงาน ${reportSummary.count} รายการ${reportBreakdown ? ` · ${reportBreakdown}` : ""} · ส่งได้คนละ 1 ครั้งต่อเพลง`
      : "รายงานได้คนละ 1 ครั้งต่อเพลง");
}

function voteForSinger(vote) {
  if (!roomState?.scoring?.canVote) return;
  submitScore("vote", { vote });
}

async function reportCurrentSong(event) {
  event.preventDefault();
  if (!roomState?.currentSong || reportSubmissionPending || roomState.songReports?.hasReported) return;
  const roomCode = roomState.roomCode;
  const song = roomState.currentSong;
  const reason = document.querySelector("#song-report-reason").value;
  reportFeedbackMessage = "";
  reportSubmissionPending = true;
  renderScoring(roomState);
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/report`, {
      method: "POST",
      body: JSON.stringify({ entryId: song.id, reason }),
    });
    if (roomState?.roomCode === roomCode && roomState.currentSong?.id === song.id) showRoom(response.room);
  } catch (error) {
    reportFeedbackMessage = error.message;
  } finally {
    reportSubmissionPending = false;
    if (roomState) renderScoring(roomState);
  }
}

function renderPlayers(room, isHost) {
  const list = document.querySelector("#player-list");
  list.replaceChildren();
  for (const player of room.players) {
    const item = document.createElement("li");
    item.className = "player-row";

    const avatar = document.createElement("span");
    avatar.className = "player-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = Array.from(player.nickname)[0] || "•";

    const identity = document.createElement("div");
    identity.className = "player-identity";
    const nameLine = document.createElement("div");
    nameLine.className = "player-name-line";
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.nickname;
    nameLine.append(name);

    if (player.id === room.hostPlayerId) {
      const hostBadge = document.createElement("span");
      hostBadge.className = "host-badge";
      hostBadge.textContent = "โฮสต์";
      nameLine.append(hostBadge);
    }
    if (player.id === room.viewerId) {
      const selfBadge = document.createElement("span");
      selfBadge.className = "self-badge";
      selfBadge.textContent = "คุณ";
      nameLine.append(selfBadge);
    }

    const presence = document.createElement("span");
    presence.className = `player-presence${player.isOnline ? " is-online" : ""}`;
    presence.textContent = player.isOnline ? "อยู่ในห้อง" : "หลุดชั่วคราว";
    identity.append(nameLine, presence);

    item.append(avatar, identity);
    if (isHost && player.id !== room.viewerId) {
      const actions = document.createElement("div");
      actions.className = "player-actions";
      const transfer = document.createElement("button");
      transfer.className = "transfer-button";
      transfer.type = "button";
      transfer.textContent = "โอน";
      transfer.setAttribute("aria-label", `โอนสิทธิ์โฮสต์ให้ ${player.nickname}`);
      transfer.addEventListener("click", () => transferHost(player));
      const remove = document.createElement("button");
      remove.className = "kick-button";
      remove.type = "button";
      remove.textContent = "นำออก";
      remove.setAttribute("aria-label", `นำ ${player.nickname} ออกจากห้อง`);
      remove.addEventListener("click", () => removeRoomPlayer(player));
      actions.append(transfer, remove);
      item.append(actions);
    }
    list.append(item);
  }
}

function renderQueue(queue, isHost) {
  const list = document.querySelector("#queue-list");
  const empty = document.querySelector("#queue-empty");
  list.replaceChildren();
  empty.hidden = queue.length > 0;
  document.querySelector("#queue-count").textContent = String(queue.length);

  for (const [index, song] of queue.entries()) {
    const item = document.createElement("li");
    item.className = "queue-row";
    const position = document.createElement("span");
    position.className = "queue-position";
    position.textContent = String(index + 1).padStart(2, "0");

    const artwork = document.createElement("span");
    artwork.className = "song-artwork";
    const thumbnail = safeThumbnailUrl(song.thumbnail);
    if (thumbnail) {
      const image = document.createElement("img");
      image.src = thumbnail;
      image.alt = "";
      image.loading = "lazy";
      artwork.append(image);
    }

    const details = document.createElement("div");
    details.className = "song-details";
    const title = document.createElement("strong");
    title.textContent = song.title;
    const meta = document.createElement("span");
    meta.textContent = `${song.channelTitle}${song.durationLabel ? ` · ${song.durationLabel}` : ""}`;
    const requester = document.createElement("span");
    requester.className = "song-requester";
    requester.textContent = `ขอโดย ${song.requesterName}`;
    details.append(title, meta, requester);

    item.append(position, artwork, details);
    if (isHost) {
      const actions = document.createElement("div");
      actions.className = "queue-actions";
      const up = createQueueAction("ขึ้น", `เลื่อน ${song.title} ขึ้น`, "up", song);
      const down = createQueueAction("ลง", `เลื่อน ${song.title} ลง`, "down", song);
      up.disabled = index === 0;
      down.disabled = index === queue.length - 1;
      const remove = document.createElement("button");
      remove.className = "queue-remove";
      remove.type = "button";
      remove.textContent = "นำออก";
      remove.setAttribute("aria-label", `นำ ${song.title} ออกจากคิว`);
      remove.addEventListener("click", () => updateQueue("remove", song));
      actions.append(up, down, remove);
      item.append(actions);
    }
    list.append(item);
  }
}

function createQueueAction(label, accessibleName, direction, song) {
  const button = document.createElement("button");
  button.className = "queue-move";
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", accessibleName);
  button.addEventListener("click", () => updateQueue("reorder", song, direction));
  return button;
}

function safeThumbnailUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "i.ytimg.com" ? url.href : "";
  } catch {
    return "";
  }
}

function renderSearchResults(items) {
  const box = document.querySelector("#search-results");
  box.replaceChildren();
  for (const video of items) {
    const row = document.createElement("article");
    row.className = "search-result";
    const artwork = document.createElement("span");
    artwork.className = "search-artwork";
    const thumbnail = safeThumbnailUrl(video.thumbnail);
    if (thumbnail) {
      const image = document.createElement("img");
      image.src = thumbnail;
      image.alt = "";
      image.loading = "lazy";
      artwork.append(image);
    }

    const details = document.createElement("div");
    details.className = "search-details";
    const title = document.createElement("strong");
    title.textContent = video.title;
    const meta = document.createElement("span");
    meta.textContent = `${video.channelTitle}${video.durationLabel ? ` · ${video.durationLabel}` : ""}`;
    const badges = document.createElement("span");
    badges.className = "video-badges";
    const embed = document.createElement("span");
    embed.className = `video-badge ${video.embeddable === true ? "video-badge-ready" : "video-badge-blocked"}`;
    embed.textContent = video.embeddable === true ? "ฝังได้" : video.embeddable === false ? "ฝังไม่ได้" : "ยังไม่ยืนยัน";
    badges.append(embed);
    if (typeof video.madeForKids === "boolean") {
      const kids = document.createElement("span");
      kids.className = "video-badge";
      kids.textContent = video.madeForKids ? "Made for Kids" : "ไม่ใช่ Made for Kids";
      badges.append(kids);
    }
    details.append(title, meta, badges);

    const add = document.createElement("button");
    add.className = "add-song-button";
    add.type = "button";
    const alreadyQueued = roomState?.queue?.some((song) => song.videoId === video.videoId);
    add.textContent = alreadyQueued ? "อยู่ในคิว" : "เพิ่มเพลง";
    add.disabled = alreadyQueued || video.embeddable !== true;
    add.setAttribute("aria-label", `${alreadyQueued ? "อยู่ในคิวแล้ว" : "เพิ่มเพลง"}: ${video.title}`);
    if (!add.disabled) add.addEventListener("click", () => addSong(video));
    row.append(artwork, details, add);
    box.append(row);
  }
}

async function runSearch(append = false) {
  if (!roomState) return;
  const roomCode = roomState.roomCode;
  const requestId = ++searchRequestId;
  const box = document.querySelector("#search-results");
  const feedback = document.querySelector("#search-feedback");
  if (!append) {
    activeQuery = document.querySelector("#music-query").value.trim();
    currentResults = [];
    nextPageToken = null;
    box.replaceChildren();
  }
  if (!activeQuery) return;
  feedback.classList.remove("is-error");
  feedback.textContent = append ? "กำลังโหลดผลเพิ่ม..." : "กำลังค้นหาเพลง...";
  document.querySelector("#load-more-button").hidden = true;
  const params = new URLSearchParams({ q: activeQuery });
  if (append && nextPageToken) params.set("pageToken", nextPageToken);
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/search?${params}`);
    if (requestId !== searchRequestId || roomState?.roomCode !== roomCode) return;
    currentResults = append ? [...currentResults, ...response.items] : response.items;
    nextPageToken = response.nextPageToken;
    feedback.textContent = response.statusWarning || (currentResults.length ? `พบ ${currentResults.length} เพลง` : "ไม่พบเพลงที่ตรงกับคำค้น");
    renderSearchResults(currentResults);
    document.querySelector("#load-more-button").hidden = !nextPageToken;
  } catch (error) {
    if (requestId !== searchRequestId || roomState?.roomCode !== roomCode) return;
    feedback.textContent = error.message;
    feedback.classList.add("is-error");
  }
}

async function addSong(video) {
  if (!roomState) return;
  const roomCode = roomState.roomCode;
  const feedback = document.querySelector("#search-feedback");
  feedback.classList.remove("is-error");
  feedback.textContent = "กำลังตรวจสอบวิดีโอและเพิ่มเข้าคิว...";
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/queue`, {
      method: "POST",
      body: JSON.stringify({ videoId: video.videoId }),
    });
    if (roomState?.roomCode !== roomCode) return;
    showRoom(response.room);
    setRoomMessage(`เพิ่ม “${video.title}” เข้าคิวแล้ว`);
    feedback.textContent = "เพิ่มเพลงเข้าคิวแล้ว";
  } catch (error) {
    if (roomState?.roomCode !== roomCode) return;
    feedback.textContent = error.message;
    feedback.classList.add("is-error");
  }
}

async function updateQueue(action, song, direction = "") {
  if (!roomState) return;
  const roomCode = roomState.roomCode;
  const body = { entryId: song.id };
  if (direction) body.direction = direction;
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/queue/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (roomState?.roomCode !== roomCode) return;
    showRoom(response.room);
    setRoomMessage(action === "remove" ? `นำ “${song.title}” ออกจากคิวแล้ว` : "จัดลำดับคิวแล้ว");
  } catch (error) {
    if (roomState?.roomCode !== roomCode) return;
    setRoomMessage(error.message, true);
  }
}

async function startOrContinueSong() {
  if (!roomState || roomState.viewerId !== roomState.hostPlayerId) return;
  const roomCode = roomState.roomCode;
  const currentSong = roomState.currentSong;
  const currentPlaybackState = roomState.playbackState;

  if (externalYoutubeCastEntryId === currentSong?.id && ["ready", "paused"].includes(currentPlaybackState)) {
    externalYoutubeCastEntryId = "";
    setPlayerMessage("กลับมาเล่นในแอปแล้ว · หากทีวียัง Cast อยู่ ให้หยุด Cast ใน YouTube ก่อน");
    showRoom(roomState);
  }

  if (currentSong && currentPlaybackState === "playing") return;
  if (currentSong && ["ready", "paused"].includes(currentPlaybackState)) {
    if (!youtubePlayerReady) {
      document.querySelector("#play-song-button").disabled = true;
      try {
        await ensureYoutubePlayer();
        setPlayerMessage("ตัวเล่นพร้อมแล้ว · กดปุ่มอีกครั้งเพื่อเริ่มเพลง");
      } catch {}
      return;
    }
    pendingPlayerEvent = null;
    if (currentPlaybackState === "paused" && !playerNeedsRestart) youtubePlayer.playVideo();
    else {
      cuedVideoId = currentSong.videoId;
      youtubePlayer.loadVideoById({ videoId: currentSong.videoId, startSeconds: 0 });
    }
    return;
  }

  const nextSong = roomState.queue[0];
  if (!nextSong) {
    setRoomMessage("คิวยังไม่มีเพลงถัดไป", true);
    return;
  }

  pendingPlayerEvent = null;
  expectedPlayback = { entryId: nextSong.id, videoId: nextSong.videoId };
  const button = document.querySelector("#play-song-button");
  button.disabled = true;
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/play`, { method: "POST" });
    if (roomState?.roomCode !== roomCode) return;
    showRoom(response.room);
    setRoomMessage(`เตรียม “${response.room.currentSong.title}” แล้ว · ผู้ร้องเปิดไมค์ได้ก่อนโฮสต์เริ่มเพลง`);
  } catch (error) {
    if (roomState?.roomCode !== roomCode) return;
    expectedPlayback = null;
    pendingPlayerEvent = null;
    button.disabled = false;
    setRoomMessage(error.message, true);
  }
}

async function finishExternalYoutubeCast() {
  if (!roomState?.currentSong || roomState.viewerId !== roomState.hostPlayerId || externalYoutubeCastEntryId !== roomState.currentSong.id) return;
  const song = roomState.currentSong;
  const button = document.querySelector("#finish-cast-button");
  button.disabled = true;
  const reported = await reportPlaybackState("ended", song.videoId, song.id);
  if (reported) {
    externalYoutubeCastEntryId = "";
    setPlayerMessage("แจ้งว่าเพลงบนทีวีจบแล้ว · ห้องเปิดให้โหวตคะแนน");
    if (roomState) renderPlayback(roomState, roomState.viewerId === roomState.hostPlayerId);
  } else if (roomState?.currentSong?.id === song.id) {
    button.disabled = false;
  }
}

function openYoutubeForCast() {
  if (!roomState?.currentSong || roomState.viewerId !== roomState.hostPlayerId) return;
  const song = roomState.currentSong;
  externalYoutubeCastEntryId = song.id;
  pendingPlayerEvent = null;
  if (youtubePlayerReady && getYoutubeVideoId() === song.videoId) youtubePlayer.pauseVideo();
  setPlayerMessage("เปิด YouTube ในแท็บใหม่แล้ว · กด Cast ใน YouTube และแจ้งเพลงจบที่นี่");
  if (roomState.playbackState !== "paused") reportPlaybackState("paused", song.videoId, song.id);
  renderPlayback(roomState, true);
}

async function skipCurrentSong() {
  if (!roomState?.currentSong || roomState.viewerId !== roomState.hostPlayerId) return;
  const roomCode = roomState.roomCode;
  const videoId = roomState.currentSong.videoId;
  ignoredVideoId = videoId;
  pendingPlayerEvent = null;
  expectedPlayback = null;
  cuedVideoId = "";
  playerNeedsRestart = false;
  if (youtubePlayerReady && getYoutubeVideoId() === videoId) youtubePlayer.stopVideo();
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/skip`, { method: "POST" });
    if (roomState?.roomCode !== roomCode) return;
    showRoom(response.room);
    setRoomMessage("ข้ามเพลงแล้ว");
  } catch (error) {
    if (roomState?.roomCode !== roomCode) return;
    ignoredVideoId = "";
    setRoomMessage(error.message, true);
  }
}

function updateConnection(state) {
  const indicator = document.querySelector("#connection-indicator");
  indicator.dataset.state = state;
  indicator.lastChild.textContent = state === "connected" ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อใหม่";
}

async function recoverRoomSnapshot(source, roomCode) {
  if (roomRecoveryPending) return;
  roomRecoveryPending = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await requestJson(`/api/rooms/${encodeURIComponent(roomCode)}`, { signal: controller.signal });
    if (eventSource !== source) return;
    showRoom(response.room);
    if (source.readyState === window.EventSource.OPEN) updateConnection("connected");
  } catch (error) {
    if (eventSource !== source) return;
    if (error.message.includes("เซสชันห้องหมดอายุ") || error.message.includes("ไม่พบผู้เล่นในห้องนี้")) {
      localStorage.removeItem(activeRoomKey);
      showEntry("คุณไม่ได้อยู่ในห้องนี้แล้ว เข้าร่วมใหม่ได้ด้วยรหัสห้อง");
      history.replaceState(null, "", "/");
    } else if (error.message.includes("ไม่พบห้องนี้")) {
      localStorage.removeItem(activeRoomKey);
      showEntry("ห้องนี้ไม่พร้อมใช้งานแล้ว สร้างหรือเข้าร่วมห้องใหม่ได้เลย");
      history.replaceState(null, "", "/");
    }
  } finally {
    clearTimeout(timeout);
    roomRecoveryPending = false;
  }
}

function connectToRoom(roomCode) {
  if (eventSource) eventSource.close();
  const source = new EventSource(`/api/rooms/${encodeURIComponent(roomCode)}/events`);
  eventSource = source;
  source.onopen = () => {
    if (eventSource === source) updateConnection("connected");
  };
  source.onerror = () => {
    if (eventSource === source) {
      updateConnection("reconnecting");
      recoverRoomSnapshot(source, roomCode);
    }
  };
  source.addEventListener("state", (event) => {
    if (eventSource !== source) return;
    try {
      showRoom(JSON.parse(event.data));
      updateConnection("connected");
    } catch {
      setRoomMessage("รับสถานะห้องไม่สำเร็จ กำลังลองใหม่", true);
    }
  });
  source.addEventListener("closed", () => {
    if (eventSource !== source) return;
    localStorage.removeItem(activeRoomKey);
    showEntry("ห้องนี้ปิดแล้ว สร้างห้องใหม่หรือเข้าร่วมอีกห้องได้เลย");
    history.replaceState(null, "", "/");
  });
  source.addEventListener("left", () => {
    if (eventSource !== source) return;
    localStorage.removeItem(activeRoomKey);
    showEntry("คุณออกจากห้องแล้ว");
    history.replaceState(null, "", "/");
  });
  source.addEventListener("removed", () => {
    if (eventSource !== source) return;
    localStorage.removeItem(activeRoomKey);
    showEntry("โฮสต์นำคุณออกจากห้องแล้ว");
    history.replaceState(null, "", "/");
  });
}

async function enterRoom(room) {
  const code = room.roomCode;
  localStorage.setItem(activeRoomKey, code);
  history.replaceState(null, "", `/?room=${encodeURIComponent(code)}`);
  showRoom(room);
  connectToRoom(code);
}

async function restoreRoom() {
  const queryCode = new URLSearchParams(window.location.search).get("room");
  const savedCode = localStorage.getItem(activeRoomKey);
  const candidate = (queryCode || savedCode || "").trim().toUpperCase();
  if (!candidate) return;

  try {
    const response = await requestJson(`/api/rooms/${encodeURIComponent(candidate)}`);
    localStorage.setItem(activeRoomKey, response.room.roomCode);
    showRoom(response.room);
    connectToRoom(response.room.roomCode);
  } catch {
    if (savedCode) localStorage.removeItem(activeRoomKey);
    if (queryCode) document.querySelector("#room-code-input").value = candidate;
    history.replaceState(null, "", queryCode ? `/?room=${encodeURIComponent(candidate)}` : "/");
  }
}

async function transferHost(player) {
  if (!roomState) return;
  const roomCode = roomState.roomCode;
  const accepted = window.confirm(`โอนสิทธิ์โฮสต์ให้ ${player.nickname}?`);
  if (!accepted) return;
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/host`, {
      method: "POST",
      body: JSON.stringify({ playerId: player.id }),
    });
    if (roomState?.roomCode !== roomCode) return;
    showRoom(response.room);
    setRoomMessage(`โอนสิทธิ์โฮสต์ให้ ${player.nickname} แล้ว`);
  } catch (error) {
    if (roomState?.roomCode !== roomCode) return;
    setRoomMessage(error.message, true);
  }
}

async function removeRoomPlayer(player) {
  if (!roomState || roomState.viewerId !== roomState.hostPlayerId || player.id === roomState.viewerId) return;
  const roomCode = roomState.roomCode;
  const accepted = window.confirm(`นำ ${player.nickname} ออกจากห้องนี้หรือไม่?`);
  if (!accepted) return;
  try {
    const response = await requestJson(`/api/rooms/${roomCode}/kick`, {
      method: "POST",
      body: JSON.stringify({ playerId: player.id }),
    });
    if (roomState?.roomCode !== roomCode) return;
    showRoom(response.room);
    setRoomMessage(`นำ ${player.nickname} ออกจากห้องแล้ว`);
  } catch (error) {
    if (roomState?.roomCode !== roomCode) return;
    setRoomMessage(error.message, true);
  }
}

function getInviteLink(roomCode = roomState?.roomCode) {
  if (!roomCode) return "";
  return new URL(`/?room=${encodeURIComponent(roomCode)}`, window.location.origin).toString();
}

function setInviteCopyFeedback(message) {
  if (inviteDialog.open) {
    document.querySelector("#invite-copy-feedback").textContent = message;
  } else {
    setRoomMessage(message);
  }
}

function createInviteQr(inviteUrl, roomCode) {
  const qrCode = window.qrcodegen.QrCode.encodeText(inviteUrl, window.qrcodegen.QrCode.Ecc.MEDIUM);
  const quietZone = 4;
  const dimension = qrCode.size + quietZone * 2;
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.classList.add("invite-qr-code");
  svg.setAttribute("viewBox", `0 0 ${dimension} ${dimension}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `QR สำหรับเข้าห้อง ${roomCode}`);
  svg.setAttribute("focusable", "false");

  const background = document.createElementNS(namespace, "rect");
  background.setAttribute("width", String(dimension));
  background.setAttribute("height", String(dimension));
  background.setAttribute("fill", "#ffffff");

  const darkModules = [];
  for (let y = 0; y < qrCode.size; y++) {
    for (let x = 0; x < qrCode.size; x++) {
      if (qrCode.getModule(x, y)) darkModules.push(`M${x + quietZone},${y + quietZone}h1v1h-1z`);
    }
  }
  const modules = document.createElementNS(namespace, "path");
  modules.setAttribute("d", darkModules.join(""));
  modules.setAttribute("fill", "#171521");
  svg.append(background, modules);
  return svg;
}

function showInviteQr() {
  if (!roomState) return;
  const inviteUrl = getInviteLink();
  const qr = document.querySelector("#invite-qr");
  const link = document.querySelector("#invite-url");
  qr.replaceChildren();
  document.querySelector("#invite-room-code").textContent = roomState.roomCode;
  link.href = inviteUrl;
  link.textContent = inviteUrl;

  const hostname = window.location.hostname.replace(/^\[|\]$/g, "");
  document.querySelector("#invite-network-note").hidden = !["localhost", "::1"].includes(hostname) && !/^127(?:\.\d{1,3}){3}$/.test(hostname);
  try {
    qr.append(createInviteQr(inviteUrl, roomState.roomCode));
  } catch {
    const error = document.createElement("p");
    error.className = "invite-qr-error";
    error.textContent = "สร้าง QR ไม่สำเร็จ · ใช้รหัสห้องด้านล่างเพื่อเข้าร่วมแทน";
    qr.append(error);
  }
  inviteDialog.showModal();
}

async function copyInviteLink() {
  if (!roomState) return;
  const inviteUrl = getInviteLink();
  try {
    await navigator.clipboard.writeText(inviteUrl);
    setInviteCopyFeedback("คัดลอกลิงก์ชวนแล้ว ส่งให้เพื่อนได้เลย");
  } catch {
    window.prompt("คัดลอกลิงก์นี้เพื่อชวนเพื่อน", inviteUrl);
    setInviteCopyFeedback("ลิงก์แสดงอยู่ด้านบน หากคัดลอกอัตโนมัติไม่ได้ ให้แตะค้างที่ลิงก์");
  }
}

document.querySelector("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const nickname = new FormData(form).get("nickname").toString().trim();
  button.disabled = true;
  setEntryMessage("กำลังเปิดห้อง...");
  try {
    const response = await requestJson("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ nickname }),
    });
    savePlayerPreferences(nickname, response.room.roomCode);
    await enterRoom(response.room);
  } catch (error) {
    setEntryMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const values = new FormData(form);
  const nickname = values.get("nickname").toString().trim();
  const roomCode = values.get("roomCode").toString().trim().toUpperCase();
  button.disabled = true;
  setEntryMessage("กำลังเข้าห้อง...");
  try {
    const response = await requestJson(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
      method: "POST",
      body: JSON.stringify({ nickname }),
    });
    savePlayerPreferences(nickname, response.room.roomCode);
    await enterRoom(response.room);
  } catch (error) {
    setEntryMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#invite-button").addEventListener("click", copyInviteLink);
document.querySelector("#show-qr-button").addEventListener("click", showInviteQr);
document.querySelector("#close-invite-dialog").addEventListener("click", () => inviteDialog.close());
document.querySelector("#copy-invite-dialog").addEventListener("click", copyInviteLink);
inviteDialog.addEventListener("click", (event) => {
  if (event.target === inviteDialog) inviteDialog.close();
});
document.querySelector("#play-song-button").addEventListener("click", startOrContinueSong);
document.querySelector("#youtube-cast-link").addEventListener("click", openYoutubeForCast);
document.querySelector("#finish-cast-button").addEventListener("click", finishExternalYoutubeCast);
document.querySelector("#skip-song-button").addEventListener("click", skipCurrentSong);
document.querySelector("#enable-mic-button").addEventListener("click", enableMicrophone);
document.querySelector("#stop-mic-button").addEventListener("click", () => {
  releaseMicrophone();
  setScoringMessage("ปิดไมค์แล้ว · เพลงนี้ใช้คะแนนโหวตจากผู้ฟังแทน");
  if (roomState) renderScoring(roomState);
});
document.querySelector("#song-report-form").addEventListener("submit", reportCurrentSong);
document.querySelectorAll(".vote-button").forEach((button) => {
  button.addEventListener("click", () => voteForSinger(Number(button.dataset.vote)));
});

document.querySelector("#music-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  document.querySelector("#search-feedback").classList.remove("is-error");
  runSearch(false);
});

document.querySelector("#load-more-button").addEventListener("click", () => runSearch(true));

document.querySelector("#leave-room-button").addEventListener("click", async () => {
  if (!roomState) return;
  try {
    await requestJson(`/api/rooms/${roomState.roomCode}/leave`, { method: "POST" });
    localStorage.removeItem(activeRoomKey);
    showEntry("คุณออกจากห้องแล้ว");
    history.replaceState(null, "", "/");
  } catch (error) {
    setRoomMessage(error.message, true);
  }
});

document.querySelector("#close-room-button").addEventListener("click", async () => {
  if (!roomState || !window.confirm("ปิดห้องนี้สำหรับทุกคนหรือไม่?")) return;
  try {
    await requestJson(`/api/rooms/${roomState.roomCode}/close`, { method: "POST" });
    localStorage.removeItem(activeRoomKey);
    showEntry("ปิดห้องแล้ว สร้างห้องใหม่ได้เลย");
    history.replaceState(null, "", "/");
  } catch (error) {
    setRoomMessage(error.message, true);
  }
});

const savedNickname = localStorage.getItem(nicknameKey) || "";
document.querySelector("#create-nickname").value = savedNickname;
document.querySelector("#join-nickname").value = savedNickname;
const requestedRoom = new URLSearchParams(window.location.search).get("room");
if (requestedRoom) document.querySelector("#room-code-input").value = requestedRoom.trim().toUpperCase();
window.addEventListener("pagehide", releaseMicrophone);
restoreRoom();
