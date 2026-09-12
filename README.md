# Host PSM • ESP32-S2

Web Installer do Host PSM para ESP32-S2.

- PS5 FW 12.02–12.70
- firmware gerado diretamente pelo build validado do projeto
- quatro componentes nos mesmos offsets usados pela gravação local
- sem dump da ESP32-S2
- sem arquivo artificial de 4 MiB
- NVS não é incluída no manifesto
- instalador local em JavaScript, sem CDN e sem ESP Web Tools remoto
- telas controladas pelo Host PSM em português; seletor de porta serial é nativo do navegador
- preparação explícita da ESP32-S2 com BOOT/B0 antes da seleção da porta
- a porta escolhida permanece fechada enquanto os quatro binários são baixados e validados
- manifesto gerado com tamanho, SHA-256 e MD5 esperado de cada região publicada
- gravação só avança com respostas ROM estruturalmente válidas e identificação da ESP32-S2
- cada região é conferida na flash pelo MD5 retornado pela ROM
- conclusão sem reset automático: após gravação verificada, desconecte e reconecte a ESP32-S2 com BOOT liberado

O `manifest.json` mantido no projeto-fonte não contém binários por definição. Execute o gerador do projeto para produzir os quatro arquivos e os metadados de integridade pertencentes ao mesmo build antes da publicação.
