import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalWikiEngine, jsonToolResult, pathExists, runCommand } from "@firstpick/pi-utils";
import { Type } from "typebox";
import { shouldRouteLocalWikiPrompt } from "./lib/prompt-routing.mjs";

const CONFIG = {
  extensionId: "raspberrypi",
  displayName: "Raspberry Pi Documentation",
  topicName: "Raspberry Pi",
  docsPath: "~/.raspberrypiwiki".replace(/^~(?=\/|$)/, os.homedir()).replace(/^\$HOME(?=\/|$)/, os.homedir()),
  repoUrl: "https://github.com/raspberrypi/documentation",
  setupCommand: "/raspberrypi-wiki-local-setup",
  fileExtensions: /\.(adoc|asciidoc|asc)$/i,
  cacheDir: path.join(os.homedir(), ".cache", "pi", "raspberrypi-wiki-local"),
  schemaVersion: 4,
  promptDetection: /\b(raspberry\s*pi(?:\s*(?:os|imager|connect|5|4|zero|compute\s+module))?|raspberrypi|raspi(?:-config)?|rpi(?:-eeprom|-update|-gpio)?|pico(?:\s*w|\s*2)?|pico-sdk|rp2040|rp2350|rp1|cm[45]|compute\s+module\s*(?:4|5)?|picamera2?|rpicam(?:-[a-z0-9-]+)?|libcamera|dtoverlay|dtparam|pinctrl|raspi-gpio|camera_auto_detect|display_auto_detect)\b|\b(?:config|cmdline)\.txt\b/i,
  queryExpansions: {
    ai: ["ai camera", "ai kit", "ai hat", "imx500"],
    boot: ["boot mode", "boot order", "BOOT_ORDER"],
    bootloader: ["eeprom", "rpi-eeprom-update", "rpi-eeprom-config", "BOOT_ORDER"],
    camera: ["rpicam", "rpicam-apps", "libcamera", "picamera2", "camera module", "camera_auto_detect"],
    "config.txt": ["config txt", "configuration", "dtparam", "dtoverlay", "/boot/firmware/config.txt"],
    config: ["configuration", "config.txt", "config txt", "cmdline.txt", "dtparam", "dtoverlay", "/boot/firmware/config.txt"],
    display: ["screen", "hdmi", "kms", "fkms", "dtoverlay", "display_auto_detect"],
    eeprom: ["bootloader", "rpi-eeprom-update", "rpi-eeprom-config", "BOOT_ORDER"],
    gpio: ["pinout", "pinctrl", "raspi-gpio", "dtparam", "dtoverlay", "40-pin header"],
    headless: ["ssh", "remote access", "raspi-config", "imager"],
    imager: ["raspberry pi imager", "preconfigure", "customisation", "install"],
    install: ["setup", "getting started", "requirements", "imager"],
    network: ["wifi", "wireless", "networkmanager", "nmcli", "wpa_supplicant"],
    nvme: ["pcie", "m.2", "boot order", "BOOT_ORDER", "rpi-eeprom-config"],
    os: ["raspberry pi os", "bookworm", "trixie", "apt"],
    pcie: ["pci express", "nvme", "m.2", "external pcie"],
    pico: ["rp2040", "rp2350", "pico sdk", "micropython", "pico w"],
    power: ["power supply", "undervoltage", "get_throttled", "usb-c"],
    remote: ["remote access", "ssh", "vnc", "raspberry pi connect"],
    ssh: ["remote access", "headless", "raspi-config", "ssh server"],
    storage: ["sd card", "ssd", "nvme", "usb boot", "external storage"],
    wifi: ["wireless", "network", "networkmanager", "nmcli", "wpa_supplicant"],
  } as Record<string, string[]>,
  searchStopwords: [
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "docs", "documentation", "for", "from", "guide", "help", "how", "i", "in", "is", "it", "my", "of", "on", "or", "pi", "raspberry", "raspberrypi", "the", "this", "to", "use", "using", "with", "you", "your",
  ],
  termWeights: {
    about: 0.35,
    bootloader: 0.8,
    boot_order: 0.75,
    command: 0.55,
    computer: 0.45,
    computers: 0.45,
    configuration: 0.75,
    configure: 0.75,
    connect: 0.7,
    device: 0.55,
    eeprom: 0.8,
    install: 0.8,
    os: 0.65,
    "remote access": 0.75,
    "rpi-eeprom-config": 0.8,
    setup: 0.75,
    source: 0.35,
    system: 0.55,
  } as Record<string, number>,
};

const MISSING_DOCS_MESSAGE = `Local ${CONFIG.displayName} docs are not available at ${CONFIG.docsPath}. Run ${CONFIG.setupCommand} to set them up.`;

type SetupProgress = (message: string, level?: "info" | "warning") => void;

async function gitRevision(): Promise<string | undefined> {
  if (!await pathExists(path.join(CONFIG.docsPath, ".git"))) return undefined;
  const result = await runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: CONFIG.docsPath, timeoutMs: 120000 });
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

const wiki = createLocalWikiEngine({
  displayName: CONFIG.displayName,
  docsPath: CONFIG.docsPath,
  cacheDir: CONFIG.cacheDir,
  schemaVersion: CONFIG.schemaVersion,
  fileExtensions: CONFIG.fileExtensions,
  format: "asciidoc",
  expandIncludes: true,
  queryExpansions: CONFIG.queryExpansions,
  searchStopwords: CONFIG.searchStopwords,
  termWeights: CONFIG.termWeights,
  missingDocsMessage: MISSING_DOCS_MESSAGE,
  metadataExtra: async () => ({ gitRevision: await gitRevision() }),
  statusExtra: async () => ({ gitRevision: await gitRevision() }),
});

async function executeSetup(progress?: SetupProgress): Promise<{ ok: boolean; message: string }> {
  progress?.(`Checking local ${CONFIG.displayName} docs at ${CONFIG.docsPath}...`);
  if (!CONFIG.repoUrl) {
    progress?.("No repository URL is configured; expecting a manually populated docs path.", "warning");
    return { ok: false, message: `No repoUrl configured. Populate ${CONFIG.docsPath} with local docs, then retry the wiki tools.` };
  }

  if (!await pathExists(CONFIG.docsPath)) {
    const parent = path.dirname(CONFIG.docsPath);
    progress?.(`Creating parent directory ${parent} if needed...`);
    await fs.mkdir(parent, { recursive: true });
    progress?.(`Cloning ${CONFIG.displayName} docs from ${CONFIG.repoUrl} into ${CONFIG.docsPath}. This can take a while for large documentation repositories...`);
    const clone = await runCommand("git", ["clone", "--depth=1", CONFIG.repoUrl, CONFIG.docsPath], { cwd: parent, timeoutMs: 120000 });
    if (!clone.ok) return { ok: false, message: `Clone failed: ${clone.stderr || clone.error}` };
  } else if (await pathExists(path.join(CONFIG.docsPath, ".git"))) {
    progress?.(`Existing Git checkout found at ${CONFIG.docsPath}. Running git pull --ff-only...`);
    const pull = await runCommand("git", ["pull", "--ff-only"], { cwd: CONFIG.docsPath, timeoutMs: 120000 });
    if (!pull.ok) return { ok: false, message: `Update failed: ${pull.stderr || pull.error}` };
  } else {
    progress?.("Docs path exists but is not a Git checkout. Checking whether it contains readable documentation files...", "warning");
  }

  progress?.("Indexing local documentation corpus...");
  try {
    await wiki.buildCache();
  } catch (error) {
    return { ok: false, message: `Cache build failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const status = await wiki.status();
  return {
    ok: Boolean(status.available),
    message: status.available
      ? `Ready: ${CONFIG.displayName} docs at ${CONFIG.docsPath}. Indexed ${status.pageCount} files.`
      : `${CONFIG.displayName} docs are still unavailable at ${CONFIG.docsPath}.`,
  };
}

async function executeSmokeTest(params: { maxSearchResults?: number } = {}) {
  const checks: Array<{ name: string; ok: boolean; detail: string; chars?: number }> = [];
  const addCheck = (name: string, ok: boolean, detail: string, payload?: unknown) => checks.push({ name, ok, detail, chars: payload === undefined ? undefined : JSON.stringify(payload).length });
  const status = await wiki.status();
  addCheck("corpus available", Boolean(status.available), `${status.pageCount} indexed files at ${status.docsPath}`);
  if (!status.available) return { ok: false, status, checks };

  const limit = Math.max(3, Math.min(params.maxSearchResults ?? 5, 10));
  const searchCases = [
    { name: "ssh", query: "ssh headless setup", expectedPath: "computers/remote-access/ssh.adoc" },
    { name: "camera", query: "camera libcamera picamera2", expectedPath: "computers/camera/libcamera_python.adoc" },
    { name: "config.txt", query: "config.txt dtoverlay gpio", expectedPath: "computers/config_txt.adoc" },
    { name: "pico sdk", query: "pico sdk blink build", expectedPath: "microcontrollers/c_sdk" },
    { name: "nvme boot", query: "boot from nvme pi 5", expectedPath: "computers/raspberry-pi/boot-nvme.adoc" },
  ];
  for (const testCase of searchCases) {
    const result = await wiki.search({ query: testCase.query, limit, includeSnippets: false });
    addCheck(`search: ${testCase.name}`, result.results.some((entry) => entry.path.includes(testCase.expectedPath)), `expected page found in top ${limit}`, result.results);
  }

  const sections = await wiki.sections({ page: "ssh", maxSections: 20 });
  addCheck("sections: ssh headings", sections.sections.some((section) => section.title === "Enable the SSH server"), `${sections.sections.length}/${sections.sectionCount} headings, omitted ${sections.omittedSectionCount}`, sections.sections);

  const extract = await wiki.extract({ page: "ssh", section: "Enable the SSH server", maxChars: 5000, maxSections: 2 });
  addCheck("extract: ssh enable server", !extract.truncated && extract.text.includes("By default, Raspberry Pi OS disables the SSH server"), `${extract.text.length} chars, omitted ${extract.omittedSectionCount}`, extract.text);

  const read = await wiki.read({ page: "ssh", maxChars: 2000 });
  addCheck("read: bounded output", read.truncated && read.text.length <= 2100, `${read.text.length} chars, truncated=${read.truncated}`, read.text);

  const related = await wiki.related({ page: "ssh", limit: 10 });
  addCheck("related: bounded links", related.links.length <= 10, `${related.links.length} links`, related.links);

  return { ok: checks.every((check) => check.ok), status, checks };
}

const searchParams = Type.Object({ query: Type.String({ description: `Search query, e.g. '${CONFIG.topicName} config'` }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })), includeSnippets: Type.Optional(Type.Boolean({ description: "Include compact text snippets; defaults to false for bounded output." })) });
const readParams = Type.Object({ page: Type.String({ description: "Page title, slug, or absolute local path" }), maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 100000 })) });
const sectionsParams = Type.Object({ page: Type.String({ description: "Page title, slug, or absolute local path" }), maxSections: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })) });
const extractParams = Type.Object({ page: Type.String({ description: "Page title, slug, or absolute local path" }), section: Type.Optional(Type.String()), query: Type.Optional(Type.String()), maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 100000 })), maxSections: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })) });
const relatedParams = Type.Object({ page: Type.String({ description: "Page title, slug, or absolute local path" }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) });
const smokeParams = Type.Object({ maxSearchResults: Type.Optional(Type.Number({ minimum: 3, maximum: 10 })) });

export default function localWikiExtension(pi: ExtensionAPI) {
  pi.on?.("before_agent_start", async (event, ctx) => {
    if ("messageType" in event && event.messageType === "custom") return;
    if (!shouldRouteLocalWikiPrompt(event.prompt ?? "", CONFIG.promptDetection)) return;

    if (!await wiki.available()) {
      const warning = `${MISSING_DOCS_MESSAGE} Aborting ${CONFIG.displayName}-local lookup until setup is complete.`;
      ctx.ui.notify(warning, "warning");
      ctx.abort();
      return {
        message: { customType: `${CONFIG.extensionId}-wiki-local-missing-docs`, content: warning, display: true },
        systemPrompt: `${event.systemPrompt}\n\n${CONFIG.displayName} local documentation setup required: ${warning} Do not continue with ${CONFIG.topicName} troubleshooting until the user runs ${CONFIG.setupCommand}.`,
      };
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${CONFIG.displayName} local documentation routing: This prompt appears related to ${CONFIG.topicName}. Use ${CONFIG.extensionId}_wiki_search before web sources, then ${CONFIG.extensionId}_wiki_extract for focused sections with local path citations. Prefer read-only diagnostics and ask before destructive changes.`,
    };
  });

  pi.registerCommand(`${CONFIG.extensionId}_wiki-status`, {
    description: `Show local ${CONFIG.displayName} docs path, page count, Git revision, and cache freshness`,
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(await wiki.status(), null, 2), "info"),
  });

  pi.registerCommand(`${CONFIG.extensionId}-wiki-local-setup`, {
    description: `Clone/update or report setup instructions for local ${CONFIG.displayName} docs`,
    handler: async (_args, ctx) => {
      ctx.ui.setStatus?.(`${CONFIG.extensionId}-wiki-setup`, `Setting up ${CONFIG.displayName} docs...`);
      const progress: SetupProgress = (message, level = "info") => ctx.ui.notify(message, level);
      try {
        const result = await executeSetup(progress);
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
      } finally {
        ctx.ui.setStatus?.(`${CONFIG.extensionId}-wiki-setup`, "");
      }
    },
  });

  pi.registerCommand(`${CONFIG.extensionId}_wiki-smoke-test`, {
    description: `Run compact local ${CONFIG.displayName} parser/search/link smoke tests`,
    handler: async (_args, ctx) => {
      const result = await executeSmokeTest();
      ctx.ui.notify(JSON.stringify(result, null, 2), result.ok ? "info" : "warning");
    },
  });

  pi.registerTool({ name: `${CONFIG.extensionId}_wiki_search`, label: `${CONFIG.displayName} Search`, description: `Search local ${CONFIG.displayName} documentation pages from ${CONFIG.docsPath}.`, promptSnippet: `Search local ${CONFIG.displayName} pages before using web sources for ${CONFIG.topicName} questions`, promptGuidelines: [`Use ${CONFIG.extensionId}_wiki_search first for ${CONFIG.topicName} questions before consulting web sources.`, `Use ${CONFIG.extensionId}_wiki_extract after search to retrieve focused sections with citations.`], parameters: searchParams, async execute(_toolCallId, params) { return jsonToolResult(await wiki.search(params)); } });
  pi.registerTool({ name: `${CONFIG.extensionId}_wiki_read`, label: `${CONFIG.displayName} Read`, description: `Read a local ${CONFIG.displayName} page as clean text with a local path citation.`, promptSnippet: `Read local ${CONFIG.displayName} page text by title, slug, or absolute local path`, promptGuidelines: [`Use ${CONFIG.extensionId}_wiki_read only when broad page context is needed; prefer ${CONFIG.extensionId}_wiki_extract for focused answers.`], parameters: readParams, async execute(_toolCallId, params) { return jsonToolResult(await wiki.read(params)); } });
  pi.registerTool({ name: `${CONFIG.extensionId}_wiki_sections`, label: `${CONFIG.displayName} Sections`, description: `List headings/sections for a local ${CONFIG.displayName} page.`, promptSnippet: `List headings from a local ${CONFIG.displayName} page`, promptGuidelines: [`Use ${CONFIG.extensionId}_wiki_sections to choose exact sections before extraction.`], parameters: sectionsParams, async execute(_toolCallId, params) { return jsonToolResult(await wiki.sections(params)); } });
  pi.registerTool({ name: `${CONFIG.extensionId}_wiki_extract`, label: `${CONFIG.displayName} Extract`, description: `Extract a named or query-relevant section from a local ${CONFIG.displayName} page.`, promptSnippet: `Extract focused local ${CONFIG.displayName} sections by heading or query`, promptGuidelines: [`Use ${CONFIG.extensionId}_wiki_extract to cite exact local sections in final answers.`], parameters: extractParams, async execute(_toolCallId, params) { return jsonToolResult(await wiki.extract(params)); } });
  pi.registerTool({ name: `${CONFIG.extensionId}_wiki_related`, label: `${CONFIG.displayName} Related`, description: `Return local ${CONFIG.displayName} pages linked from a given local page.`, promptSnippet: `Find locally linked ${CONFIG.displayName} pages related to a page`, promptGuidelines: [`Use ${CONFIG.extensionId}_wiki_related when an issue spans connected ${CONFIG.topicName} topics.`], parameters: relatedParams, async execute(_toolCallId, params) { return jsonToolResult(await wiki.related(params)); } });
  pi.registerTool({ name: `${CONFIG.extensionId}_wiki_smoke_test`, label: `${CONFIG.displayName} Smoke Test`, description: `Run a compact parser, search, extraction, read, and related-link smoke test for ${CONFIG.displayName}.`, promptSnippet: `Smoke-test local ${CONFIG.displayName} parser/search behavior`, promptGuidelines: [`Use ${CONFIG.extensionId}_wiki_smoke_test after package changes or corpus updates to verify search quality and bounded output.`], parameters: smokeParams, async execute(_toolCallId, params) { return jsonToolResult(await executeSmokeTest(params)); } });
}
