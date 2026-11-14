# Plano mestre: CGL mais leve (sair do Electron?) + arquitetura

Junta duas frentes num roteiro só:
1. **Arquitetura**: separar responsabilidades, detalhada em [plano-arquitetura.md](plano-arquitetura.md).
2. **Desktop leve**: avaliar a troca do Electron, inspirada no Discord Phoenix. A matriz da seção 2.1 diz se cada funcionalidade atual continua funcionando.
3. **Nova feature**: supressão de ruído com RNNoise (seção 9).

## Status

**Etapa 1 concluída (14/11/2026):**
- **1.1** Teste de contrato em `server/test/contract.test.js`: 50 testes, roda com `npm test -w server`. Verde no código atual. Também confirmei que ele pega regressões: quebrei o servidor de propósito (texto de erro, sincronização do perfil, validação de emoji) e o teste falhou.
- **1.2** Medição base em [medicoes.md](medicoes.md), feita com `node scripts/bench.mjs`.
- **1.3** Ponte isolada em `web/src/desktop.ts`. Os testes empacotados `app-test`, `updater-test` e `links-theme-test` continuam verdes.

**Etapa 2.2 concluída (14/11/2026): supressão de ruído RNNoise.**
- `web/src/noise.ts` + `VoiceSession.setNoiseMode`.
- Chave `noise` aceita pelo servidor, coberta pelo teste de contrato (51 verdes).
- Seletor + "ouvir meu microfone" em Ajustes.
- Licenças em `web/public/licencas.txt`, que também abrem dentro de Ajustes.
- `noise-test`: o ruído cai 53 dB, +1 ponto de CPU (ver [medicoes.md](medicoes.md)).
- `audio-test` e `speaking-test` continuam verdes.

**DECISÃO 1 tomada:** ficar no Electron. A próxima frente é a arquitetura em JS (fases 1 a 8 do plano de arquitetura). O protótipo Tauri fica para quando o tamanho do download importar.

Contexto da decisão: A medição mostrou que a abertura já é rápida (~0,5 s) e a memória fica em ~330 MB privada (perto dos 290 MB do Phoenix). O ganho claro de um casco Tauri seria o **tamanho**: 413 MB → ~15 MB.

---

## 1. O que o Discord fez (Project Phoenix)

Fonte: vídeo "Discord is moving completely to Rust..." (Let's Get Rusty), a demo oficial do Discord e as reportagens de nov/2026.

- **Desktop:** o Electron foi trocado por **Rust + GPUI**, o framework de UI nativa acelerada por GPU feito pelo time do editor Zed. Não é Tauri e não é webview. O CTO disse literalmente "it's not Tauri, it's GPUI".
- **Mobile:** o React Native foi trocado por UI nativa (iOS/Android). Mobile e desktop compartilham **o mesmo núcleo em Rust** (a camada de aplicação).
- **Números mostrados:**
  - abertura: 5,5 s → 33 ms no desktop, 4,2 s → 0,5 s no celular
  - memória: ~290 MB contra 1 a 2 GB do app atual
- **Cuidados com esses números:**
  - É **um print** de uma build inicial, com duas contas abertas. Não há benchmark controlado.
  - Não se sabe o comportamento **em chamada de voz ou transmissão de tela**.
  - Embeds (YouTube, Activities) continuam usando webview.
- **Contexto que não dá pra copiar:**
  - O Discord usa Rust desde 2018 e já tinha voz e infraestrutura em Rust.
  - Fez fork e patches no GPUI, que estava há cerca de 1 ano sem release.
  - Tem centenas de engenheiros e vai liberar primeiro pra ~100 testadores.
  - Ainda não há data de lançamento.

**Lição pro CGL:** o ganho do Discord vem de três coisas juntas: (a) tirar o Chromium inteiro, (b) UI nativa, (c) um núcleo Rust que já existia. O app do Discord é enorme. O CGL é bem menor, então **antes de tudo é preciso medir quanto o CGL realmente gasta**.

---

## 2. Onde o CGL depende do Electron hoje

Mapeado em `desktop/main.cjs` (404 linhas), `preload.cjs`, `updater.cjs`, `launcher.html` e `picker.html`.

| Recurso | Como é feito hoje | Dificuldade de trocar |
|---|---|---|
| **Servidor embutido** | `main.cjs:142` importa o `server.mjs` (Node) **dentro do processo do Electron**: quem hospeda roda o servidor no próprio app | **Alta.** Sem Electron não há Node. Ou o servidor vai pra Rust, ou leva um Node junto (aí some boa parte do ganho) |
| **Transmissão de tela com seletor próprio** | `setDisplayMediaRequestHandler` + `desktopCapturer.getSources` + `picker.html` | **Alta.** O WebView2 só deixa permitir ou bloquear o seletor nativo dele (`ScreenCaptureStarting`). Não dá pra entregar uma fonte escolhida por nós sem código nativo |
| **Som do PC na transmissão sem eco do próprio CGL** | `audio: 'loopback'` no handler + `restrictOwnAudio: true` em `voice.ts:181` (tem teste: `ownaudio-test`) | **Média/alta.** Depende do Chromium do WebView2 e do seletor nativo. Precisa ser provado num protótipo |
| **Atalhos globais** (mutar/ensurdecer) | `globalShortcut` | Baixa: `tauri-plugin-global-shortcut` |
| **Atualização automática** | `updater.cjs` (238 linhas, SHA-256, troca de pasta) | Média: `tauri-plugin-updater` (pacote assinado). **A última versão Electron precisa saber instalar a primeira versão nova** |
| **Túnel Cloudflare** | `spawn(cloudflared.exe)` | Baixa: sidecar do Tauri |
| **Ponte local de convidado** | proxy HTTP + WebSocket em `127.0.0.1:32100` (`main.cjs:147`) | Média: reescrever em Rust (hyper) |
| **Tela inicial, várias janelas, sessão por sala** | `BrowserWindow`, `session.fromPartition` | Média |
| **Ponte página ↔ app** | `window.taverna` com 16 métodos (`preload.cjs`) | **Boa notícia:** já é uma seam limpa. É só reimplementar os 16 métodos |

A interface React (`web/`) e o WebRTC (`voice.ts`, `audio.ts`) **funcionam em qualquer webview Chromium**, ou seja, no WebView2 também.

### 2.1 Matriz de compatibilidade: as funcionalidades atuais continuam funcionando?

Legenda:
- ✅ funciona sem mudança
- 🔧 funciona, mas precisa reimplementar no casco ou no servidor (trabalho conhecido)
- ⚠️ **risco: precisa ser provado no protótipo** (etapa 3)
- ➕ nova

Colunas: **A** = Electron otimizado, **B** = Tauri + servidor Rust.

| # | Funcionalidade | Onde vive hoje | A | B | Como garantir em B |
|---|---|---|---|---|---|
| 1 | Conta, login, sessão de 30 dias | servidor | ✅ | 🔧 | contrato. Rust lê os hashes do bcryptjs (`$2a/$2b`) e o mesmo `secret.key` (tokens atuais valem) |
| 2 | Perfil: nome, status, bio, cor, foto com recorte | servidor + web (canvas) | ✅ | 🔧 servidor / ✅ tela | contrato + `profile-test`, `crop-test` |
| 3 | Servidores, canais de texto e voz, convites, membros | servidor | ✅ | 🔧 | contrato |
| 4 | Conversas diretas | servidor | ✅ | 🔧 | contrato |
| 5 | Mensagens: enviar, editar, apagar, reações, "digitando", histórico, não lidas | servidor + web | ✅ | 🔧 | contrato |
| 6 | Anexos até 25 MB (`.bin` forçado a baixar, `nosniff`) | servidor | ✅ | 🔧 | contrato (cabeçalhos de segurança) |
| 7 | Visualizador de imagem com zoom | web | ✅ | ✅ | `viewer-test` |
| 8 | Links clicáveis + prévia (com proteção contra rede local) + YouTube | servidor (`unfurl.js`) + web | ✅ | 🔧 | portar a proteção SSRF. `unfurl-test` vira teste de contrato |
| 9 | Temas de cor | web + conta | ✅ | ✅ | `links-theme-test` |
| 10 | Presença online | servidor (socket) | ✅ | 🔧 | contrato |
| 11 | Voz WebRTC em malha, mutar, ensurdecer, anel de "falando" | web | ✅ | ✅ (⚠️ permissão) | `speaking-test`. Permissão de microfone e câmera: hoje `setPermissionRequestHandler` só libera pra origem da sala (`main.cjs:201`). No Tauri: `PermissionRequested` do WebView2 |
| 12 | Câmera | web | ✅ | ✅ (⚠️ permissão) | igual ao 11 |
| 13 | Transmissão de tela **com seletor próprio** | casco (`desktopCapturer` + `picker.html`) | ✅ | ⚠️ | protótipo 3.2. Plano B: seletor nativo do WebView2 |
| 14 | Som do PC na transmissão **sem o som do próprio CGL** | casco (`loopback`) + web (`restrictOwnAudio`) | ✅ | ⚠️ | protótipo 3.3 + `ownaudio-test` |
| 15 | Própria tela sem espelho infinito | web | ✅ | ✅ | `ownscreen-test` |
| 16 | Ocultar a transmissão de outra pessoa (ela para de enviar) | web + socket | ✅ | ✅ / 🔧 servidor | `hide-test` |
| 17 | Tela cheia do quadro | web (`requestFullscreen`) + permissão `fullscreen` | ✅ | ⚠️ | protótipo: o WebView2 precisa que o casco trate `ContainsFullScreenElementChanged`. `fullscreen-test` |
| 18 | Volume por pessoa (voz e tela) | web (`AudioMixer`) | ✅ | ✅ | `audio-test` |
| 19 | Escolher microfone e saída, trocar o mic no meio da chamada | web (`setSinkId`, `replaceTrack`) | ✅ | ✅ (⚠️ `setSinkId` no WebView2) | `audio-test` no protótipo |
| 20 | Sons da chamada | web | ✅ | ✅ | `hotkeys-test` |
| 21 | Atalhos globais mutar/ensurdecer, **qualquer tecla do Windows** (incl. `=` e pontuação) | casco (`globalShortcut`) | ✅ | ⚠️ | o plugin do Tauri usa outro formato de tecla, então precisa de uma tabela de conversão. `keys-test`, `hotkeys-test` |
| 22 | Hospedar / Entrar (tela inicial) | casco | ✅ | 🔧 | `app-test` |
| 23 | Ponte local (convidado sem HTTPS) | casco (proxy HTTP+WS) | ✅ | 🔧 | `app-test` |
| 24 | Abrir pra internet (túnel Cloudflare, SHA-256 fixo) | casco | ✅ | 🔧 | `tunnel-test` |
| 25 | Atualização automática (SHA-256, volta atrás se falhar) | casco | ✅ | 🔧 + versão ponte | `updater-test` |
| 26 | Dados em `%APPDATA%\CGL\dados` + migração da pasta antiga | casco | ✅ | 🔧 | mesma pasta, teste de abrir dados de uma versão antiga |
| 27 | Preferências salvas na conta (dispositivos, volumes, atalhos, tema, sons) | servidor | ✅ | 🔧 | contrato |
| 28 | **Supressão de ruído (RNNoise)** | web (WASM) | ➕ | ➕ | seção 9. Funciona igual em A e B |

**Resumo:** das 27 funcionalidades atuais, 22 funcionam ou só precisam ser reimplementadas (trabalho conhecido). **5 dependem do protótipo:** seletor de tela (13), som sem eco (14), tela cheia (17), formato das teclas dos atalhos (21) e a permissão/`setSinkId` no WebView2 (11, 12, 19). Por isso o protótipo da etapa 3 testa exatamente esses itens antes de qualquer migração.

---

## 3. Opções

### A. Continuar no Electron e otimizar
- **Esforço:** baixo (dias).
- **Ganho:** moderado. Dá pra carregar a interface sob demanda, cortar processos sobrando, desligar recursos não usados e medir onde a memória vai.
- **Risco:** quase nenhum. Todos os testes atuais continuam valendo.

### B. Tauri v2 (WebView2) + servidor em Rust ← **candidato principal**
- **Mantém:** toda a interface React e o WebRTC.
- **Troca:**
  - o casco Electron por Tauri (Rust)
  - o servidor Node por Rust: **axum** (HTTP) + **socketioxide** (fala o protocolo do socket.io, então o `socket.io-client` do front continua igual) + **rusqlite** + bcrypt/jsonwebtoken
- **Ganho esperado:**
  - instalador de ~100 MB pra ~10 MB
  - abertura mais rápida
  - sem Node no processo
  - memória: **ganho menor que o do Discord**, porque o WebView2 também é Chromium. No Windows ele é compartilhado com o sistema, mas os processos de render e GPU continuam existindo
- **Riscos:** transmissão de tela com seletor próprio e som sem eco (ver seção 2). Precisam ser provados **antes** de decidir.
- **Esforço:** semanas. O servidor é ~860 linhas e o casco ~840.

### C. Rust nativo com GPUI/Slint/Iced (o caminho do Discord)
- **Reescreve tudo:**
  - as 2.300 linhas da interface
  - WebRTC em Rust (libwebrtc via bindings)
  - captura de tela e de áudio nativas
  - cancelamento de eco, mixagem, dispositivos
- **Ganho:** o máximo possível.
- **Esforço:** meses. O GPUI não tem releases estáveis e o Discord precisou fazer fork.
- **Veredito:** **não recomendado** agora. Só faz sentido se o B não bastar e o CGL crescer muito.

**Recomendação:** seguir **A → medir → protótipo do B → decidir**. O C fica registrado como possibilidade futura.

---

## 4. Como isso muda o plano de arquitetura

Ponto importante: **se o servidor for pra Rust, refatorar o servidor JS (fases 2 a 6 do plano de arquitetura) vira trabalho jogado fora.** Por isso a ordem muda:

- **A fase 0 (teste de contrato) vale em qualquer cenário e fica ainda mais importante.** O teste fala HTTP + socket.io, então ele **não depende da linguagem**. É ele que garante que o servidor em Rust se comporta igual ao JS.
- **As fases 2 a 6 (refatorar o servidor JS) ficam paradas até a decisão.** Se a decisão for B, o servidor Rust já nasce com a estrutura por domínios (`accounts`, `guilds`, `messaging`, `voice`, `realtime`), e o plano de arquitetura vira a planta do código Rust.
- **As fases 7 e 8 (refatorar o front) valem em A e em B,** porque o React fica. Também ajudam a isolar o que é específico do desktop.
- **Vale em qualquer cenário:** isolar a ponte `window.taverna` num módulo do front (`web/src/desktop.ts`) com tipos, pra trocar o casco sem mexer em componente.

---

## 5. Roteiro unificado

Cada etapa tem uma entrega e um critério de pronto. As linhas **[DECISÃO]** são pontos de parada pra decidir juntos.

### Etapa 1: Base de medição e segurança (todas as opções)

| # | Tarefa | Pronto quando |
|---|---|---|
| 1.1 | **Teste de contrato do servidor** (fase 0 do plano de arquitetura) | `npm test -w server` verde no código atual |
| 1.2 | **Medição base do CGL Electron.** Script `scripts/bench.mjs` que abre o app empacotado e mede: tempo até a janela aparecer, até a interface responder, memória total (todos os processos) parado, em chamada de voz e transmitindo tela | tabela com os números atuais, salva em `docs/medicoes.md` |
| 1.3 | Isolar a ponte `window.taverna` em `web/src/desktop.ts` (tipos + checagem se está no desktop) | componentes não usam `window.taverna` direto, testes empacotados verdes |

### Etapa 2: Ganhos rápidos no Electron (opção A)

| # | Tarefa | Pronto quando |
|---|---|---|
| 2.1 | Com base na 1.2, atacar os 3 maiores custos (ex.: carregar sob demanda a janela de seletor e as bibliotecas pesadas, `backgroundThrottling`, cortar processos) | ganho medido contra a 1.2 |
| 2.2 | **Supressão de ruído RNNoise** (seção 9). Não depende da decisão, porque é código da interface web e vale em A e em B | `noise-test` verde + CPU/latência medidas |

**[DECISÃO 1]** Com os números da 1.2 e da 2.1: o CGL ainda está pesado? Se estiver bom, **parar aqui** e seguir só com a arquitetura (fases 2 a 8 em JS).

### Etapa 3: Protótipo Tauri (prova de risco, branch descartável, ~2 a 4 dias)

Objetivo: provar **só o que pode impedir** a migração, sem migrar nada.

| # | Pergunta que o protótipo responde | Como |
|---|---|---|
| 3.1 | O `web/dist` roda no WebView2 com voz entre 2 pessoas? | Tauri mínimo carregando a interface + o servidor Node atual de fora |
| 3.2 | Transmissão de tela funciona? Com qual seletor? | `getDisplayMedia` no WebView2. Testar o seletor nativo e se `ScreenCaptureStarting` dá pra usar pelo `wry`/`webview2-com` |
| 3.3 | O som do PC entra e **o som do próprio CGL fica fora**? | repetir o `ownaudio-test` no protótipo |
| 3.4 | Atalhos globais funcionam com o jogo em foco? | `tauri-plugin-global-shortcut` |
| 3.5 | **Quanto melhora de verdade?** | mesmo script da 1.2 no protótipo |
| 3.6 | O socketioxide atende o contrato? | servidor Rust mínimo (login + `message:send`) rodando um trecho do teste de contrato |
| 3.7 | Permissões de microfone, câmera e tela ficam restritas à origem da sala? | `PermissionRequested` do WebView2 (matriz, itens 11 e 12) |
| 3.8 | Tela cheia do quadro funciona? | `fullscreen-test` (matriz, item 17) |
| 3.9 | `setSinkId` (escolher a saída de som) funciona? | `audio-test` (matriz, item 19) |
| 3.10 | Todas as teclas de atalho de hoje têm equivalente? | tabela formato Electron → formato Tauri + `keys-test` (matriz, item 21) |
| 3.11 | A supressão de ruído (AudioWorklet + WASM) roda no WebView2? | `noise-test` (seção 9) |

**[DECISÃO 2]**
- Se 3.2 ou 3.3 falharem **e** não tiver contorno aceitável → ficar no Electron (opção A).
- Se o ganho medido na 3.5 for pequeno → ficar no Electron.
- Senão → **ir pra opção B**.

### Etapa 4 (se B): Servidor em Rust

Estrutura por domínios, conforme o plano de arquitetura (seção 4), em Rust:

```
server-rs/src/
  main.rs  config.rs  app.rs  error.rs
  db/  (rusqlite, mesmo schema e migrações, abre o taverna.db existente)
  auth/  accounts/  guilds/  messaging/  voice/  realtime/  uploads/  unfurl/
```

| # | Tarefa | Pronto quando |
|---|---|---|
| 4.1 | Fundação: axum + socketioxide + rusqlite. Abre o **mesmo** `taverna.db` e o **mesmo** `secret.key` (tokens atuais continuam válidos) | sobe e responde `/api/me` |
| 4.2 | Domínios, um por vez: accounts → guilds → messaging → uploads → voice → unfurl (com a mesma proteção SSRF) | o trecho correspondente do teste de contrato fica verde |
| 4.3 | Testes de unidade de cada serviço (banco em memória + `notify` falso) | `cargo test` verde |
| 4.4 | Contrato completo | **teste de contrato 100% verde contra o servidor Rust** |

O servidor Node continua no repositório até o fim da etapa 6, como referência e plano B.

### Etapa 5 (se B): Casco Tauri

| # | Tarefa | Pronto quando |
|---|---|---|
| 5.1 | Tela inicial (hospedar/entrar) + janela da sala | fluxo hospedar e entrar funcionando |
| 5.2 | Servidor Rust **embutido** (no mesmo processo ou como sidecar) + ponte local | equivale a `app-test` |
| 5.3 | `window.taverna` reimplementado (16 métodos) via comandos e eventos do Tauri | front sem mudanças além de `desktop.ts` |
| 5.4 | Transmissão de tela + som do PC (solução escolhida na 3.2/3.3) | equivalem a `ownaudio-test`, `ownscreen-test`, `hide-test` |
| 5.5 | Atalhos globais, túnel (sidecar cloudflared com SHA-256 fixo), dados na mesma pasta | equivalem a `hotkeys-test`, `tunnel-test` |
| 5.6 | Atualizador Tauri (assinado) | equivale a `updater-test` |
| 5.7 | Portar os 17 testes empacotados pro casco novo (hoje eles usam o protocolo de depuração do Chromium. O WebView2 também expõe isso, via `--remote-debugging-port`) | todos verdes |

### Etapa 6 (se B): Transição dos usuários

| # | Tarefa | Pronto quando |
|---|---|---|
| 6.1 | Última versão Electron (ponte): o atualizador baixa e instala o CGL Tauri, preservando a pasta de dados | teste simulado igual ao `updater-test` |
| 6.2 | Período de convivência: hospedeiro Electron com convidado Tauri e vice-versa (o contrato garante) | teste cruzado |
| 6.3 | Remover `desktop/` (Electron) e `server/` (Node) | repositório só com `web/`, `server-rs/`, `desktop-tauri/` |

### Etapa 7: Front (vale em A e em B)

Fases 7 e 8 do [plano de arquitetura](plano-arquitetura.md): componentes em arquivos próprios + reducer de tempo real + hooks. Podem rodar **em paralelo** às etapas 4 e 5, porque não mexem nos mesmos arquivos.

---

## 6. Ordem resumida

```
1.1 contrato ─┬─> 1.2 medir ─> 2.1 otimizar Electron ─> [DECISÃO 1]
1.3 desktop.ts┘                                           │
                                     bom o suficiente ────┤──> fases 2-8 de arquitetura em JS (fim)
                                     ainda pesado ────────┴──> 3 protótipo Tauri ─> [DECISÃO 2]
                                                                   │
                                     falhou ───────────────────────┤──> volta pro Electron (A)
                                     passou ───────────────────────┴──> 4 servidor Rust ─> 5 casco Tauri ─> 6 transição
                                                                         (7 front em paralelo)
```

---

## 7. Riscos principais

| Risco | Mitigação |
|---|---|
| WebView2 não deixa usar o seletor de tela próprio | etapa 3.2. Plano B: aceitar o seletor nativo do Windows/WebView2 (perde a prévia própria) ou captura nativa em Rust (`windows-capture`), que é bem mais trabalho |
| Som do próprio CGL vaza na transmissão | etapa 3.3. `restrictOwnAudio` depende da versão do Chromium do WebView2 |
| Ganho real pequeno (WebView2 também é Chromium) | a etapa 3.5 mede **antes** de investir semanas |
| Servidor Rust se comportar diferente do JS | o teste de contrato é a especificação, e o Node fica como referência até a etapa 6 |
| Usuários presos na versão Electron | etapa 6.1: versão ponte |
| Curva de Rust | servidor primeiro (lógica simples, bem coberta pelo contrato), casco depois |
| Duas bases de código ao mesmo tempo | só da etapa 4 até a 6, e com o contrato garantindo que as duas são iguais |

---

## 9. Nova feature: supressão de ruído (RNNoise)

### O que é
- **RNNoise:** rede neural pequena da Xiph/Mozilla (Jean-Marc Valin) que tira ruído de fundo da voz: ventilador, teclado, ar-condicionado. É **a mesma usada no filtro "Supressão de ruído → RNNoise" do OBS**.
- **Licença:** **BSD-3-Clause**. É gratuita e pode ir em app fechado ou aberto, desde que o aviso de licença acompanhe o app (vai numa tela "Licenças" ou num arquivo junto do app).
- **Versão pra web:** pacote `@sapphi-red/web-noise-suppressor` (**MIT**). Traz o RNNoise compilado pra WASM rodando num `AudioWorklet`, e também tem Speex e noise gate como alternativas mais leves.
  - Evitar `@jitsi/rnnoise-wasm`: o npm não informa licença.
- **Versão Rust (só se um dia for pra opção C):** crate `nnnoiseless`, uma versão do RNNoise em Rust.

### Funciona no CGL mais leve?
**Sim, nas três opções:**
- **A (Electron) e B (Tauri):** roda dentro da interface web (WASM + `AudioWorklet`), que existem igual no Chromium do Electron e no WebView2. Nada no casco muda. A etapa 3.11 só confirma.
- **C (nativo):** trocaria pelo `nnnoiseless`.

### Como encaixa no código atual
Hoje o microfone vai direto do `getUserMedia` para as conexões (`voice.ts:65-79`), usando a supressão simples do próprio Chromium (`noiseSuppression: true`). O novo caminho:

```
getUserMedia (eco e ganho automático ligados, supressão do Chromium DESLIGADA quando RNNoise ativo)
  → AudioContext 48 kHz (o RNNoise exige 48 kHz)
  → RnnoiseWorkletNode
  → MediaStreamDestination → faixa limpa
       ├─> enviada para os outros (replaceTrack, como já é feito na troca de microfone)
       └─> analisador do anel de "falando" (assim o ruído não acende o anel)
```

### Modos (escolha na tela de configurações de áudio)
| Modo | O que faz | Quando usar |
|---|---|---|
| Desligado | microfone cru | microfone bom, ambiente silencioso |
| Padrão (navegador) | `noiseSuppression` do Chromium (**como é hoje**) | padrão atual, mais leve |
| **RNNoise** | rede neural | ventilador, teclado, ambiente barulhento |

Padrão inicial: **Padrão (navegador)**, pra ninguém ter o comportamento mudado sem querer. Pode virar RNNoise depois de testado.

### Tarefas
| # | Tarefa | Pronto quando |
|---|---|---|
| 9.1 | Módulo `web/src/noise.ts`: `createNoiseProcessor(ctx, stream, mode)` → `{ track, setMode, close }`. Esconde o WASM, o worklet e o pipeline (módulo profundo, interface pequena) | funciona isolado numa página de teste |
| 9.2 | Plugar no `VoiceSession`: `openMic` passa pelo processador. Trocar de modo no meio da chamada via `replaceTrack`, sem renegociar | voz chega limpa, mutar/ensurdecer continua funcionando |
| 9.3 | Configuração na conta: nova chave `noise: 'off' \| 'browser' \| 'rnnoise'` em `PUT /api/me/settings`. **Muda o contrato:** adicionar ao teste de contrato e ao sanitize do servidor (e ao servidor Rust, se B) | contrato verde com a chave nova |
| 9.4 | Tela: seletor de modo em "Configurações de áudio" + o **teste de microfone** que já existe (`App.tsx:2190`) passa a usar o mesmo processador, pra pessoa ouvir e ver a diferença antes de entrar na chamada | ajuste salvo na conta e aplicado ao entrar na voz |
| 9.5 | Teste `scripts/noise-test.mjs`: app empacotado com microfone falso tocando um arquivo de voz + ruído (`--use-file-for-fake-audio-capture`). Mede no outro lado a energia nos trechos sem voz, com e sem RNNoise | ruído cai de forma mensurável, voz continua chegando |
| 9.6 | Medir custo: CPU (esperado ~1 a 2% de um núcleo) e latência extra (esperado ~10 ms, por causa dos blocos de 480 amostras) | números em `docs/medicoes.md` |
| 9.7 | Aviso de licença BSD-3 do RNNoise + MIT do pacote numa tela "Licenças" | aviso visível no app |

**Cuidado:** não aplicar o RNNoise no **som da transmissão de tela** (`voice.ts:181` já desliga o processamento lá), porque ele destruiria música e som de jogo. Só no microfone.

---

## 10. Fontes
- RNNoise: [repositório oficial (xiph)](https://gitlab.xiph.org/xiph/rnnoise/blob/master/COPYING), [espelho GitHub](https://GitHub.com/xiph/rnnoise)
- [@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor)
- [Jitsi: supressão de ruído com RNNoise](https://jitsi.org/?p=2335)

- Vídeo: [Discord is moving completely to Rust... (Let's Get Rusty)](https://www.youtube.com/watch?v=kz2Ngt2klgE). Demo oficial: [Rebuilding Discord in Rust: Project Phoenix](https://www.youtube.com/watch?v=y1PDr15raAA)
- [Windows Latest: Discord is killing its Electron app...](https://www.windowslatest.com/2026/11/05/discord-is-killing-its-electron-app-that-can-eat-4gb-of-ram-on-windows-11-and-the-rust-rebuild-uses-just-290mb/)
- [bool.dev: Discord Rebuilds Its Apps in Rust](https://bool.dev/news/detail/discord-rust)
- [WindowsForum: 290MB RAM claims need testing](https://windowsforum.com/news/discord-phoenix-rust-and-gpui-replace-electron-on-windows-but-290mb-ram-claims-need-testing.450993/)
- [Wccftech: Discord is ditching Electron for Rust](https://wccftech.com/discord-is-ditching-electron-for-rust-with-early-windows-build-using-just-290mb-of-ram/)
- [WebView2: evento ScreenCaptureStarting](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.screencapturestarting?view=webview2-dotnet-1.0.3405.78)
- [Chromium: Intent to Ship restrictOwnAudio](https://groups.google.com/a/chromium.org/g/blink-dev/c/5SZfg29iwPc)
- [socketioxide (docs.rs)](https://docs.rs/socketioxide)
- [Hopp: Tauri vs Electron, desempenho](https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4)
