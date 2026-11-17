import {
  OUTPUT_MODE_NORMAL,
  OUTPUT_MODE_PROTOCOL_VERSION,
  encodeBrowserSseEvent,
  isOutputModeSemanticBarrier,
  normalizeOutputMode,
} from "../webui-output-mode.mjs";

const SSE_BACKPRESSURE_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const SSE_BACKPRESSURE_MAX_PENDING_FRAMES = 256;
const SSE_BACKPRESSURE_TIMEOUT_MS = 10_000;

export function createSseDelivery() {
  function clearSseBackpressureTimer(client) {
    if (!client?.backpressureTimer) return;
    clearTimeout(client.backpressureTimer);
    client.backpressureTimer = undefined;
  }

  function evictSlowSseClient(client) {
    if (!client || client.evicted) return;
    client.evicted = true;
    client.backpressured = false;
    clearSseBackpressureTimer(client);
    client.pendingFrames = [];
    client.pendingFrameBytes = 0;
    client.tab?.sseClients?.delete(client);
    try {
      // Complete the chunked response so Chromium can reconnect without
      // ERR_INCOMPLETE_CHUNKED_ENCODING.
      client.res?.end();
    } catch {
      // A closed browser socket needs no further cleanup.
    }
  }

  function scheduleSseBackpressureTimeout(client) {
    clearSseBackpressureTimer(client);
    client.backpressureTimer = setTimeout(() => evictSlowSseClient(client), SSE_BACKPRESSURE_TIMEOUT_MS);
    client.backpressureTimer.unref?.();
  }

  function flushSseClient(client) {
    const res = client?.res;
    if (!client || client.evicted) return;
    if (!res || res.destroyed || res.writableEnded) {
      evictSlowSseClient(client);
      return;
    }
    client.backpressured = false;
    clearSseBackpressureTimer(client);
    while (client.pendingFrames?.length) {
      const frame = client.pendingFrames.shift();
      client.pendingFrameBytes -= Buffer.byteLength(frame);
      try {
        if (!res.write(frame)) {
          client.backpressured = true;
          scheduleSseBackpressureTimeout(client);
          res.once("drain", () => flushSseClient(client));
          return;
        }
      } catch {
        evictSlowSseClient(client);
        return;
      }
    }
    client.pendingFrameBytes = 0;
  }

  function writeSseFrame(client, frame) {
    const res = client?.res || client;
    if (!res || res.destroyed || res.writableEnded || client?.evicted) return false;
    if (client?.res && client.backpressured) {
      const frameBytes = Buffer.byteLength(frame);
      const pendingFrames = client.pendingFrames || (client.pendingFrames = []);
      const pendingBytes = Number(client.pendingFrameBytes) || 0;
      if (pendingFrames.length >= SSE_BACKPRESSURE_MAX_PENDING_FRAMES || pendingBytes + frameBytes > SSE_BACKPRESSURE_MAX_PENDING_BYTES) {
        evictSlowSseClient(client);
        return false;
      }
      pendingFrames.push(frame);
      client.pendingFrameBytes = pendingBytes + frameBytes;
      return true;
    }
    try {
      if (!res.write(frame) && client?.res) {
        client.backpressured = true;
        scheduleSseBackpressureTimeout(client);
        res.once("drain", () => flushSseClient(client));
      }
      // write() returning false still accepted this frame.
      return true;
    } catch {
      if (client?.res) evictSlowSseClient(client);
      return false;
    }
  }

  function sendSse(client, event) {
    const payload = encodeBrowserSseEvent(event, { outputMode: client?.activeMode || OUTPUT_MODE_NORMAL });
    if (payload === undefined) return false;
    return writeSseFrame(client, `data: ${payload}\n\n`);
  }

  function activateOutputMode(client, activeMode, reason = "server-default-change") {
    const nextMode = normalizeOutputMode(activeMode);
    if (client.activeMode === nextMode) {
      client.pendingMode = undefined;
      return;
    }
    sendSse(client, {
      type: "webui_output_mode",
      protocolVersion: OUTPUT_MODE_PROTOCOL_VERSION,
      previousMode: client.activeMode,
      activeMode: nextMode,
      reason,
    });
    client.activeMode = nextMode;
    client.pendingMode = undefined;
  }

  function sendSseToClient(client, event) {
    const sent = sendSse(client, event);
    if (sent && client?.pendingMode && isOutputModeSemanticBarrier(event)) activateOutputMode(client, client.pendingMode);
    return sent;
  }

  return {
    clearSseBackpressureTimer,
    evictSlowSseClient,
    scheduleSseBackpressureTimeout,
    flushSseClient,
    writeSseFrame,
    sendSse,
    activateOutputMode,
    sendSseToClient,
  };
}
