const ROM = {
  flashBegin: 0x02,
  flashData: 0x03,
  flashEnd: 0x04,
  sync: 0x08,
  spiAttach: 0x0d,
};

const CHIP_FAMILY = "ESP32-S2";
const INITIAL_BAUD = 115200;
const FLASH_BLOCK_SIZE = 0x400;
const FLASH_SECTOR_SIZE = 0x1000;
const SERIAL_FILTERS = [
  { usbVendorId: 0x303a },
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x1a86 },
  { usbVendorId: 0x0403 },
];
const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nextBrowserPaint() {
  if (typeof requestAnimationFrame !== "function") {
    return sleep(0);
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

async function letBrowserBreathe(delayMs = 0) {
  if (delayMs > 0) {
    await sleep(delayMs);
  }
  await nextBrowserPaint();
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

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
  if (!frame || frame.length < 8) {
    return null;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const size = view.getUint16(2, true);
  return {
    direction: frame[0],
    command: frame[1],
    size,
    value: view.getUint32(4, true),
    data: frame.slice(8, Math.min(frame.length, 8 + size)),
  };
}

function responseStatusError(response) {
  if (!response || response.direction !== 0x01) {
    return "resposta invalida do bootloader";
  }
  if (response.data.length >= 2) {
    const status = response.data[response.data.length - 2];
    const error = response.data[response.data.length - 1];
    if (status !== 0) {
      return `bootloader recusou o comando (status ${status}, erro ${error})`;
    }
  }
  return "";
}

class SlipFrameReader {
  constructor(reader) {
    this.reader = reader;
    this.frames = [];
    this.waiters = [];
    this.current = [];
    this.inFrame = false;
    this.escaped = false;
    this.stopped = false;
    this.pumpPromise = this.pump();
  }

  async pump() {
    try {
      while (!this.stopped) {
        const { value, done } = await this.reader.read();
        if (done) {
          break;
        }
        if (value) {
          this.feed(value);
        }
      }
    } catch (error) {
      if (!this.stopped) {
        this.rejectAll(error);
      }
    }
  }

  feed(chunk) {
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
        this.escaped = true;
        continue;
      }
      if (this.escaped) {
        if (byte === SLIP_ESC_END) {
          this.current.push(SLIP_END);
        } else if (byte === SLIP_ESC_ESC) {
          this.current.push(SLIP_ESC);
        }
        this.escaped = false;
        continue;
      }
      this.current.push(byte);
    }
  }

  pushFrame(frame) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.frames.push(frame);
    }
  }

  rejectAll(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  nextFrame(timeoutMs) {
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
        reject(new Error("tempo esgotado aguardando resposta da ESP32-S2"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  clear() {
    this.frames.length = 0;
  }

  async waitFor(command, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const frame = await this.nextFrame(Math.max(50, deadline - performance.now()));
      const response = parseResponse(frame);
      if (response && response.command === command) {
        return response;
      }
    }
    throw new Error("tempo esgotado aguardando resposta da ESP32-S2");
  }

  async stop() {
    this.stopped = true;
    this.rejectAll(new Error("leitura serial finalizada"));
    try {
      await this.reader.cancel();
    } catch (_) {
      // Porta ja encerrada.
    }
    try {
      this.reader.releaseLock();
    } catch (_) {
      // Lock ja liberado pelo navegador.
    }
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
      resolve(result);
    }
  }

  showChoice({ title, body, primary = "Instalar", secondary = "Cancelar" }) {
    this.modalTitle.textContent = title;
    this.modalBody.innerHTML = body;
    this.modalPrimary.hidden = false;
    this.modalSecondary.hidden = false;
    this.modalClose.hidden = false;
    this.modalPrimary.disabled = false;
    this.modalSecondary.disabled = false;
    this.modalPrimary.textContent = primary;
    this.modalSecondary.textContent = secondary;
    this.modalPrimary.onclick = () => this.closeModal("primary");
    this.modalSecondary.onclick = () => this.closeModal("secondary");
    this.modalClose.onclick = () => this.closeModal("close");
    this.modal.classList.add("open");
    this.modal.setAttribute("aria-hidden", "false");
    return new Promise((resolve) => {
      this.modalResolve = resolve;
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
    if (!log) {
      return;
    }
    log.textContent += `${message}\n`;
    log.scrollTop = log.scrollHeight;
  }

  async showDone() {
    this.modalTitle.textContent = "Instalação concluída";
    this.modalBody.innerHTML = `
      <p>Host PSM instalado.</p>
      <p>Para iniciar o Host PSM, reinicie a ESP32-S2 uma vez.</p>
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
  constructor(ui) {
    this.ui = ui;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.slip = null;
  }

  async openPort() {
    this.ui.updateProgress(0.08, "Selecione a porta serial da ESP32-S2.");
    this.port = await navigator.serial.requestPort({ filters: SERIAL_FILTERS });
    this.ui.updateProgress(0.09, "Porta selecionada. Preparando comunicação.");
    await letBrowserBreathe(350);
    this.ui.log("Porta selecionada.");
    await withTimeout(
      this.port.open({ baudRate: INITIAL_BAUD, bufferSize: 65536 }),
      5000,
      "tempo esgotado ao abrir a porta serial"
    );
    await letBrowserBreathe(150);
    this.ui.log(`Conectado a ${INITIAL_BAUD} bps.`);
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.slip = new SlipFrameReader(this.reader);
  }

  async closePort() {
    if (this.slip) {
      await this.slip.stop();
      this.slip = null;
    }
    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch (_) {
        // Lock ja liberado pelo navegador.
      }
      this.writer = null;
    }
    if (this.port) {
      try {
        await this.port.close();
      } catch (_) {
        // Porta ja encerrada.
      }
      this.port = null;
    }
  }

  async command(command, payload = new Uint8Array(), checksum = 0, timeoutMs = 4000) {
    this.slip.clear();
    await withTimeout(
      this.writer.write(slipEncode(makePacket(command, payload, checksum))),
      timeoutMs,
      "tempo esgotado ao enviar dados para a ESP32-S2"
    );
    const response = await this.slip.waitFor(command, timeoutMs);
    const error = command === ROM.sync ? "" : responseStatusError(response);
    if (error) {
      throw new Error(error);
    }
    return response;
  }

  async sync() {
    const payload = new Uint8Array(36);
    payload.set([0x07, 0x07, 0x12, 0x20]);
    payload.fill(0x55, 4);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await this.command(ROM.sync, payload, 0, 900);
        this.ui.log("Bootloader serial sincronizado.");
        return;
      } catch (_) {
        await sleep(120);
      }
    }
    throw new Error("não foi possível sincronizar com o bootloader da ESP32-S2");
  }

  async verifyBootloader() {
    this.ui.updateProgress(0.12, "Verificando comunicação com a ESP32-S2.");
    try {
      await this.sync();
      return;
    } catch (error) {
      this.ui.log(error.message);
    }
    throw new Error("A ESP32-S2 não respondeu para gravação. Feche programas que usam a porta, coloque a placa em modo BOOT e tente novamente.");
  }

  async attachFlash() {
    this.ui.updateProgress(0.16, "Preparando a flash da ESP32-S2.");
    await this.command(ROM.spiAttach, u32Packet([0]), 0, 4000);
    this.ui.log("Flash SPI preparada.");
  }

  async flashPart(part, writtenBytes, totalBytes) {
    const eraseSize = alignUp(part.bytes.length, FLASH_SECTOR_SIZE);
    const blockCount = Math.ceil(part.bytes.length / FLASH_BLOCK_SIZE);
    const begin = u32Packet([eraseSize, blockCount, FLASH_BLOCK_SIZE, part.offset]);
    this.ui.log(`${part.path} @ 0x${part.offset.toString(16)} (${part.bytes.length} bytes)`);
    await this.command(ROM.flashBegin, begin, 0, 10000);

    let written = 0;
    for (let sequence = 0; sequence < blockCount; sequence += 1) {
      const start = sequence * FLASH_BLOCK_SIZE;
      const end = Math.min(start + FLASH_BLOCK_SIZE, part.bytes.length);
      const block = new Uint8Array(FLASH_BLOCK_SIZE);
      block.fill(0xff);
      block.set(part.bytes.slice(start, end));
      const header = u32Packet([FLASH_BLOCK_SIZE, sequence, 0, 0]);
      const payload = concatBytes([header, block]);
      await this.command(ROM.flashData, payload, flashChecksum(block), 8000);
      written += end - start;
      if (sequence % 16 === 0 || sequence + 1 === blockCount) {
        const ratio = 0.18 + ((writtenBytes + written) / totalBytes) * 0.78;
        this.ui.updateProgress(ratio, `Gravando ${part.path} (${Math.round((written / part.bytes.length) * 100)}%).`);
        await letBrowserBreathe();
      }
    }
  }

  async flash(parts) {
    await this.openPort();
    await this.verifyBootloader();
    await this.attachFlash();

    const totalBytes = parts.reduce((sum, part) => sum + part.bytes.length, 0);
    let writtenBytes = 0;
    for (const part of parts) {
      await this.flashPart(part, writtenBytes, totalBytes);
      writtenBytes += part.bytes.length;
    }

    this.ui.updateProgress(0.98, "Finalizando gravação.");
    // Mantem a ESP32-S2 no bootloader: reboot automatico via Web Serial pode
    // derrubar/recriar a porta USB e travar o Chrome em algumas placas.
    await this.command(ROM.flashEnd, u32Packet([1]), 0, 10000);
    await letBrowserBreathe(500);
    this.ui.updateProgress(1, "Instalação concluída.");
  }
}

async function loadManifest() {
  const response = await fetch("manifest.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("manifest.json não foi encontrado no Web Installer.");
  }
  const manifest = await response.json();
  if (manifest.new_install_prompt_erase !== false) {
    throw new Error("manifest.json inválido: erase integral não é permitido neste instalador.");
  }
  const builds = Array.isArray(manifest.builds) ? manifest.builds : [];
  if (builds.length !== 1 || builds[0].chipFamily !== CHIP_FAMILY) {
    throw new Error("manifest.json inválido para ESP32-S2.");
  }
  const parts = Array.isArray(builds[0].parts) ? builds[0].parts : [];
  if (!parts.length) {
    throw new Error("Este instalador ainda não recebeu os arquivos de firmware. Execute GERAR_HOST_INSTALLER.bat antes de publicar.");
  }
  const normalizedParts = parts.map((part) => {
    if (!part || typeof part.path !== "string" || !Number.isInteger(part.offset)) {
      throw new Error("manifest.json contém uma parte de firmware inválida.");
    }
    if (/^[a-z]+:/i.test(part.path) || part.path.includes("..") || !part.path.startsWith("firmware/")) {
      throw new Error(`caminho de firmware bloqueado: ${part.path}`);
    }
    return { path: part.path, offset: part.offset >>> 0, bytes: null };
  });
  return {
    name: manifest.name || "Host PSM ESP32-S2",
    version: manifest.version || "1.1.0",
    parts: normalizedParts,
  };
}

async function loadFirmwareParts(ui, parts) {
  const loaded = [];
  let total = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    ui.updateProgress(0.02 + (index / Math.max(parts.length, 1)) * 0.05, `Carregando ${part.path}.`);
    const response = await fetch(part.path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`arquivo de firmware não encontrado: ${part.path}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) {
      throw new Error(`arquivo de firmware vazio: ${part.path}`);
    }
    await letBrowserBreathe();
    total += bytes.length;
    loaded.push({ ...part, bytes });
  }
  ui.log(`${loaded.length} arquivos carregados (${total} bytes).`);
  return loaded;
}

async function runInstall(ui) {
  ui.setBusy(true);
  try {
    if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      throw new Error("Web Serial exige HTTPS ou localhost. Publique no GitHub Pages ou execute em servidor local seguro.");
    }
    const manifest = await loadManifest();
    const choice = await ui.showChoice({
      title: "Instalar Host PSM na ESP32-S2",
      body: `
        <p>Instalar <strong>Host PSM ${escapeHtml(manifest.version)}</strong> nesta ESP32-S2?</p>
        <p>Mantenha a ESP32-S2 conectada ao computador até terminar.</p>
      `,
      primary: "Instalar",
      secondary: "Cancelar",
    });
    if (choice !== "primary") {
      ui.setStage("Instalação cancelada.");
      return;
    }

    ui.openProgress("Instalando Host PSM", "Carregando firmware local.");
    const parts = await loadFirmwareParts(ui, manifest.parts);
    const flasher = new HostPsmSerialFlasher(ui);
    try {
      await flasher.flash(parts);
    } finally {
      await flasher.closePort();
    }
    ui.setStage("Host PSM instalado com sucesso.");
    await ui.showDone();
  } catch (error) {
    if (error && error.name === "NotFoundError") {
      ui.setStage("Seleção da porta cancelada.");
      await ui.showError(new Error("Seleção da porta serial cancelada."));
    } else {
      ui.setStage("Instalação não concluída.");
      await ui.showError(error);
    }
  } finally {
    ui.setBusy(false);
  }
}

const ui = new InstallerUi();
ui.start();
ui.onInstall(() => {
  runInstall(ui);
});
