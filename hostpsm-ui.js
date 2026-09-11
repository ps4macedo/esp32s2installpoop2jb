/* Host PSM - camada visual/localizacao do ESP Web Tools.
   Nao interfere no protocolo serial, no manifesto ou na gravacao.
   A janela de selecao de porta continua nativa do navegador por seguranca. */
(function () {
  "use strict";

  const STYLE_ID = "hostpsm-esp-web-tools-theme";
  const observedRoots = new WeakSet();
  let scanQueued = false;

  const exactText = new Map([
    ["Install Host PSM ESP32-S2", "Instalar Host PSM ESP32-S2"],
    ["Logs & Console", "Logs e Console"],
    ["Confirm Installation", "Confirmar instalação"],
    ["All data on the device will be erased.", "Todos os dados do dispositivo serão apagados."],
    ["Back", "Voltar"],
    ["Install", "Instalar"],
    ["Cancel", "Cancelar"],
    ["Close", "Fechar"],
    ["Retry", "Tentar novamente"],
    ["Try again", "Tentar novamente"],
    ["Erase device", "Apagar dispositivo"],
    ["Download logs", "Baixar logs"],
    ["Connecting...", "Conectando..."],
    ["Preparing...", "Preparando..."],
    ["Installing...", "Instalando..."],
    ["Installation complete", "Instalação concluída"],
    ["Installation complete!", "Instalação concluída!"],
    ["Failed to connect", "Falha ao conectar"],
    ["Console", "Console"],
    ["Logs", "Logs"]
  ]);

  const THEME = `
:host {
  color-scheme: dark !important;
  --mdc-theme-primary: #8ab4f8 !important;
  --mdc-theme-secondary: #8ab4f8 !important;
  --mdc-theme-background: #202124 !important;
  --mdc-theme-surface: #202124 !important;
  --mdc-theme-on-primary: #202124 !important;
  --mdc-theme-on-secondary: #202124 !important;
  --mdc-theme-on-background: #f1f3f4 !important;
  --mdc-theme-on-surface: #f1f3f4 !important;
  --mdc-theme-text-primary-on-background: #f1f3f4 !important;
  --mdc-theme-text-secondary-on-background: #bdc1c6 !important;
  --mdc-dialog-heading-ink-color: #f1f3f4 !important;
  --mdc-dialog-content-ink-color: #bdc1c6 !important;
  --mdc-dialog-container-color: #202124 !important;
  --mdc-menu-surface-fill-color: #202124 !important;
  --mdc-list-list-item-label-text-color: #f1f3f4 !important;
  --mdc-text-button-label-text-color: #8ab4f8 !important;
}

.mdc-dialog__surface,
.mdc-menu-surface,
.mdc-card,
dialog,
[role="dialog"],
[role="menu"] {
  background-color: #202124 !important;
  color: #f1f3f4 !important;
  border: 1px solid #5f6368 !important;
  border-radius: 18px !important;
  box-shadow: 0 24px 48px rgba(0,0,0,.58), inset 0 1px 0 rgba(255,255,255,.035) !important;
}

.mdc-dialog__scrim,
.scrim,
[part="scrim"] {
  background-color: rgba(0,0,0,.62) !important;
}

.mdc-dialog__title,
.mdc-list-item__primary-text,
.mdc-list-item__text,
[part="title"] {
  color: #f1f3f4 !important;
}

.mdc-dialog__content,
.mdc-list-item__secondary-text,
[part="content"] {
  color: #bdc1c6 !important;
}

.mdc-list,
.mdc-list-item,
[role="menuitem"],
[role="option"] {
  background-color: transparent !important;
  color: #f1f3f4 !important;
}

.mdc-list-item:hover,
[role="menuitem"]:hover,
[role="option"]:hover {
  background-color: rgba(138,180,248,.12) !important;
}

.mdc-list-item--selected,
.mdc-list-item[aria-selected="true"],
[role="option"][aria-selected="true"] {
  background-color: #285899 !important;
  color: #fff !important;
}

.mdc-button,
button,
a[role="button"] {
  color: #8ab4f8 !important;
}

.mdc-button--raised,
.mdc-button--unelevated,
button[raised],
button.primary,
[part="primary-action"] {
  background-color: #2b5c9d !important;
  color: #fff !important;
}

.mdc-linear-progress__bar-inner,
progress::-webkit-progress-value {
  background-color: #8ab4f8 !important;
}

pre,
code,
textarea,
.mdc-text-field,
[part="console"] {
  background-color: #17191c !important;
  color: #e8eaed !important;
  border-color: #5f6368 !important;
}

svg,
.mdc-list-item__graphic,
[part="icon"] {
  color: #e8eaed !important;
  fill: currentColor;
}
`;

  function translateValue(value) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return value;

    const direct = exactText.get(trimmed);
    if (direct !== undefined) {
      return value.replace(trimmed, direct);
    }

    let match = trimmed.match(/^Do you want to install (.+)\?$/);
    if (match) return value.replace(trimmed, `Deseja instalar ${match[1]}?`);

    match = trimmed.match(/^Installing (.+)\.\.\.$/);
    if (match) return value.replace(trimmed, `Instalando ${match[1]}...`);

    match = trimmed.match(/^Successfully installed (.+)\.?$/);
    if (match) return value.replace(trimmed, `${match[1]} instalado com sucesso.`);

    return value;
  }

  function translateElementAttributes(el) {
    if (!(el instanceof Element)) return;
    for (const name of ["title", "aria-label"]) {
      if (!el.hasAttribute(name)) continue;
      const before = el.getAttribute(name);
      const after = translateValue(before);
      if (after !== before) el.setAttribute(name, after);
    }
  }

  function translateTree(root) {
    const owner = root instanceof Document ? root : (root.ownerDocument || document);
    const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (parent && (parent.tagName === "STYLE" || parent.tagName === "SCRIPT")) continue;
      const before = node.nodeValue;
      const after = translateValue(before);
      if (after !== before) node.nodeValue = after;
    }

    if (root instanceof Element) translateElementAttributes(root);
    if (root.querySelectorAll) {
      root.querySelectorAll("*").forEach(translateElementAttributes);
    }
  }

  function scanNestedShadows(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) instrumentShadow(el.shadowRoot);
    });
  }

  function instrumentShadow(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);

    if (!root.getElementById || !root.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = THEME;
      root.appendChild(style);
    }

    translateTree(root);
    scanNestedShadows(root);

    const observer = new MutationObserver((mutations) => {
      let needsScan = false;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const before = mutation.target.nodeValue;
          const after = translateValue(before);
          if (after !== before) mutation.target.nodeValue = after;
          continue;
        }
        if (mutation.type === "attributes") {
          translateElementAttributes(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const before = node.nodeValue;
            const after = translateValue(before);
            if (after !== before) node.nodeValue = after;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            translateTree(node);
            if (node.shadowRoot) instrumentShadow(node.shadowRoot);
            needsScan = true;
          }
        });
      }
      if (needsScan) queueScan();
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["title", "aria-label"]
    });
  }

  function scanDocument() {
    scanQueued = false;
    document.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) instrumentShadow(el.shadowRoot);
    });
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(scanDocument);
  }

  const nativeAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = nativeAttachShadow.call(this, init);
    if (init && init.mode === "open") queueMicrotask(() => instrumentShadow(root));
    return root;
  };

  document.addEventListener("DOMContentLoaded", queueScan, { once: true });
  document.addEventListener("click", () => {
    queueScan();
    setTimeout(queueScan, 40);
    setTimeout(queueScan, 180);
  }, true);

  if (window.customElements && customElements.whenDefined) {
    customElements.whenDefined("esp-web-install-button").then(queueScan).catch(() => {});
  }
})();
