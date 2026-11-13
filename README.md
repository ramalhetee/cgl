# CGL

App de chat próprio: servidores, canais de texto, conversas diretas, presença, anexos, reações,
salas de voz com câmera e compartilhamento de tela.

## Rodar

```bash
npm install
npm run build      # compila a interface (web/dist)
npm start          # servidor em http://localhost:3210
npm run desktop    # janela desktop (sobe o servidor sozinho se precisar)
```

Desenvolvimento com recarga automática: `npm run dev:server` e `npm run dev:web` (http://localhost:5173).

## Estrutura

- `server/` — Fastify + Socket.IO + SQLite (`node:sqlite`, Node 24+). Dados em `server/data/`.
- `web/` — React + Vite + TypeScript. `src/voice.ts` cuida das chamadas WebRTC.
- `desktop/` — casca Electron.
- `scripts/smoke.mjs` — segundo usuário simulado para teste (`node scripts/smoke.mjs <convite>`).

## Limites conhecidos

- Chamadas são em malha (cada um conecta em cada um): bom até uns 6 participantes.
- Só STUN, sem TURN: atrás de algumas redes a chamada pode não conectar.
- Microfone, câmera e tela exigem `localhost` ou HTTPS. Para usar de outro PC, ponha o servidor atrás de HTTPS.
- Variáveis: `PORT`, `HOST`, `TAVERNA_DATA` (servidor) e `TAVERNA_URL` (desktop apontando para outro servidor).

## Aplicativo (Windows)

```bash
npm run pack       # gera release/CGL-win32-x64/CGL.exe
```

Ao abrir, o app pergunta: **Hospedar** (este PC vira o servidor, dados em `%APPDATA%\CGL\dados`) ou
**Entrar** (endereço de quem hospeda, ex.: `192.168.0.10:3210`). Quem entra usa uma ponte local, então
microfone, câmera e tela funcionam sem HTTPS. O compartilhamento de tela usa um seletor próprio.

Fora da mesma rede: quem hospeda clica em **Abrir pra internet**. O app sobe um túnel rápido da Cloudflare
(`cloudflared`, versão e SHA-256 fixos em `scripts/build-desktop.mjs`) e copia um link
`https://....trycloudflare.com`; os outros colam esse link em **Entrar**. O link muda a cada vez e vale
enquanto o app do anfitrião estiver aberto. Texto, anexos e sinalização passam pelo túnel; áudio, vídeo e
tela continuam indo direto entre os participantes.

Testes do app empacotado: `node scripts/app-test.mjs`, `node scripts/picker-test.mjs` e `node scripts/tunnel-test.mjs`.

## Atualização automática

A partir da 0.5.0, o CGL confere a versão mais nova publicada em Releases ao abrir (e a cada 30 minutos),
baixa o `CGL.zip` em segundo plano e confere o SHA-256 que o GitHub publica para o arquivo. Se não conferir,
nada é instalado. Quando a pessoa clica em atualizar, a própria versão nova espera o app fechar, troca a pasta
do app (com volta atrás se falhar) e reabre. Para publicar uma versão: suba `desktop/package.json` (`version`),
rode `npm run pack`, compacte `release/CGL-win32-x64` como `CGL.zip` e crie a Release com a tag `vX.Y.Z`.
Teste: `node scripts/updater-test.mjs` (simula o GitHub localmente).

