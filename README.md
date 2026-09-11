# Host PSM • ESP32-S2

Web Installer do Host PSM para ESP32-S2.

- PS5 FW 12.02–12.70
- firmware gerado diretamente pelo build validado do projeto
- quatro componentes nos mesmos offsets usados pela gravação local
- sem dump da ESP32-S2
- sem arquivo artificial de 4 MiB
- NVS não é incluída no manifesto
- interface interna do instalador em PT-BR e tema escuro alinhado à janela nativa do navegador
- runtime do ESP Web Tools espelhado pelo gerador e publicado localmente no próprio GitHub Pages
- o navegador do usuário final não depende de unpkg/CDN para executar o instalador

A janela de seleção da porta serial continua sendo a janela nativa do Chrome/Edge. Por segurança do Web Serial, ela não é desenhada nem controlada pela página.
