# Medições do CGL

Script: `node scripts/bench.mjs` (app empacotado em `release/CGL-win32-x64`, gerado com `npm run pack`).

## O que cada número significa

- **Tela inicial:** do `spawn` do `CGL.exe` até a tela "Hospedar / Entrar" pronta.
- **Sala pronta:** do clique em "Hospedar" até a interface da sala aparecer, já logado. Inclui subir o servidor embutido.
- **Memória privada:** soma de `PrivatePageCount` de todos os processos do app (principal + renderizadores + GPU + utilitários). É o número mais próximo do que o Gerenciador de Tarefas mostra.
- **Working set:** soma do conjunto de trabalho dos processos. **Superestima**, porque as DLLs compartilhadas entre os processos do Chromium entram várias vezes na soma.
- Mediana de 3 amostras por cenário e de 5 aberturas.

**Limites da medição:**
- As aberturas são "mornas": os arquivos já estão no cache do Windows. A primeira abertura depois de ligar o PC é mais lenta.
- A porta de depuração (`--remote-debugging-port`), o microfone e a câmera falsos do Chromium pesam um pouco.

## Base: Electron 45.3.1, CGL 0.5.2 — 14/11/2026

PC: Windows 11 Home (26200).

### Abertura (mediana de 5)

| Etapa | Tempo |
|---|---|
| Tela inicial | **233 ms** (219 a 249) |
| Sala pronta (logado) | **250 ms** (243 a 276) |

### Memória

| Cenário | Processos | Privada | Working set |
|---|---|---|---|
| Tela inicial parada | 4 | **187 MB** | 456 MB |
| Sala aberta (texto) | 6 | **323 MB** | 560 MB |
| Em chamada de voz, anfitrião | 6 | **331 MB** | 598 MB |
| Em chamada de voz, convidado | 6 | **326 MB** | 753 MB |
| Transmitindo a tela, anfitrião | 6 | **360 MB** | 650 MB |
| Assistindo a tela, convidado | 6 | **353 MB** | 785 MB |

### Tamanho

| Item | Tamanho |
|---|---|
| Pasta do app (`release/CGL-win32-x64`) | **413 MB** |

## Leitura (entra na DECISÃO 1 do plano mestre)

1. **A abertura já é rápida.** Meio segundo do clique até a sala pronta. O "5,5 s → 33 ms" do Discord não se aplica: o Discord demora porque carrega um app gigante, e o CGL é pequeno.
2. **Memória: ~330 MB em uso real.** É a mesma faixa dos 290 MB do Discord Phoenix. O problema do Discord eram 1 a 4 GB, e o CGL não tem esse problema.
3. **O ganho claro de sair do Electron é o tamanho:** 413 MB de pasta contra ~10 a 20 MB num casco Tauri (o WebView2 já vem no Windows). Isso afeta download, atualização e espaço em disco, mas não a velocidade de uso.
4. **Onde a memória vai:** cerca de 190 MB só pra tela inicial (Chromium + Node + o processo principal), e de +130 a 170 MB com a sala. Num casco Tauri o WebView2 continua sendo Chromium. O ganho provável seria tirar o Node do processo principal e um processo a menos: **estimativa de 80 a 150 MB a menos**, a confirmar no protótipo (etapa 3.5) com este mesmo script.

## Supressão de ruído (RNNoise) — 14/11/2026

Script: `node scripts/noise-test.mjs`.
- **Microfone falso:** fala real (voz do Windows) + chiado, ruído grave e zumbido de 120 Hz o tempo todo, em loop de 20 s.
- **O que é medido:** o áudio que o convidado **envia** para a chamada (a faixa já filtrada), em 40 s por modo.
- **Piso:** percentil 20, os trechos só com ruído.
- **Fala:** percentil 90.

| Modo | Piso | Fala | Fala acima do piso | CPU do convidado (% de 1 núcleo) |
|---|---|---|---|---|
| Desligada | -31,6 dB | -22,7 dB | 8,9 dB | 15,7 |
| Padrão (navegador) | -32,0 dB | -23,8 dB | 8,2 dB | 16,0 |
| **Forte (RNNoise)** | **-85,0 dB** | -30,1 dB | **54,9 dB** | 17,1 |

**Leitura:**
- **O RNNoise derruba o ruído em ~53 dB**, que na prática vira silêncio, e a fala continua passando.
- **Custo:** ~1 ponto de CPU de um núcleo.
- **O filtro padrão do navegador quase não age** sobre esse tipo de ruído contínuo.
- **A fala fica ~7 dB mais baixa que no modo desligado.** Parte disso é o ruído que somava energia à fala, parte é o RNNoise atenuando um pouco a voz sintética. O ganho automático do navegador continua ligado.
- **Latência extra:** não medida. Pelo tamanho do bloco do RNNoise (480 amostras a 48 kHz), espera-se ~10 ms.
