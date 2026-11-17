import { randomUUID } from "node:crypto";

const WEBUI_HELPER_TIMEOUT_MS = 8 * 1000;
export const WEBUI_HELPER_COMMAND = "webui-helper";
const WEBUI_HELPER_RESPONSE_PREFIX = "__PI_WEBUI_HELPER_RESPONSE__:";

export function createHelperRequestService({ makeHttpError, sanitizeError }) {
  function parseWebuiHelperResponseEvent(event) {
    if (event?.type !== "extension_ui_request" || event.method !== "notify") return undefined;
    const message = String(event.message || "");
    if (!message.startsWith(WEBUI_HELPER_RESPONSE_PREFIX)) return undefined;
    try {
      return JSON.parse(message.slice(WEBUI_HELPER_RESPONSE_PREFIX.length));
    } catch (error) {
      return { ok: false, error: `Invalid Web UI helper response: ${sanitizeError(error)}` };
    }
  }

  function resolveWebuiHelperResponse(tab, event) {
    const payload = parseWebuiHelperResponseEvent(event);
    if (!payload) return false;
    const requestId = String(payload.requestId || "");
    const pending = tab?.webuiHelperRequests?.get(requestId);
    if (pending) {
      tab.webuiHelperRequests.delete(requestId);
      clearTimeout(pending.timeout);
      if (payload.ok === false) pending.reject(makeHttpError(400, payload.error || "Web UI helper command failed"));
      else pending.resolve(payload.data || {});
    }
    return true;
  }

  function resolveWebuiHelperRpcResponse(tab, event) {
    if (event?.type !== "response" || event.command !== "prompt" || !event.id) return false;
    return tab?.webuiHelperResponseIds?.delete(String(event.id)) === true;
  }

  function webuiHelperRequestMap(tab) {
    if (!tab.webuiHelperRequests) tab.webuiHelperRequests = new Map();
    return tab.webuiHelperRequests;
  }

  async function sendWebuiHelperCommand(tab, action, payload = {}, timeoutMs = WEBUI_HELPER_TIMEOUT_MS) {
    const requestId = randomUUID();
    const pending = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        webuiHelperRequestMap(tab).delete(requestId);
        tab.webuiHelperResponseIds?.delete(requestId);
        reject(makeHttpError(504, `Timed out waiting for Web UI helper action: ${action}. Try /reload in this tab, then retry.`));
      }, timeoutMs);
      webuiHelperRequestMap(tab).set(requestId, { resolve, reject, timeout });
    });
    pending.catch(() => {});

    try {
      tab.webuiHelperResponseIds?.add(requestId);
      const response = await tab.rpc.send({
        id: requestId,
        type: "prompt",
        message: `/${WEBUI_HELPER_COMMAND} ${JSON.stringify({ requestId, action, payload })}`,
      }, timeoutMs);
      if (response.success === false) throw makeHttpError(400, response.error || `Web UI helper action failed: ${action}`);
      return await pending;
    } catch (error) {
      tab.webuiHelperResponseIds?.delete(requestId);
      const request = webuiHelperRequestMap(tab).get(requestId);
      if (request) {
        clearTimeout(request.timeout);
        webuiHelperRequestMap(tab).delete(requestId);
      }
      throw error;
    }
  }

  return {
    parseWebuiHelperResponseEvent,
    resolveWebuiHelperResponse,
    resolveWebuiHelperRpcResponse,
    webuiHelperRequestMap,
    sendWebuiHelperCommand,
  };
}
