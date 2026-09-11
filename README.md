# Host PSM ESP32-S2 — Web Installer

O gerador publica somente os quatro binarios reais do build HostPSM nos offsets validados.
A NVS nao e incluida nem apagada pelo manifesto.

A interface usa uma copia local validada do ESP Web Tools em `vendor/`.
Os textos do componente sao localizados para PT-BR durante a preparacao do runtime, antes da publicacao.
Nao existe interceptacao de Shadow DOM, `attachShadow`, `MutationObserver` ou alteracao do fluxo serial em runtime.
A janela de escolha da porta COM continua sendo a janela nativa de seguranca do navegador.
