# Plano de arquitetura do CGL — separação de responsabilidades

> **Ordem de execução:** veja o [plano mestre](plano-cgl-leve.md). As fases 2 a 6 (servidor JS) só começam depois da decisão sobre sair do Electron. Se o servidor for pra Rust, este documento vira a planta da estrutura Rust.

Objetivo: dividir o servidor (e depois o front) em domínios com responsabilidades claras, **sem mudar nenhum comportamento visível**, em passos pequenos, cada um verificável e reversível.

---

## 1. Diagnóstico

### Servidor (`server/src`, ~860 linhas)

| Arquivo | Linhas | O que faz hoje |
|---|---|---|
| `index.js` | 428 | config, segredo JWT, Fastify, arquivos estáticos, auth, validação, regras de negócio, 13 rotas HTTP, socket.io, presença, estado da voz, 11 eventos de socket |
| `db.js` | 217 | abre o banco **no import**, schema, migração, consultas de todos os domínios, formatação de saída (`publicUser`, `shapeMessage`) |
| `unfurl.js` | 211 | prévia de links. **Já está bom**: um export (`unfurl`), segurança interna (SSRF, timeout, cache), teste próprio. Não mexer. |

Problemas concretos:

1. **Sem camada de regra de negócio.** As regras ficam dentro de rotas e handlers. A permissão de dono aparece em dois lugares (`index.js:221` e `index.js:345`), e a regra "canal de voz não recebe mensagem" está no handler do socket.
2. **O transporte conhece o tempo real.** `PATCH /api/me` percorre os sockets abertos e altera `s.data.user` (`index.js:169`). As rotas de convite, canais e DMs emitem eventos direto pelo `io`.
3. **Dependência de ordem escondida.** Rotas declaradas na linha 70 usam `io` e `online`, que só existem a partir da linha 269. Funciona porque os handlers rodam depois, mas ninguém lê o arquivo e percebe isso.
4. **Validação misturada com rota.** O sanitize de settings (`index.js:108-148`, 40 linhas) é lógica pura escondida dentro de um handler.
5. **Estado em memória espalhado.** `online`, `voice` e `unfurlHits` são `Map`s soltos no módulo.
6. **O banco abre no import.** `db.js` lê `TAVERNA_DATA` e abre o arquivo assim que é importado. Isso impede subir dois servidores ou usar banco em memória nos testes.
7. **Dados duplicados entre front e servidor.** As cores de perfil (`COLORS` × `SWATCHES`) e os presets de tema (`index.js:126` × `themes.ts`).

### Front (`web/src`, ~3100 linhas)

| Arquivo | Linhas | Situação |
|---|---|---|
| `App.tsx` | 2317 | 35 componentes num arquivo só. `Main` sozinho tem **746 linhas**, com 25+ `useState`, 15+ `useEffect`, 13 handlers de socket, settings, hotkeys, túnel e atualização |
| `voice.ts` | 415 | `VoiceSession`: bom módulo profundo (WebRTC atrás de uma classe) |
| `audio.ts`, `sounds.ts`, `themes.ts`, `api.ts` | pequenos | ok |

### Testes hoje

- **Todos** os `scripts/*-test.mjs` rodam no app **empacotado** (Electron). São lentos, dependem do build e testam a tela.
- `smoke.mjs` precisa de um código de convite manual.
- **Não existe teste do contrato do servidor** (rotas + eventos). Essa é a primeira coisa a resolver: sem ela, refatorar é no escuro.

---

## 2. Restrições — o que o refactor NÃO pode quebrar

1. **Empacotamento do desktop.** `scripts/build-desktop.mjs` empacota `server/src/index.js` com esbuild (`bundle: true`) num `server.mjs`. Dividir em vários arquivos não atrapalha, mas:
   - `index.js` **continua sendo o ponto de entrada**, e importá-lo **sobe o servidor** (efeito colateral).
   - `desktop/main.cjs:138-142` define `TAVERNA_DATA`, `TAVERNA_WEB` e `PORT` **antes** do `await import(server.mjs)`. Por isso a config pode continuar lendo o env no import.
   - O `await import` só pode terminar **depois** do `listen`, porque o `main.cjs:308` captura `EADDRINUSE` assim. Manter o `await app.listen` no top-level.
   - Nada de import dinâmico com caminho calculado, que o esbuild não segue.
2. **Contrato com o front, byte a byte.** Formato de JSON, códigos HTTP, **textos de erro em português** (o front mostra `data.error` na tela), nomes e payloads dos eventos.
   - HTTP: `POST /api/register`, `POST /api/login`, `GET /api/me`, `PATCH /api/me`, `PUT /api/me/settings`, `GET /api/unfurl`, `GET /api/users/:id`, `POST /api/guilds`, `POST /api/invites/:code/join`, `POST /api/guilds/:id/channels`, `GET /api/guilds/:id/members`, `GET /api/channels/:id/messages`, `POST /api/dms`, `POST /api/upload`, mais `/uploads/*` e o fallback SPA.
   - Socket, cliente→servidor: `message:send`(ack), `message:edit`, `message:delete`, `reaction:toggle`, `typing`, `voice:join`(ack), `voice:leave`, `voice:watch`, `voice:signal`, `voice:state`, `voice:speaking`.
   - Socket, servidor→cliente: `ready`, `presence`, `message:new|update|delete`, `reaction:update`, `typing`, `channel:new`, `member:join`, `dm:new`, `user:update`, `voice:occupancy`, `voice:speaking`, `voice:peer-joined|peer-left`, `voice:signal`, `voice:state`, `voice:watch`.
3. **Dados existentes.** Mesmo schema, mesma migração `ALTER TABLE`, mesmo `secret.key` (os tokens atuais continuam válidos).
4. **Cabeçalhos de segurança** dos uploads (`nosniff`, `attachment` para `.bin`) e o limite de prévias (60/min por pessoa).

---

## 3. Princípios (o que guia as decisões)

- **Separação de responsabilidades em 3 camadas:**
  - **transporte** (rota HTTP, handler de socket): lê a entrada, chama o serviço e devolve resposta ou `ack`
  - **serviço** (domínio): regras e permissões
  - **repositório**: SQL
- **Regra de dependência:** `transporte → serviço → repositório`. O serviço **não** importa Fastify nem socket.io. O repositório não conhece regra.
- **Módulos profundos:** interface pequena, bastante comportamento atrás dela. Exemplos: o serviço de mensagens expõe `send/edit/remove/react/list`, não 15 helpers.
- **Uma seam só onde algo varia de verdade.** Seam com um único adaptador é indireção à toa. Na prática:
  - **Notificação em tempo real**: é uma seam real, com dois adaptadores. Em produção, o socket.io; nos testes, um fake que grava os eventos. O serviço recebe `notify` por injeção.
  - **Banco**: **sem** interface de repositório. Os testes usam o próprio `node:sqlite` com `:memory:` (substituto local).
  - **Nada de** classes abstratas, containers de DI ou pastas `interfaces/`.
- **Erros de domínio:** o serviço lança `DomainError(status, mensagem)`. A rota traduz para `reply.code(status).send({error})` e o socket para `ack({error})`. A mensagem continua sendo exatamente o texto atual.

---

## 4. Arquitetura alvo — servidor

```
server/src/
  index.js              # entrada: lê config, createServer(), await listen()  (~20 linhas)
  config.js             # PORT, HOST, DATA_DIR, WEB_DIR, limites (MAX_UPLOAD, MAX_MESSAGE)
  app.js                # createServer({ dataDir, webDir }): monta Fastify + io + domínios
  errors.js             # DomainError
  db/
    connection.js       # openDb(dataDir | ':memory:') + schema + migrações
    users.js  guilds.js  channels.js  messages.js     # repositórios: só SQL, recebem db
    shape.js            # publicUser, shapeMessage (formato de saída)
  auth/
    tokens.js           # segredo, sign, verify → user
    http.js             # preHandler do Fastify
  realtime/
    gateway.js          # io, salas, presença (online), emitToChannel, joinGuildRooms,
                        # syncUser — implementa a interface `notify` usada pelos serviços
  accounts/
    service.js          # register, login, me, updateProfile, saveSettings
    settings.js         # sanitizeSettings(body) → função pura
    routes.js
  guilds/
    service.js          # create, joinByInvite, createChannel, members
    access.js           # canAccessChannel, isGuildOwner  ← permissões num lugar só
    routes.js
  messaging/
    service.js          # list, send, edit, remove, react, typing, openDm
    routes.js           # GET mensagens, POST /dms
    socket.js           # message:*, reaction:toggle, typing
  voice/
    rooms.js            # estado das salas em memória: join/leave/patch/list (puro)
    socket.js           # voice:* — só sinalização e repasse
  uploads/
    routes.js           # POST /api/upload + estático /uploads
  unfurl/
    unfurl.js           # (arquivo atual, movido sem alteração)
    routes.js           # GET /api/unfurl + limite por pessoa
```

**Quem importa quem:**

```
index.js → app.js → { */routes.js, */socket.js, realtime/gateway.js, db/connection.js }
*/routes.js, */socket.js → */service.js
*/service.js → db/*.js, guilds/access.js, errors.js   (+ notify injetado)
realtime/gateway.js → db (salas por guild/DM)
```

Nenhum serviço importa `realtime/`, `fastify` ou `socket.io`.

**Exemplo do formato final** (mensagens):

```js
// messaging/service.js
export function createMessaging({ db, notify }) {
  return {
    send(user, { channelId, content, attachment }) {
      const ch = access.channelFor(db, user.id, channelId);
      if (!ch || ch.type === 'voice') throw new DomainError(400, 'Canal inválido');
      ...
      const msg = messages.create(db, ch.id, user.id, text, att);
      notify.channel(ch, 'message:new', msg);
      return msg;
    },
    ...
  };
}

// messaging/socket.js
socket.on('message:send', (p = {}, ack) => respond(ack, () => messaging.send(me, p)));
```

---

## 5. Arquitetura alvo — front (fase posterior)

```
web/src/
  App.tsx               # só Auth × Main
  api.ts  voice.ts  audio.ts  sounds.ts  themes.ts      # ficam como estão
  state/
    realtime.ts         # reducer puro: (estado, evento do socket) → estado  ← testável
    useRealtime.ts      # conecta o socket e despacha os eventos para o reducer
    useSettings.ts      # settings + salvar com debounce
    useHotkeys.ts
  components/
    Main.tsx  Sidebar.tsx  Chat.tsx  Stage.tsx  Tile.tsx  ...
    profile/  ProfileEditor.tsx  Cropper.tsx  ProfileCard.tsx
    media/    ImageViewer.tsx  LinkPreview.tsx  Linkified.tsx  AttachmentView.tsx
    settings/ AudioSettingsModal.tsx  VolumeMenu.tsx  HotkeyField.tsx  ThemePicker.tsx  SoundSettings.tsx
    ui/       Icon.tsx  Avatar.tsx  Section.tsx  AskModal.tsx
```

O ganho principal é tirar de `Main` os 13 handlers de socket e transformá-los num **reducer puro**. Assim dá pra testar "chegou `message:delete` → some da lista" sem abrir o app.

---

## 6. Rede de segurança (antes de mexer em qualquer coisa)

**Teste de contrato do servidor**, em `server/test/contract.test.js`, com `node:test` (embutido no Node, sem dependência nova) e `socket.io-client` (já instalado):

- sobe `node server/src/index.js` como processo filho, com `TAVERNA_DATA` numa pasta temporária e uma `PORT` livre
- percorre **todas** as rotas e eventos da seção 2, incluindo os casos de erro (nome repetido, senha curta, canal alheio, não-dono criando canal, mensagem vazia, apagar mensagem dos outros, upload `.exe` → `.bin`, limite de prévias)
- compara os formatos (chaves, tipos) e os textos de erro
- usa 2 ou 3 usuários simulados para conferir quem recebe cada evento: sala da guild, DM, `voice:*`

O teste é escrito contra o código **atual** e precisa passar antes e depois de cada fase. Comando: `npm test -w server`.

Validações extras ao fim das fases do servidor: `npm run build:desktop`, depois `node scripts/app-test.mjs` (app empacotado: hospedar e entrar).

---

## 7. Fases

Cada fase vira **um commit**, não muda comportamento e só segue com o teste de contrato verde.

| # | Fase | Feito quando |
|---|---|---|
| 0 | **Teste de contrato** (seção 6) contra o código atual | `npm test -w server` verde no código sem alteração |
| 1 | **Fundação:** `config.js`, `errors.js`, `db/connection.js` com `openDb(dir)` (o banco deixa de abrir no import), `auth/`, `app.js` com `createServer()`. `index.js` vira entrada fina | contrato verde, `build:desktop` + `app-test` ok |
| 2 | **Tempo real:** `realtime/gateway.js` concentra `io`, `online`, salas, `emitToChannel`, `joinGuildRooms` e a sincronização do perfil nos sockets | nenhuma rota usa `io` direto |
| 3 | **Voz:** `voice/rooms.js` (estado puro) e `voice/socket.js` | testes unitários de `rooms.js` (entrar, sair, trocar de sala, sala vazia some) |
| 4 | **Serviços por domínio:** `accounts`, `guilds` (+ `access.js`), `messaging`, com `DomainError` e `notify` injetado. `settings.js` vira função pura | testes de serviço com `:memory:` + `notify` fake. Permissões em um lugar só |
| 5 | **Transporte fino:** rotas e handlers só chamam o serviço. `uploads/` e `unfurl/` em pastas próprias | `index.js` ≈ 20 linhas, `app.js` só monta. Contrato verde, `build:desktop` + `app-test` ok |
| 6 | **Repositórios:** `db.js` dividido em `db/*.js` + `shape.js` | `db.js` some |
| 7 | **Front, parte 1:** mover os componentes folha de `App.tsx` para `components/` (mecânico, sem mudar lógica) | `npm run build` ok + testes do app empacotado (`profile`, `viewer`, `links-theme`) |
| 8 | **Front, parte 2:** reducer `state/realtime.ts` + hooks `useRealtime`, `useSettings`, `useHotkeys`. `Main` fica só com a montagem da tela | testes do reducer + testes do app empacotado (`audio`, `hotkeys`, `speaking`) |

Ordem: 0 → 1 → 2 → 3 → 4 → 5 → 6 no servidor, depois 7 → 8 no front. As fases 3 e 6 são independentes de 4 e 5 e podem trocar de lugar.

Estimativa: de 0 a 6, cerca de 1.200 linhas tocadas no servidor (a maior parte movida, pouca reescrita). As fases 7 e 8 movem as ~2.300 linhas do `App.tsx`.

---

## 8. Riscos e como tratar

| Risco | Tratamento |
|---|---|
| Mudar sem querer um texto de erro ou formato de JSON | o teste de contrato compara textos e chaves |
| O esbuild deixar de achar um módulo | só imports estáticos relativos. Rodar `build:desktop` nas fases 1 e 5 |
| `main.cjs` depender do `listen` no top-level | manter `await app.listen(...)` em `index.js` (seção 2.1) |
| Sockets com cópia antiga do usuário depois de editar o perfil | o gateway expõe `syncUser(user)`, coberto pelo teste de contrato (`user:update` + mensagem nova sai com o nome novo) |
| Refactor grande demais num commit só | uma fase por commit. Se o contrato quebrar, reverter só aquela fase |

---

## 9. Decisões em aberto (não bloqueiam as fases 0–6)

1. **TypeScript no servidor?** Não agora. Dá pra migrar depois que os módulos estiverem separados, aí fica fácil.
2. **Tipos compartilhados front/servidor** (hoje o front redeclara `User`, `Message` etc. em `api.ts`): avaliar depois da fase 6, num pacote `shared/`.
3. **Duplicações** (cores de perfil, presets de tema): mover para `shared/` junto com o item 2.
4. **Rodar o teste de contrato em CI** (GitHub Actions no push): sugerido depois da fase 0.
