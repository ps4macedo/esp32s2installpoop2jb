const ROM = Object.freeze({
  flashBegin: 0x02,
  flashData: 0x03,
  sync: 0x08,
  writeReg: 0x09,
  readReg: 0x0a,
  spiSetParams: 0x0b,
  spiAttach: 0x0d,
  spiFlashMd5: 0x13,
});

const CHIP_FAMILY = "ESP32-S2";
const INSTALLER_REVISION = "2026-09-12-r1";
const INITIAL_BAUD = 115200;
const FLASH_BLOCK_SIZE = 0x400;
const FLASH_BYTES = 0x400000;
const NVS_START = 0x9000;
const NVS_END = 0xe000;
const CHIP_DETECT_MAGIC_REG = 0x40001000;
const ESP32_S2_MAGIC = 0x000007c6;
const ESP32_S2_SPI_REG_BASE = 0x3f402000;
const SPI_CMD_REG = ESP32_S2_SPI_REG_BASE + 0x00;
const SPI_USR_REG = ESP32_S2_SPI_REG_BASE + 0x18;
const SPI_USR2_REG = ESP32_S2_SPI_REG_BASE + 0x20;
const SPI_MISO_DLEN_REG = ESP32_S2_SPI_REG_BASE + 0x28;
const SPI_W0_REG = ESP32_S2_SPI_REG_BASE + 0x58;
const SPI_CMD_USR = 1 << 18;
const SPI_USR_COMMAND = 1 << 31;
const SPI_USR_MISO = 1 << 28;
const SPI_USR2_COMMAND_LEN_SHIFT = 28;
const SPIFLASH_RDID = 0x9f;
const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;
const MAX_SLIP_FRAME_BYTES = 4096;
const MAX_QUEUED_FRAMES = 64;
const MAX_LOG_LINES = 120;
const JOURNAL_KEY = "hostpsm-web-installer-last-session";

const FLASH_SIZE_BY_JEDEC_ID = Object.freeze({
  0x12: 256 * 1024,
  0x13: 512 * 1024,
  0x14: 1 * 1024 * 1024,
  0x15: 2 * 1024 * 1024,
  0x16: 4 * 1024 * 1024,
  0x17: 8 * 1024 * 1024,
  0x18: 16 * 1024 * 1024,
  0x19: 32 * 1024 * 1024,
  0x1a: 64 * 1024 * 1024,
  0x1b: 128 * 1024 * 1024,
  0x1c: 256 * 1024 * 1024,
  0x20: 64 * 1024 * 1024,
  0x21: 128 * 1024 * 1024,
  0x22: 256 * 1024 * 1024,
  0x32: 256 * 1024,
  0x33: 512 * 1024,
  0x34: 1 * 1024 * 1024,
  0x35: 2 * 1024 * 1024,
  0x36: 4 * 1024 * 1024,
  0x37: 8 * 1024 * 1024,
  0x38: 16 * 1024 * 1024,
  0x39: 32 * 1024 * 1024,
  0x3a: 64 * 1024 * 1024,
});

const EXPECTED_PARTS = Object.freeze([
  Object.freeze({ path: "firmware/bootloader.bin", offset: 0x1000, maxBytes: 0x7000, imageMagic: true }),
  Object.freeze({ path: "firmware/partitions.bin", offset: 0x8000, maxBytes: 0x1000, imageMagic: false }),
  Object.freeze({ path: "firmware/boot_app0.bin", offset: 0xe000, exactBytes: 0x2000, imageMagic: false }),
  Object.freeze({ path: "firmware/HostPSM_ESP32S2.bin", offset: 0x10000, maxBytes: 0x3f0000, imageMagic: true }),
]);

const DEFAULT_TIMEOUTS = Object.freeze({
  manifestFetchMs: 12000,
  firmwareFetchMs: 45000,
  portOpenMs: 8000,
  serialWriteMs: 10000,
  syncResponseMs: 900,
  commandResponseMs: 5000,
  flashDataResponseMs: 8000,
  md5PerMbMs: 10000,
  cleanupStepMs: 2500,
});

class InstallerError extends Error {}
class CancelledError extends InstallerError {}
class TimeoutError extends InstallerError {}
class SessionExpiredError extends InstallerError {}
class ProtocolError extends InstallerError {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function u32Packet(values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return out;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function flashChecksum(bytes) {
  let checksum = 0xef;
  for (const byte of bytes) {
    checksum ^= byte;
  }
  return checksum >>> 0;
}

function makePacket(command, payload, checksum = 0) {
  const packet = new Uint8Array(8 + payload.length);
  const view = new DataView(packet.buffer);
  packet[0] = 0x00;
  packet[1] = command;
  view.setUint16(2, payload.length, true);
  view.setUint32(4, checksum >>> 0, true);
  packet.set(payload, 8);
  return packet;
}

function slipEncode(packet) {
  const encoded = [SLIP_END];
  for (const byte of packet) {
    if (byte === SLIP_END) {
      encoded.push(SLIP_ESC, SLIP_ESC_END);
    } else if (byte === SLIP_ESC) {
      encoded.push(SLIP_ESC, SLIP_ESC_ESC);
    } else {
      encoded.push(byte);
    }
  }
  encoded.push(SLIP_END);
  return new Uint8Array(encoded);
}

function parseResponse(frame) {
  if (!(frame instanceof Uint8Array) || frame.length < 8) {
    throw new ProtocolError("resposta curta demais do bootloader");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const size = view.getUint16(2, true);
  if (frame.length !== 8 + size) {
    throw new ProtocolError(`resposta truncada ou excedente do bootloader (declarado ${size}, recebido ${frame.length - 8})`);
  }
  return {
    direction: frame[0],
    command: frame[1],
    size,
    value: view.getUint32(4, true),
    data: frame.slice(8),
  };
}

function validateRomResponse(response, expectedDataBytes = 0) {
  if (!response || response.direction !== 0x01) {
    throw new ProtocolError("direção inválida na resposta do bootloader");
  }
  const expectedTotal = expectedDataBytes + 4;
  if (response.data.length !== expectedTotal) {
    throw new ProtocolError(
      `tamanho inválido na resposta do bootloader (esperado ${expectedTotal}, recebido ${response.data.length})`,
    );
  }
  const status = response.data[expectedDataBytes];
  const error = response.data[expectedDataBytes + 1];
  if (status !== 0) {
    throw new ProtocolError(`bootloader recusou o comando (status ${status}, erro ${error})`);
  }
  return response.data.slice(0, expectedDataBytes);
}

function hexFromBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new InstallerError("SHA-256 indisponível neste navegador.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return hexFromBytes(new Uint8Array(digest));
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw new CancelledError("Instalação interrompida antes da próxima operação.");
  }
}

async function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error("timeout inválido");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label}: tempo limite excedido`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fetchWithTimeout(url, { timeoutMs, signal, cache = "no-store" } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new CancelledError("Instalação cancelada.");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { cache, signal: controller.signal });
  } catch (error) {
    if (signal && signal.aborted) {
      throw new CancelledError("Instalação cancelada.");
    }
    if (timedOut) {
      throw new TimeoutError(`${url}: tempo limite de download excedido`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function rangesOverlap(a0, a1, b0, b1) {
  return Math.max(a0, b0) < Math.min(a1, b1);
}

function normalizeManifest(manifest) {
  if (!manifest || manifest.new_install_prompt_erase !== false) {
    throw new InstallerError("manifest.json inválido: erase integral não é permitido neste instalador.");
  }
  const builds = Array.isArray(manifest.builds) ? manifest.builds : [];
  if (builds.length !== 1 || builds[0].chipFamily !== CHIP_FAMILY) {
    throw new InstallerError("manifest.json inválido para ESP32-S2.");
  }
  const parts = Array.isArray(builds[0].parts) ? builds[0].parts : [];
  if (!parts.length) {
    throw new InstallerError("Este instalador ainda não recebeu os arquivos de firmware. Execute GERAR_HOST_INSTALLER.bat antes de publicar.");
  }
  if (parts.length !== EXPECTED_PARTS.length) {
    throw new InstallerError("manifest.json não contém exatamente os quatro componentes aprovados do Host PSM.");
  }

  const normalized = parts.map((part, index) => {
    const expected = EXPECTED_PARTS[index];
    if (!part || typeof part.path !== "string" || !Number.isInteger(part.offset)) {
      throw new InstallerError("manifest.json contém uma parte de firmware inválida.");
    }
    if (part.path !== expected.path || part.offset !== expected.offset) {
      throw new InstallerError(`manifest.json diverge do layout aprovado em ${expected.path}.`);
    }
    if (!Number.isInteger(part.bytes) || part.bytes <= 0) {
      throw new InstallerError(`manifest.json não informa tamanho válido para ${part.path}.`);
    }
    if (!/^[0-9a-f]{64}$/i.test(part.sha256 || "")) {
      throw new InstallerError(`manifest.json não informa SHA-256 válido para ${part.path}.`);
    }
    if (!/^[0-9a-f]{32}$/i.test(part.md5 || "")) {
      throw new InstallerError(`manifest.json não informa MD5 válido para ${part.path}.`);
    }
    if (expected.exactBytes !== undefined && part.bytes !== expected.exactBytes) {
      throw new InstallerError(`${part.path} tem tamanho diferente do contrato aprovado.`);
    }
    if (expected.maxBytes !== undefined && part.bytes > expected.maxBytes) {
      throw new InstallerError(`${part.path} excede a região aprovada.`);
    }
    const end = part.offset + part.bytes;
    if (!Number.isSafeInteger(end) || end > FLASH_BYTES) {
      throw new InstallerError(`${part.path} ultrapassa a flash física de 4 MiB.`);
    }
    if (rangesOverlap(part.offset, end, NVS_START, NVS_END)) {
      throw new InstallerError(`${part.path} invade a NVS preservada.`);
    }
    return {
      path: part.path,
      offset: part.offset,
      expectedBytes: part.bytes,
      sha256: part.sha256.toLowerCase(),
      md5: part.md5.toLowerCase(),
      imageMagic: expected.imageMagic,
      bytes: null,
    };
  });

  for (let i = 0; i < normalized.length; i += 1) {
    const a = normalized[i];
    for (let j = i + 1; j < normalized.length; j += 1) {
      const b = normalized[j];
      if (rangesOverlap(a.offset, a.offset + a.expectedBytes, b.offset, b.offset + b.expectedBytes)) {
        throw new InstallerError(`regiões de firmware sobrepostas: ${a.path} e ${b.path}.`);
      }
    }
  }

  return {
    name: manifest.name || "Host PSM ESP32-S2",
    version: manifest.version || "1.1.0",
    parts: normalized,
  };
}

class SessionJournal {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.lines = [];
    this.add(`sessão iniciada; instalador ${INSTALLER_REVISION}`);
  }

  add(message) {
    const line = `${new Date().toISOString()} ${message}`;
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
    }
    try {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify({ startedAt: this.startedAt, lines: this.lines }));
    } catch (_) {
      // O registro local é diagnóstico auxiliar; falha de armazenamento não altera a gravação.
    }
    return line;
  }
}

class SlipFrameReader {
  constructor(reader, { onTerminal = null, maxFrameBytes = MAX_SLIP_FRAME_BYTES, maxQueuedFrames = MAX_QUEUED_FRAMES } = {}) {
    this.reader = reader;
    this.onTerminal = onTerminal;
    this.maxFrameBytes = maxFrameBytes;
    this.maxQueuedFrames = maxQueuedFrames;
    this.frames = [];
    this.waiters = [];
    this.current = [];
    this.inFrame = false;
    this.escaped = false;
    this.stopped = false;
    this.terminalError = null;
    this.lockReleased = false;
    this.pumpPromise = this.pump();
  }

  terminal(error) {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error instanceof Error ? error : new Error(String(error));
    this.rejectAll(this.terminalError);
    if (this.onTerminal) {
      this.onTerminal(this.terminalError);
    }
  }

  async pump() {
    try {
      while (!this.stopped) {
        const { value, done } = await this.reader.read();
        if (done) {
          if (!this.stopped) {
            this.terminal(new SessionExpiredError("a leitura serial foi encerrada pelo dispositivo"));
          }
          break;
        }
        if (value) {
          this.feed(value);
        }
      }
    } catch (error) {
      if (!this.stopped) {
        this.terminal(new SessionExpiredError(`falha na leitura serial: ${error.message || error}`));
      }
    } finally {
      this.releaseReaderLock();
    }
  }

  releaseReaderLock() {
    if (this.lockReleased) {
      return true;
    }
    try {
      this.reader.releaseLock();
      this.lockReleased = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  feed(chunk) {
    if (this.terminalError || this.stopped) {
      return;
    }
    for (const byte of chunk) {
      if (byte === SLIP_END) {
        if (this.current.length) {
          this.pushFrame(new Uint8Array(this.current));
          this.current = [];
        }
        this.inFrame = true;
        this.escaped = false;
        continue;
      }
      if (!this.inFrame) {
        continue;
      }
      if (byte === SLIP_ESC) {
        if (this.escaped) {
          this.terminal(new ProtocolError("escape SLIP inválido"));
          return;
        }
        this.escaped = true;
        continue;
      }
      if (this.escaped) {
        if (byte === SLIP_ESC_END) {
          this.current.push(SLIP_END);
        } else if (byte === SLIP_ESC_ESC) {
          this.current.push(SLIP_ESC);
        } else {
          this.terminal(new ProtocolError("sequência de escape SLIP inválida"));
          return;
        }
        this.escaped = false;
      } else {
        this.current.push(byte);
      }
      if (this.current.length > this.maxFrameBytes) {
        this.terminal(new ProtocolError("quadro serial excedeu o limite permitido"));
        return;
      }
    }
  }

  pushFrame(frame) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    if (this.frames.length >= this.maxQueuedFrames) {
      this.terminal(new ProtocolError("fila de respostas seriais excedeu o limite permitido"));
      return;
    }
    this.frames.push(frame);
  }

  rejectAll(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  nextFrame(timeoutMs) {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    if (this.frames.length) {
      return Promise.resolve(this.frames.shift());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new TimeoutError("tempo esgotado aguardando resposta da ESP32-S2"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async waitFor(command, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const remaining = Math.max(1, deadline - performance.now());
      const frame = await this.nextFrame(remaining);
      const response = parseResponse(frame);
      if (response.command !== command) {
        continue;
      }
      if (response.direction !== 0x01) {
        throw new ProtocolError("direção inválida na resposta do comando solicitado");
      }
      return response;
    }
    throw new TimeoutError("tempo esgotado aguardando resposta da ESP32-S2");
  }

  async stop(timeoutMs) {
    if (this.stopped) {
      return [];
    }
    this.stopped = true;
    this.rejectAll(new SessionExpiredError("leitura serial finalizada"));
    const errors = [];
    try {
      await withTimeout(Promise.resolve(this.reader.cancel()), timeoutMs, "cancelamento da leitura serial");
    } catch (error) {
      errors.push(error);
    }
    try {
      await withTimeout(Promise.resolve(this.pumpPromise), timeoutMs, "finalização da leitura serial");
    } catch (error) {
      errors.push(error);
    }
    if (!this.releaseReaderLock()) {
      errors.push(new SessionExpiredError("não foi possível confirmar a liberação do leitor serial"));
    }
    return errors;
  }
}

class InstallerUi {
  constructor() {
    this.installButton = document.getElementById("installButton");
    this.unsupportedText = document.getElementById("unsupportedText");
    this.stageText = document.getElementById("stageText");
    this.modal = document.getElementById("hostpsmModal");
    this.modalTitle = document.getElementById("modalTitle");
    this.modalBody = document.getElementById("modalBody");
    this.modalClose = document.getElementById("modalClose");
    this.modalPrimary = document.getElementById("modalPrimary");
    this.modalSecondary = document.getElementById("modalSecondary");
    this.installHandler = null;
    this.modalResolve = null;
    this.modalReject = null;
  }

  start() {
    const supported = Boolean(navigator.serial);
    this.installButton.disabled = !supported;
    this.unsupportedText.hidden = supported;
    if (!supported) {
      this.stageText.textContent = "Use Chrome ou Edge com suporte a Web Serial.";
    }
    this.installButton.addEventListener("click", () => {
      if (this.installHandler) {
        this.installHandler();
      }
    });
  }

  onInstall(handler) {
    this.installHandler = handler;
  }

  setBusy(busy) {
    this.installButton.disabled = busy || !navigator.serial;
    this.installButton.textContent = busy ? "AGUARDE" : "INSTALAR";
  }

  setStage(message) {
    this.stageText.textContent = message;
  }

  closeModal(result = "close") {
    this.modal.classList.remove("open");
    this.modal.setAttribute("aria-hidden", "true");
    if (this.modalResolve) {
      const resolve = this.modalResolve;
      this.modalResolve = null;
      this.modalReject = null;
      resolve(result);
    }
  }

  showChoice({ title, body, primary = "Instalar", secondary = "Cancelar", primaryAction = null }) {
    this.modalTitle.textContent = title;
    this.modalBody.innerHTML = body;
    this.modalPrimary.hidden = false;
    this.modalSecondary.hidden = false;
    this.modalClose.hidden = false;
    this.modalPrimary.disabled = false;
    this.modalSecondary.disabled = false;
    this.modalPrimary.textContent = primary;
    this.modalSecondary.textContent = secondary;
    this.modal.classList.add("open");
    this.modal.setAttribute("aria-hidden", "false");

    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (value, error = null) => {
        if (finished) return;
        finished = true;
        this.modal.classList.remove("open");
        this.modal.setAttribute("aria-hidden", "true");
        this.modalResolve = null;
        this.modalReject = null;
        if (error) reject(error);
        else resolve(value);
      };
      this.modalResolve = finish;
      this.modalReject = reject;
      this.modalPrimary.onclick = async () => {
        if (!primaryAction) {
          finish("primary");
          return;
        }
        this.modalPrimary.disabled = true;
        this.modalSecondary.disabled = true;
        try {
          // A escolha da porta ocorre no clique "Instalar", mantendo a ativação transitória.
          const value = await primaryAction();
          finish({ choice: "primary", value });
        } catch (error) {
          if (error && error.name === "NotFoundError") finish({ choice: "cancel", value: null });
          else finish(null, error);
        }
      };
      this.modalSecondary.onclick = () => finish(primaryAction ? { choice: "cancel", value: null } : "secondary");
      this.modalClose.onclick = () => finish(primaryAction ? { choice: "cancel", value: null } : "close");
    });
  }

  openProgress(title, message) {
    this.modalTitle.textContent = title;
    this.modalBody.innerHTML = `
      <p id="modalMessage">${escapeHtml(message)}</p>
      <div class="progressShell"><div id="modalProgress"></div></div>
      <div id="modalLog" class="visible"></div>
    `;
    this.modalPrimary.hidden = true;
    this.modalSecondary.hidden = true;
    this.modalClose.hidden = true;
    this.modal.classList.add("open");
    this.modal.setAttribute("aria-hidden", "false");
  }

  updateProgress(ratio, message) {
    const progress = document.getElementById("modalProgress");
    const modalMessage = document.getElementById("modalMessage");
    if (progress) {
      progress.style.width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(1)}%`;
    }
    if (modalMessage) {
      modalMessage.textContent = message;
    }
  }

  log(message) {
    const log = document.getElementById("modalLog");
    if (!log) return;
    log.textContent += `${message}\n`;
    const lines = log.textContent.split("\n");
    if (lines.length > MAX_LOG_LINES + 1) {
      log.textContent = lines.slice(-(MAX_LOG_LINES + 1)).join("\n");
    }
    log.scrollTop = log.scrollHeight;
  }

  async showDone() {
    this.modalTitle.textContent = "Instalação concluída";
    this.modalBody.innerHTML = `
      <p>Host PSM instalado.</p>
      <p>A ESP32-S2 está pronta para uso.</p>
      <p><strong>No PS5:</strong><br>Wi-Fi: <strong>HostPSM</strong><br>DNS: <strong>10.1.1.1</strong><br>Abra o <strong>Guia do Usuário</strong></p>
    `;
    this.modalPrimary.hidden = false;
    this.modalSecondary.hidden = true;
    this.modalClose.hidden = false;
    this.modalPrimary.disabled = false;
    this.modalPrimary.textContent = "Fechar";
    this.modalPrimary.onclick = () => this.closeModal("primary");
    this.modalClose.onclick = () => this.closeModal("close");
    this.modal.classList.add("open");
    this.modal.setAttribute("aria-hidden", "false");
    return new Promise((resolve) => {
      this.modalResolve = resolve;
    });
  }

  async showError(error) {
    this.modalTitle.textContent = "Instalação não concluída";
    this.modalBody.innerHTML = `<p>${escapeHtml(error.message || error)}</p>`;
    this.modalPrimary.hidden = false;
    this.modalSecondary.hidden = true;
    this.modalClose.hidden = false;
    this.modalPrimary.disabled = false;
    this.modalPrimary.textContent = "Fechar";
    this.modalPrimary.onclick = () => this.closeModal("primary");
    this.modalClose.onclick = () => this.closeModal("close");
    this.modal.classList.add("open");
    this.modal.setAttribute("aria-hidden", "false");
    return new Promise((resolve) => {
      this.modalResolve = resolve;
    });
  }
}

class HostPsmSerialFlasher {
  constructor(ui, port, { signal = null, journal = null, timeouts = DEFAULT_TIMEOUTS } = {}) {
    this.ui = ui;
    this.port = port;
    this.signal = signal;
    this.journal = journal;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.reader = null;
    this.writer = null;
    this.slip = null;
    this.state = "selected";
    this.expiredReason = null;
    this.disconnectHandler = null;
    this.allVerified = false;
  }

  record(message) {
    this.ui.log(message);
    if (this.journal) {
      this.journal.add(message);
    }
  }

  ensureActive({ allowCancelled = false } = {}) {
    if (!allowCancelled) {
      throwIfAborted(this.signal);
    }
    if (this.expiredReason) {
      throw new SessionExpiredError(this.expiredReason);
    }
  }

  expire(reason) {
    if (!this.expiredReason) {
      this.expiredReason = reason instanceof Error ? reason.message : String(reason);
      if (this.journal) {
        this.journal.add(`sessão invalidada: ${this.expiredReason}`);
      }
    }
  }

  installDisconnectObserver() {
    if (!navigator.serial || !navigator.serial.addEventListener) {
      return;
    }
    this.disconnectHandler = (event) => {
      if (event.target === this.port) {
        this.expire("a ESP32-S2 foi desconectada durante a sessão");
        if (this.slip) {
          this.slip.terminal(new SessionExpiredError(this.expiredReason));
        }
      }
    };
    navigator.serial.addEventListener("disconnect", this.disconnectHandler);
  }

  removeDisconnectObserver() {
    if (this.disconnectHandler && navigator.serial && navigator.serial.removeEventListener) {
      navigator.serial.removeEventListener("disconnect", this.disconnectHandler);
    }
    this.disconnectHandler = null;
  }

  async openPort() {
    this.ensureActive();
    if (this.state !== "selected") {
      throw new SessionExpiredError(`estado serial inválido para abertura: ${this.state}`);
    }
    this.state = "opening";
    this.ui.updateProgress(0.10, "Abrindo a conexão serial.");
    this.record("Abrindo porta serial selecionada.");
    const started = performance.now();
    const openPromise = Promise.resolve(this.port.open({ baudRate: INITIAL_BAUD, bufferSize: 65536 }));
    openPromise.then(async () => {
      if (this.expiredReason) {
        try {
          await withTimeout(Promise.resolve(this.port.close()), this.timeouts.cleanupStepMs, "fechamento tardio da porta");
        } catch (_) {
          // A sessão já foi declarada inválida; a recuperação física será orientada na interface.
        }
      }
    }, () => {});
    try {
      await withTimeout(openPromise, this.timeouts.portOpenMs, "abertura da porta serial");
    } catch (error) {
      this.state = "expired";
      this.expire(error instanceof TimeoutError
        ? "a abertura da porta serial não terminou no prazo; a sessão não será reutilizada"
        : `falha ao abrir a porta serial: ${error.message || error}`);
      throw error instanceof TimeoutError
        ? new SessionExpiredError("A porta não abriu de forma controlada. Desconecte a ESP32-S2 do USB antes de tentar novamente.")
        : error;
    }
    this.ensureActive();
    const elapsed = Math.round(performance.now() - started);
    this.record(`Porta aberta em ${elapsed} ms a ${INITIAL_BAUD} bps.`);

    if (!this.port.readable || !this.port.writable) {
      this.state = "expired";
      this.expire("a porta abriu sem streams de leitura e escrita disponíveis");
      throw new SessionExpiredError("A porta serial abriu sem canais de leitura e escrita utilizáveis.");
    }
    try {
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
    } catch (error) {
      this.state = "expired";
      this.expire(`falha ao obter os streams seriais: ${error.message || error}`);
      throw error;
    }
    this.slip = new SlipFrameReader(this.reader, {
      onTerminal: (error) => this.expire(error),
    });
    this.installDisconnectObserver();
    this.state = "active";
    this.record("Leitor e escritor seriais prontos.");
  }

  async writeSerial(bytes, label, { allowCancelled = false } = {}) {
    this.ensureActive({ allowCancelled });
    try {
      await withTimeout(Promise.resolve(this.writer.write(bytes)), this.timeouts.serialWriteMs, `${label}: escrita serial`);
    } catch (error) {
      this.state = "expired";
      this.expire(`${label}: a escrita serial não terminou de forma conhecida`);
      throw new SessionExpiredError(`${label}: a escrita serial ficou sem confirmação; a sessão foi encerrada por segurança.`);
    }
  }

  async command(command, payload = new Uint8Array(), checksum = 0, {
    responseTimeoutMs = this.timeouts.commandResponseMs,
    expectedDataBytes = 0,
    invalidateOnResponseTimeout = false,
    label = `comando 0x${command.toString(16)}`,
    allowCancelled = false,
  } = {}) {
    this.ensureActive({ allowCancelled });
    await this.writeSerial(slipEncode(makePacket(command, payload, checksum)), label, { allowCancelled });
    let response;
    try {
      response = await this.slip.waitFor(command, responseTimeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError && invalidateOnResponseTimeout) {
        this.state = "expired";
        this.expire(`${label}: resposta não chegou após escrita confirmada; resultado do comando é desconhecido`);
        throw new SessionExpiredError(`${label}: o resultado ficou desconhecido; nenhuma nova gravação será iniciada.`);
      }
      throw error;
    }
    const data = validateRomResponse(response, expectedDataBytes);
    return { response, data };
  }

  async readReg(address, { label = "READ_REG", allowCancelled = false } = {}) {
    const { response } = await this.command(ROM.readReg, u32Packet([address]), 0, {
      label,
      allowCancelled,
    });
    return response.value >>> 0;
  }

  async writeReg(address, value, { label = "WRITE_REG", allowCancelled = false } = {}) {
    await this.command(ROM.writeReg, u32Packet([address, value, 0xffffffff, 0]), 0, {
      label,
      allowCancelled,
      invalidateOnResponseTimeout: true,
    });
  }

  async readFlashId() {
    this.ensureActive();
    const oldUsr = await this.readReg(SPI_USR_REG, { label: "SPI: ler USR" });
    const oldUsr2 = await this.readReg(SPI_USR2_REG, { label: "SPI: ler USR2" });
    try {
      await this.writeReg(SPI_MISO_DLEN_REG, 24 - 1, { label: "SPI: configurar MISO" });
      await this.writeReg(SPI_USR_REG, (SPI_USR_COMMAND | SPI_USR_MISO) >>> 0, { label: "SPI: configurar USR" });
      await this.writeReg(
        SPI_USR2_REG,
        (((7 << SPI_USR2_COMMAND_LEN_SHIFT) >>> 0) | SPIFLASH_RDID) >>> 0,
        { label: "SPI: configurar RDID" },
      );
      await this.writeReg(SPI_W0_REG, 0, { label: "SPI: limpar W0" });
      await this.writeReg(SPI_CMD_REG, SPI_CMD_USR, { label: "SPI: executar RDID" });

      let completed = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        this.ensureActive();
        const cmd = await this.readReg(SPI_CMD_REG, { label: "SPI: aguardar RDID" });
        if ((cmd & SPI_CMD_USR) === 0) {
          completed = true;
          break;
        }
        await sleep(5);
      }
      if (!completed) {
        throw new ProtocolError("comando JEDEC RDID não terminou na SPI da ESP32-S2");
      }
      return (await this.readReg(SPI_W0_REG, { label: "SPI: ler JEDEC ID" })) & 0x00ffffff;
    } finally {
      // Restaurar os registradores faz parte da operação corrente, mesmo se o usuário pedir cancelamento.
      if (!this.expiredReason) {
        await this.writeReg(SPI_USR_REG, oldUsr, { label: "SPI: restaurar USR", allowCancelled: true });
        await this.writeReg(SPI_USR2_REG, oldUsr2, { label: "SPI: restaurar USR2", allowCancelled: true });
      }
    }
  }

  async confirmFlashCapacity() {
    this.ensureActive();
    const flashId = await this.readFlashId();
    if (flashId === 0 || flashId === 0x00ffffff) {
      throw new ProtocolError("não foi possível comunicar com a flash SPI da ESP32-S2");
    }
    const sizeId = (flashId >>> 16) & 0xff;
    const detectedBytes = FLASH_SIZE_BY_JEDEC_ID[sizeId];
    if (!detectedBytes) {
      throw new ProtocolError(`capacidade da flash não reconhecida no JEDEC ID 0x${flashId.toString(16).padStart(6, "0")}`);
    }
    if (detectedBytes < FLASH_BYTES) {
      throw new ProtocolError(
        `flash física insuficiente: ${Math.round(detectedBytes / (1024 * 1024))} MiB detectados; o Host PSM exige 4 MiB`,
      );
    }
    const manufacturer = flashId & 0xff;
    this.record(
      `Flash SPI confirmada: JEDEC 0x${flashId.toString(16).padStart(6, "0")}, fabricante 0x${manufacturer.toString(16).padStart(2, "0")}, capacidade ${detectedBytes / (1024 * 1024)} MiB.`,
    );
    return { flashId, detectedBytes };
  }

  async sync() {
    this.ui.updateProgress(0.12, "Confirmando o bootloader da ESP32-S2.");
    const payload = new Uint8Array(36);
    payload.set([0x07, 0x07, 0x12, 0x20]);
    payload.fill(0x55, 4);
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      this.ensureActive();
      try {
        await this.command(ROM.sync, payload, 0, {
          responseTimeoutMs: this.timeouts.syncResponseMs,
          expectedDataBytes: 0,
          invalidateOnResponseTimeout: false,
          label: "sincronização com o bootloader",
        });
        this.record(`Bootloader serial sincronizado na tentativa ${attempt}.`);
        return;
      } catch (error) {
        if (error instanceof SessionExpiredError || error instanceof CancelledError) {
          throw error;
        }
        lastError = error;
        this.record(`Sincronização ${attempt}/5 sem resposta válida: ${error.message}`);
        if (attempt < 5) {
          await sleep(100);
        }
      }
    }
    throw new InstallerError(
      "A ESP32-S2 não respondeu em modo de gravação. Se necessário, segure BOOT ao conectar e tente novamente.",
    );
  }

  async identifyChip() {
    this.ensureActive();
    this.ui.updateProgress(0.14, "Identificando a ESP32-S2.");
    const magic = await this.readReg(CHIP_DETECT_MAGIC_REG, { label: "identificação do chip" });
    if (magic !== ESP32_S2_MAGIC) {
      throw new ProtocolError(
        `dispositivo incompatível: valor de identificação 0x${magic.toString(16).padStart(8, "0")}, esperado ESP32-S2`,
      );
    }
    this.record("Destino confirmado: ESP32-S2.");
  }

  async prepareFlash() {
    this.ensureActive();
    this.ui.updateProgress(0.16, "Preparando a flash da ESP32-S2.");
    await this.command(ROM.spiAttach, u32Packet([0, 0]), 0, { label: "SPI_ATTACH" });
    await this.confirmFlashCapacity();
    await this.command(ROM.spiSetParams, u32Packet([0, FLASH_BYTES, 64 * 1024, 4 * 1024, 256, 0xffff]), 0, {
      label: "SPI_SET_PARAMS",
    });
    this.record("Flash SPI preparada para o contrato de 4 MiB do projeto.");
  }

  flashBeginTimeout(bytes) {
    const perMb = 40000;
    return Math.min(180000, Math.max(10000, Math.ceil((bytes / 1000000) * perMb)));
  }

  progressRatio(writtenBytes, verifiedBytes, totalBytes) {
    return 0.18 + (writtenBytes / totalBytes) * 0.70 + (verifiedBytes / totalBytes) * 0.08;
  }

  async flashPart(part, writtenBytes, verifiedBytes, totalBytes) {
    this.ensureActive();
    const blockCount = Math.ceil(part.bytes.length / FLASH_BLOCK_SIZE);
    const begin = u32Packet([part.bytes.length, blockCount, FLASH_BLOCK_SIZE, part.offset, 0]);
    this.record(`${part.path} @ 0x${part.offset.toString(16)} (${part.bytes.length} bytes)`);
    await this.command(ROM.flashBegin, begin, 0, {
      responseTimeoutMs: this.flashBeginTimeout(part.bytes.length),
      invalidateOnResponseTimeout: true,
      label: `FLASH_BEGIN ${part.path}`,
    });

    let written = 0;
    for (let sequence = 0; sequence < blockCount; sequence += 1) {
      this.ensureActive();
      const start = sequence * FLASH_BLOCK_SIZE;
      const end = Math.min(start + FLASH_BLOCK_SIZE, part.bytes.length);
      const dataLength = end - start;
      const block = new Uint8Array(FLASH_BLOCK_SIZE);
      block.fill(0xff);
      block.set(part.bytes.slice(start, end));
      const header = u32Packet([FLASH_BLOCK_SIZE, sequence, 0, 0]);
      const payload = concatBytes([header, block]);
      await this.command(ROM.flashData, payload, flashChecksum(block), {
        responseTimeoutMs: this.timeouts.flashDataResponseMs,
        invalidateOnResponseTimeout: true,
        label: `FLASH_DATA ${part.path} bloco ${sequence}`,
      });
      written += dataLength;
      const ratio = this.progressRatio(writtenBytes + written, verifiedBytes, totalBytes);
      this.ui.updateProgress(ratio, `Gravando ${part.path} (${Math.round((written / part.bytes.length) * 100)}%).`);
    }
  }

  async verifyPart(part, writtenBytes, verifiedBytes, totalBytes) {
    this.ensureActive();
    this.ui.updateProgress(
      this.progressRatio(writtenBytes, verifiedBytes, totalBytes),
      `Verificando ${part.path}.`,
    );
    const responseTimeoutMs = Math.max(
      this.timeouts.commandResponseMs,
      Math.ceil((part.bytes.length / 1000000) * this.timeouts.md5PerMbMs),
    );
    const { data } = await this.command(ROM.spiFlashMd5, u32Packet([part.offset, part.bytes.length, 0, 0]), 0, {
      responseTimeoutMs,
      expectedDataBytes: 32,
      label: `SPI_FLASH_MD5 ${part.path}`,
    });
    const actual = new TextDecoder("ascii").decode(data).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(actual)) {
      throw new ProtocolError(`MD5 inválido retornado pela ESP32-S2 para ${part.path}.`);
    }
    if (actual !== part.md5) {
      throw new ProtocolError(`verificação da flash falhou em ${part.path}: MD5 gravado não confere.`);
    }
    this.ui.updateProgress(
      this.progressRatio(writtenBytes, verifiedBytes + part.bytes.length, totalBytes),
      `Verificado ${part.path}.`,
    );
    this.record(`Verificado: ${part.path} (${actual}).`);
  }

  async flash(parts) {
    await this.openPort();
    await this.sync();
    await this.identifyChip();
    await this.prepareFlash();

    const totalBytes = parts.reduce((sum, part) => sum + part.bytes.length, 0);
    let writtenBytes = 0;
    let verifiedBytes = 0;
    for (const part of parts) {
      await this.flashPart(part, writtenBytes, verifiedBytes, totalBytes);
      writtenBytes += part.bytes.length;
      await this.verifyPart(part, writtenBytes, verifiedBytes, totalBytes);
      verifiedBytes += part.bytes.length;
    }
    this.allVerified = true;
    this.ui.updateProgress(0.97, "Firmware gravado e verificado. Encerrando a conexão.");
    this.record("Todas as regiões foram gravadas e verificadas. Nenhum reset automático será solicitado.");
  }

  async closePort() {
    const errors = [];
    if (this.state === "closed") {
      return { closed: true, errors };
    }
    this.state = "closing";
    this.removeDisconnectObserver();

    if (this.slip) {
      const stopErrors = await this.slip.stop(this.timeouts.cleanupStepMs);
      errors.push(...stopErrors);
      this.slip = null;
      this.reader = null;
    }
    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch (error) {
        errors.push(error);
      }
      this.writer = null;
    }
    if (this.port) {
      try {
        await withTimeout(Promise.resolve(this.port.close()), this.timeouts.cleanupStepMs, "fechamento da porta serial");
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length) {
      this.state = "closed-uncertain";
      this.record(`Encerramento serial incompleto: ${errors.map((error) => error.message || error).join(" | ")}`);
      return { closed: false, errors };
    }
    this.state = "closed";
    this.record("Conexão serial encerrada.");
    return { closed: true, errors };
  }
}

async function loadManifest({ signal = null, timeouts = DEFAULT_TIMEOUTS } = {}) {
  const response = await fetchWithTimeout("manifest.json", {
    timeoutMs: timeouts.manifestFetchMs,
    signal,
  });
  if (!response.ok) {
    throw new InstallerError("manifest.json não foi encontrado no Web Installer.");
  }
  return normalizeManifest(await response.json());
}

async function loadFirmwareParts(ui, parts, { signal = null, timeouts = DEFAULT_TIMEOUTS, journal = null } = {}) {
  const loaded = [];
  let total = 0;
  for (let index = 0; index < parts.length; index += 1) {
    throwIfAborted(signal);
    const part = parts[index];
    ui.updateProgress(0.02 + (index / Math.max(parts.length, 1)) * 0.06, `Carregando e validando ${part.path}.`);
    const response = await fetchWithTimeout(part.path, {
      timeoutMs: timeouts.firmwareFetchMs,
      signal,
    });
    if (!response.ok) {
      throw new InstallerError(`arquivo de firmware não encontrado: ${part.path}`);
    }
    const contentLength = response.headers && response.headers.get ? Number(response.headers.get("content-length")) : 0;
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== part.expectedBytes) {
      throw new InstallerError(`tamanho publicado diverge do manifesto em ${part.path}.`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== part.expectedBytes) {
      throw new InstallerError(`tamanho inválido em ${part.path}: esperado ${part.expectedBytes}, recebido ${bytes.length}.`);
    }
    if (part.imageMagic && bytes[0] !== 0xe9) {
      throw new InstallerError(`imagem ESP inválida em ${part.path}.`);
    }
    const digest = await sha256Hex(bytes);
    if (digest !== part.sha256) {
      throw new InstallerError(`SHA-256 divergente em ${part.path}; a gravação foi bloqueada antes de abrir a porta.`);
    }
    total += bytes.length;
    loaded.push({ ...part, bytes });
    if (journal) {
      journal.add(`download validado: ${part.path}, ${bytes.length} bytes, sha256 ${digest}`);
    }
  }
  ui.log(`${loaded.length} arquivos carregados e validados (${total} bytes).`);
  return loaded;
}

async function runInstall(ui) {
  ui.setBusy(true);
  const journal = new SessionJournal();
  const controller = new AbortController();
  let flasher = null;
  let cleanup = { closed: true, errors: [] };
  try {
    if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      throw new InstallerError("Web Serial exige HTTPS ou localhost. Publique no GitHub Pages ou execute em servidor local seguro.");
    }

    const manifest = await loadManifest({ signal: controller.signal });
    journal.add(`manifesto validado: Host PSM ${manifest.version}`);

    const selection = await ui.showChoice({
      title: "Instalar Host PSM na ESP32-S2",
      body: `
        <p>Instalar <strong>Host PSM ${escapeHtml(manifest.version)}</strong> nesta ESP32-S2?</p>
        <p>Mantenha a ESP32-S2 conectada ao computador até terminar.</p>
      `,
      primary: "Instalar",
      secondary: "Cancelar",
      primaryAction: () => navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x303a, usbProductId: 0x0002 }],
      }),
    });
    if (!selection || selection.choice !== "primary" || !selection.value) {
      ui.setStage("Instalação cancelada.");
      journal.add("seleção de porta cancelada; nenhuma porta foi aberta");
      return;
    }
    const port = selection.value;
    const info = typeof port.getInfo === "function" ? (port.getInfo() || {}) : {};
    const vid = Number.isInteger(info.usbVendorId) ? info.usbVendorId : null;
    const pid = Number.isInteger(info.usbProductId) ? info.usbProductId : null;
    if (vid !== 0x303a || pid !== 0x0002) {
      throw new InstallerError("A porta selecionada não corresponde à interface USB esperada da ESP32-S2.");
    }
    journal.add("porta ESP32-S2 selecionada; mantida fechada durante a validação dos arquivos");

    ui.openProgress("Instalando Host PSM", "Carregando firmware local.");
    const parts = await loadFirmwareParts(ui, manifest.parts, { signal: controller.signal, journal });
    throwIfAborted(controller.signal);

    flasher = new HostPsmSerialFlasher(ui, port, { signal: controller.signal, journal });
    try {
      await flasher.flash(parts);
    } finally {
      cleanup = await flasher.closePort();
    }

    if (!flasher.allVerified) {
      throw new InstallerError("A instalação terminou sem confirmação completa da flash.");
    }
    ui.updateProgress(1, "Concluído.");
    ui.setStage("Host PSM instalado com sucesso.");
    await ui.showDone();
  } catch (error) {
    if (flasher && flasher.state !== "closed" && flasher.state !== "closed-uncertain") {
      cleanup = await flasher.closePort();
    }
    ui.setStage("Instalação não concluída.");
    journal.add(`falha: ${error && error.message ? error.message : error}`);
    const base = error instanceof Error ? error.message : String(error);
    const suffix = cleanup && cleanup.closed === false
      ? " Desconecte fisicamente a ESP32-S2 antes de tentar novamente."
      : "";
    await ui.showError(new InstallerError(base + suffix));
  } finally {
    ui.setBusy(false);
  }
}

if (typeof document !== "undefined" && typeof navigator !== "undefined") {
  const ui = new InstallerUi();
  ui.start();
  ui.onInstall(() => {
    runInstall(ui);
  });
}

export {
  DEFAULT_TIMEOUTS,
  ESP32_S2_MAGIC,
  EXPECTED_PARTS,
  FLASH_BYTES,
  HostPsmSerialFlasher,
  InstallerError,
  CancelledError,
  ProtocolError,
  SessionExpiredError,
  SlipFrameReader,
  TimeoutError,
  concatBytes,
  flashChecksum,
  loadFirmwareParts,
  loadManifest,
  makePacket,
  normalizeManifest,
  parseResponse,
  runInstall,
  sha256Hex,
  slipEncode,
  u32Packet,
  validateRomResponse,
  withTimeout,
};
