import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { api, getToken, nameOf, setToken, upload } from './api'
import type { Attachment, Channel, Dm, Guild, Message, Reaction, User, VoicePeer } from './api'
import { VoiceSession } from './voice'
import type { VoiceSnapshot } from './voice'

type DesktopInfo = { hosting: boolean; label: string; addresses: string[]; tunnel: string | null }
const desktop = (window as unknown as {
  taverna?: {
    info: () => Promise<DesktopInfo | null>
    leave: () => Promise<void>
    tunnelStart: () => Promise<{ url?: string; error?: string }>
    tunnelStop: () => Promise<void>
    onTunnelClosed: (fn: () => void) => void
  }
}).taverna

const ICONS = {
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  fone: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" /></>,
  camera: <><rect x="3" y="7" width="12" height="10" rx="2" /><path d="M15 11l6-3v8l-6-3" /></>,
  tela: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  cheia: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  reduzir: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  sair: <path d="M3 14c5-5.3 13-5.3 18 0l-2.4 2.6-3.6-2v-2.4c-2-.7-4-.7-6 0v2.4l-3.6 2z" fill="currentColor" stroke="none" />,
}

/** Ícone de traço simples; `off` risca o ícone (mutado, sem ouvir, câmera desligada). */
function Icon({ name, off, size = 20 }: { name: keyof typeof ICONS; off?: boolean; size?: number }) {
  return (
    <svg className={`ico ${off ? 'off' : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
      {off && <path className="slash" d="M4 4l16 16" />}
    </svg>
  )
}

const EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '😢']
type Sel = { kind: 'guild'; guildId: number; channelId: number | null } | { kind: 'dm'; channelId: number | null }
type Field = { key: string; label: string; placeholder?: string }
type Ask = { title: string; fields: Field[]; action: string; run: (v: Record<string, string>) => Promise<void> }

export default function App() {
  const [token, setTok] = useState(getToken())
  const login = (t: string) => {
    setToken(t)
    setTok(t)
  }
  const logout = () => {
    setToken(null)
    setTok(null)
  }
  return token ? <Main key={token} token={token} onLogout={logout} /> : <Auth onLogin={login} />
}

function Auth({ onLogin }: { onLogin: (t: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const r = await api<{ token: string }>(`/${mode}`, { username, password })
      onLogin(r.token)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="brand">Taverna</h1>
        <p className="muted">{mode === 'login' ? 'Entre na sua conta' : 'Crie sua conta'}</p>
        <label>
          Nome de usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">
          {mode === 'login' ? 'Entrar' : 'Criar conta'}
        </button>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Não tem conta? Criar uma' : 'Já tem conta? Entrar'}
        </button>
      </form>
    </div>
  )
}

function Main({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [me, setMe] = useState<User | null>(null)
  const [guilds, setGuilds] = useState<Guild[]>([])
  const [dms, setDms] = useState<Dm[]>([])
  const [sel, setSel] = useState<Sel>({ kind: 'dm', channelId: null })
  const [messages, setMessages] = useState<Record<number, Message[]>>({})
  const [online, setOnline] = useState<Set<number>>(new Set())
  const [occupancy, setOccupancy] = useState<Record<number, VoicePeer[]>>({})
  const [members, setMembers] = useState<Record<number, User[]>>({})
  const [typing, setTyping] = useState<Record<number, { name: string; at: number }>>({})
  const [unread, setUnread] = useState<Set<number>>(new Set())
  const [voice, setVoice] = useState<VoiceSnapshot | null>(null)
  const [talking, setTalking] = useState<Set<string>>(new Set())
  const [editProfile, setEditProfile] = useState(false)
  const [card, setCard] = useState<User | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [notice, setNotice] = useState('')
  const [socket, setSocket] = useState<Socket | null>(null)
  const session = useRef<VoiceSession | null>(null)
  const [desk, setDesk] = useState<DesktopInfo | null>(null)
  const [tunnelBusy, setTunnelBusy] = useState(false)
  useEffect(() => {
    void desktop?.info().then(setDesk)
    desktop?.onTunnelClosed(() => setDesk((d) => d && { ...d, tunnel: null }))
  }, [])
  const copyLink = (url: string) => {
    void navigator.clipboard.writeText(url)
    setNotice(`Link copiado: ${url}`)
    setTimeout(() => setNotice(''), 6000)
  }
  const openTunnel = async () => {
    if (!desktop) return
    setTunnelBusy(true)
    const r = await desktop.tunnelStart()
    setTunnelBusy(false)
    if (r.url) {
      setDesk((d) => d && { ...d, tunnel: r.url! })
      copyLink(r.url)
    } else {
      setNotice(r.error ?? 'O túnel não abriu')
      setTimeout(() => setNotice(''), 6000)
    }
  }
  const closeTunnel = () => {
    void desktop?.tunnelStop()
    setDesk((d) => d && { ...d, tunnel: null })
  }
  const activeChannel = useRef<number | null>(null)
  const meRef = useRef<User | null>(null)

  const guild = sel.kind === 'guild' ? guilds.find((g) => g.id === sel.guildId) ?? null : null
  const channel: Channel | null = guild?.channels.find((c) => c.id === sel.channelId) ?? null
  const dm = sel.kind === 'dm' ? dms.find((x) => x.id === sel.channelId) ?? null : null
  const textChannelId = channel?.type === 'text' ? channel.id : dm ? dm.id : null
  activeChannel.current = textChannelId

  const flash = useCallback((text: string) => {
    setNotice(text)
    setTimeout(() => setNotice(''), 4000)
  }, [])

  // carga inicial + socket
  useEffect(() => {
    let alive = true
    api<{ user: User; guilds: Guild[]; dms: Dm[] }>('/me')
      .then((r) => {
        if (!alive) return
        setMe(r.user)
        meRef.current = r.user
        setGuilds(r.guilds)
        setDms(r.dms)
        if (r.guilds[0]) setSel({ kind: 'guild', guildId: r.guilds[0].id, channelId: r.guilds[0].channels[0]?.id ?? null })
      })
      .catch(onLogout)

    const s = io({ auth: { token } })
    setSocket(s)
    const patch = (channelId: number, fn: (list: Message[]) => Message[]) =>
      setMessages((m) => (m[channelId] ? { ...m, [channelId]: fn(m[channelId]) } : m))

    s.on('connect_error', (e) => e.message === 'unauthorized' && onLogout())
    s.on('ready', (r: { online: number[]; occupancy: Record<number, VoicePeer[]> }) => {
      setOnline(new Set(r.online))
      setOccupancy(r.occupancy)
    })
    s.on('presence', ({ userId, online: on }: { userId: number; online: boolean }) =>
      setOnline((prev) => {
        const next = new Set(prev)
        if (on) next.add(userId)
        else next.delete(userId)
        return next
      }),
    )
    s.on('message:new', (msg: Message) => {
      patch(msg.channelId, (list) => [...list, msg])
      setTyping((t) => {
        const { [msg.channelId]: _gone, ...rest } = t
        return rest
      })
      if (activeChannel.current !== msg.channelId && msg.author.id !== meRef.current?.id) {
        setUnread((u) => new Set(u).add(msg.channelId))
      }
    })
    s.on('message:update', (msg: Message) => patch(msg.channelId, (list) => list.map((x) => (x.id === msg.id ? msg : x))))
    s.on('message:delete', ({ id, channelId }: { id: number; channelId: number }) =>
      patch(channelId, (list) => list.filter((x) => x.id !== id)),
    )
    s.on('reaction:update', (r: { messageId: number; channelId: number; reactions: Reaction[] }) =>
      patch(r.channelId, (list) => list.map((x) => (x.id === r.messageId ? { ...x, reactions: r.reactions } : x))),
    )
    s.on('typing', ({ channelId, user }: { channelId: number; user: User }) => {
      if (user.id === meRef.current?.id) return
      setTyping((t) => ({ ...t, [channelId]: { name: nameOf(user), at: Date.now() } }))
    })
    s.on('channel:new', ({ guildId, channel: ch }: { guildId: number; channel: Channel }) =>
      setGuilds((gs) =>
        gs.map((g) => (g.id === guildId && !g.channels.some((c) => c.id === ch.id) ? { ...g, channels: [...g.channels, ch] } : g)),
      ),
    )
    s.on('member:join', ({ guildId, user }: { guildId: number; user: User }) =>
      setMembers((m) => (m[guildId] && !m[guildId].some((u) => u.id === user.id) ? { ...m, [guildId]: [...m[guildId], user] } : m)),
    )
    s.on('dm:new', (d: Dm) => setDms((list) => (list.some((x) => x.id === d.id) ? list : [d, ...list])))
    s.on('voice:occupancy', ({ channelId, peers }: { channelId: number; peers: VoicePeer[] }) =>
      setOccupancy((o) => ({ ...o, [channelId]: peers })),
    )
    s.on('user:update', (u: User) => {
      const fix = <T extends User>(x: T): T => (x.id === u.id ? { ...x, ...u } : x)
      setMe((m) => {
        const next = m && fix(m)
        meRef.current = next
        return next
      })
      setCard((c) => c && fix(c))
      setDms((list) => list.map((d) => ({ ...d, user: fix(d.user) })))
      setMembers((all) => Object.fromEntries(Object.entries(all).map(([k, list]) => [k, list.map(fix)])))
      setMessages((all) => Object.fromEntries(Object.entries(all).map(([k, list]) => [k, list.map((m) => ({ ...m, author: fix(m.author) }))])))
      setOccupancy((all) => Object.fromEntries(Object.entries(all).map(([k, list]) => [k, list.map((p) => ({ ...p, user: fix(p.user) }))])))
    })
    s.on('voice:speaking', ({ socketId, speaking }: { socketId: string; speaking: boolean }) =>
      setTalking((prev) => {
        if (prev.has(socketId) === speaking) return prev
        const next = new Set(prev)
        if (speaking) next.add(socketId)
        else next.delete(socketId)
        return next
      }),
    )
    return () => {
      alive = false
      session.current?.leave()
      session.current = null
      s.close()
    }
  }, [token, onLogout])

  // "digitando" some depois de 3 s
  useEffect(() => {
    const t = setInterval(() => {
      setTyping((cur) => {
        const now = Date.now()
        const keep = Object.entries(cur).filter(([, v]) => now - v.at < 3000)
        return keep.length === Object.keys(cur).length ? cur : Object.fromEntries(keep)
      })
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // histórico do canal aberto
  useEffect(() => {
    if (textChannelId == null) return
    setUnread((u) => {
      if (!u.has(textChannelId)) return u
      const next = new Set(u)
      next.delete(textChannelId)
      return next
    })
    if (messages[textChannelId]) return
    api<Message[]>(`/channels/${textChannelId}/messages`)
      .then((list) => setMessages((m) => ({ ...m, [textChannelId]: list })))
      .catch((e) => flash(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textChannelId])

  // membros do servidor aberto
  const guildId = guild?.id
  useEffect(() => {
    if (guildId == null) return
    api<User[]>(`/guilds/${guildId}/members`)
      .then((list) => setMembers((m) => ({ ...m, [guildId]: list })))
      .catch(() => {})
  }, [guildId])

  const leaveVoice = useCallback(() => {
    session.current?.leave()
    session.current = null
    setVoice(null)
  }, [])

  const joinVoice = useCallback(
    async (channelId: number) => {
      if (!socket) return
      if (session.current?.channelId === channelId) return
      leaveVoice()
      const s = new VoiceSession(socket, channelId, setVoice)
      session.current = s
      try {
        await s.join()
      } catch (e) {
        if (session.current === s) leaveVoice()
        flash((e as Error).message)
      }
    },
    [socket, leaveVoice, flash],
  )

  const media = (fn: (s: VoiceSession) => void | Promise<void>) => async () => {
    if (!session.current) return
    try {
      await fn(session.current)
    } catch (e) {
      const name = (e as Error).name
      if (name !== 'NotAllowedError' && name !== 'AbortError') flash('Não consegui acessar o dispositivo')
    }
  }

  const loadOlder = async (channelId: number) => {
    const first = messages[channelId]?.[0]
    if (!first) return
    const older = await api<Message[]>(`/channels/${channelId}/messages?before=${first.id}`)
    setMessages((m) => ({ ...m, [channelId]: [...older, ...(m[channelId] ?? [])] }))
    return older.length
  }

  const addGuild = (g: Guild) => {
    setGuilds((gs) => (gs.some((x) => x.id === g.id) ? gs : [...gs, g]))
    setSel({ kind: 'guild', guildId: g.id, channelId: g.channels[0]?.id ?? null })
  }
  const askNewGuild = () =>
    setAsk({
      title: 'Novo servidor',
      action: 'Criar',
      fields: [{ key: 'name', label: 'Nome do servidor', placeholder: 'Minha mesa' }],
      run: async (v) => addGuild(await api<Guild>('/guilds', { name: v.name })),
    })
  const askJoin = () =>
    setAsk({
      title: 'Entrar com convite',
      action: 'Entrar',
      fields: [{ key: 'code', label: 'Código do convite' }],
      run: async (v) => addGuild(await api<Guild>(`/invites/${encodeURIComponent(v.code.trim())}/join`, {})),
    })
  const askNewChannel = (type: 'text' | 'voice') =>
    guild &&
    setAsk({
      title: type === 'text' ? 'Novo canal de texto' : 'Nova sala de voz',
      action: 'Criar',
      fields: [{ key: 'name', label: 'Nome' }],
      run: async (v) => {
        await api(`/guilds/${guild.id}/channels`, { name: v.name, type })
      },
    })
  const openDm = async (username: string) => {
    const d = await api<Dm>('/dms', { username })
    setDms((list) => (list.some((x) => x.id === d.id) ? list : [d, ...list]))
    setSel({ kind: 'dm', channelId: d.id })
  }
  const askNewDm = () =>
    setAsk({
      title: 'Nova conversa',
      action: 'Abrir',
      fields: [{ key: 'username', label: 'Nome de usuário' }],
      run: (v) => openDm(v.username),
    })

  const voiceChannelName = useMemo(() => {
    if (!voice) return ''
    for (const g of guilds) {
      const c = g.channels.find((x) => x.id === voice.channelId)
      if (c) return `${c.name} · ${g.name}`
    }
    const d = dms.find((x) => x.id === voice.channelId)
    return d ? `Chamada com ${nameOf(d.user)}` : ''
  }, [voice, guilds, dms])

  if (!me) return <div className="auth muted">Carregando…</div>

  const typingNow = textChannelId != null ? typing[textChannelId] : undefined
  const showStage = voice && ((channel?.type === 'voice' && voice.channelId === channel.id) || (dm && voice.channelId === dm.id))
  const dmUnread = dms.some((d) => unread.has(d.id))

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Taverna</span>
        <nav className="tabs">
          <button className={`tab ${sel.kind === 'dm' ? 'on' : ''}`} onClick={() => setSel({ kind: 'dm', channelId: dms[0]?.id ?? null })}>
            Conversas{dmUnread && <i className="dot" />}
          </button>
          {guilds.map((g) => (
            <button
              key={g.id}
              className={`tab ${sel.kind === 'guild' && sel.guildId === g.id ? 'on' : ''}`}
              onClick={() => setSel({ kind: 'guild', guildId: g.id, channelId: g.channels[0]?.id ?? null })}
            >
              {g.name}
              {g.channels.some((c) => unread.has(c.id)) && <i className="dot" />}
            </button>
          ))}
          <button className="tab add" title="Novo servidor" onClick={askNewGuild}>
            + Criar
          </button>
          <button className="tab add" title="Entrar com convite" onClick={askJoin}>
            Convite
          </button>
        </nav>
        <span className="who">
          <button className="me-chip" title="Editar perfil" onClick={() => setEditProfile(true)}>
            <Avatar user={me} small online />
            {nameOf(me)}
          </button>
          {desk?.hosting && (
            <button
              className="chip"
              title="Endereço para os outros entrarem (clique para copiar)"
              onClick={() => {
                void navigator.clipboard.writeText(desk.addresses[0] ?? '')
                flash(desk.addresses.length ? `Endereço copiado: ${desk.addresses.join(' ou ')}` : 'Nenhuma rede encontrada')
              }}
            >
              Meu endereço
            </button>
          )}
          {desk?.hosting &&
            (desk.tunnel ? (
              <>
                <button className="chip on" title={`${desk.tunnel} (clique para copiar)`} onClick={() => copyLink(desk.tunnel!)}>
                  Link da internet
                </button>
                <button className="link" title="Fechar o link da internet" onClick={closeTunnel}>
                  fechar
                </button>
              </>
            ) : (
              <button
                className="chip"
                disabled={tunnelBusy}
                title="Cria um link público para amigos de fora da sua rede entrarem"
                onClick={() => void openTunnel()}
              >
                {tunnelBusy ? 'Abrindo…' : 'Abrir pra internet'}
              </button>
            ))}
          {desk && (
            <button className="link" title={desk.hosting ? 'Voltar à tela inicial' : `Conectado a ${desk.label}`} onClick={() => void desktop?.leave()}>
              Trocar mesa
            </button>
          )}
          <button className="link" onClick={onLogout}>
            Sair
          </button>
        </span>
      </header>

      <aside className="side">
        {guild ? (
          <>
            <div className="side-head">
              <strong>{guild.name}</strong>
              <button
                className="chip"
                title="Copiar código de convite"
                onClick={() => {
                  void navigator.clipboard.writeText(guild.inviteCode)
                  flash(`Convite copiado: ${guild.inviteCode}`)
                }}
              >
                Convidar
              </button>
            </div>
            <Section title="Texto" onAdd={guild.ownerId === me.id ? () => askNewChannel('text') : undefined}>
              {guild.channels
                .filter((c) => c.type === 'text')
                .map((c) => (
                  <button
                    key={c.id}
                    className={`row ${sel.channelId === c.id ? 'on' : ''} ${unread.has(c.id) ? 'unread' : ''}`}
                    onClick={() => setSel({ kind: 'guild', guildId: guild.id, channelId: c.id })}
                  >
                    <span className="glyph">#</span>
                    {c.name}
                  </button>
                ))}
            </Section>
            <Section title="Voz" onAdd={guild.ownerId === me.id ? () => askNewChannel('voice') : undefined}>
              {guild.channels
                .filter((c) => c.type === 'voice')
                .map((c) => (
                  <div key={c.id}>
                    <button
                      className={`row ${sel.channelId === c.id ? 'on' : ''}`}
                      onClick={() => {
                        setSel({ kind: 'guild', guildId: guild.id, channelId: c.id })
                        void joinVoice(c.id)
                      }}
                    >
                      <span className="glyph">♪</span>
                      {c.name}
                    </button>
                    {(occupancy[c.id] ?? []).map((p) => (
                      <div key={p.socketId} className="occupant">
                        <Avatar user={p.user} small talking={talking.has(p.socketId) && !p.muted} />
                        {nameOf(p.user)}
                        <span className="flags">
                          {p.screen && <span title="Compartilhando a tela"><Icon name="tela" size={14} /></span>}
                          {p.muted && <span title="Microfone mudo"><Icon name="mic" off size={14} /></span>}
                          {p.deaf && <span title="Sem ouvir"><Icon name="fone" off size={14} /></span>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
            </Section>
          </>
        ) : (
          <>
            <div className="side-head">
              <strong>Conversas</strong>
              <button className="chip" onClick={askNewDm}>
                Nova
              </button>
            </div>
            <div className="list">
              {dms.length === 0 && <p className="muted pad">Nenhuma conversa ainda.</p>}
              {dms.map((d) => (
                <button
                  key={d.id}
                  className={`row ${sel.channelId === d.id ? 'on' : ''} ${unread.has(d.id) ? 'unread' : ''}`}
                  onClick={() => setSel({ kind: 'dm', channelId: d.id })}
                >
                  <Avatar user={d.user} small online={online.has(d.user.id)} />
                  {nameOf(d.user)}
                </button>
              ))}
            </div>
          </>
        )}
        {voice && (
          <div className="dock">
            <div className="dock-title">
              <span className="live" /> Em chamada
              <div className="muted">{voiceChannelName}</div>
            </div>
            <VoiceButtons voice={voice} media={media} onLeave={leaveVoice} />
          </div>
        )}
      </aside>

      <main className="content">
        {showStage && voice ? (
          <Stage voice={voice} me={me} title={channel?.name ?? (dm ? nameOf(dm.user) : '')} media={media} onLeave={leaveVoice} />
        ) : channel?.type === 'voice' ? (
          <div className="empty">
            <h2>{channel.name}</h2>
            <p className="muted">{(occupancy[channel.id] ?? []).length} na sala</p>
            <button className="primary" onClick={() => void joinVoice(channel.id)}>
              Entrar na sala
            </button>
          </div>
        ) : textChannelId != null && socket ? (
          <Chat
            key={textChannelId}
            me={me}
            socket={socket}
            channelId={textChannelId}
            title={channel ? `# ${channel.name}` : nameOf(dm!.user)}
            canModerate={guild?.ownerId === me.id}
            messages={messages[textChannelId]}
            typing={typingNow?.name}
            onLoadOlder={() => loadOlder(textChannelId)}
            onError={flash}
            onProfile={setCard}
            onCall={dm ? () => void joinVoice(dm.id) : undefined}
          />
        ) : (
          <div className="empty">
            <h2>Bem-vindo à Taverna</h2>
            <p className="muted">Crie um servidor, entre com um convite ou abra uma conversa.</p>
          </div>
        )}
      </main>

      {guild && (
        <aside className="people">
          <h4>Membros — {members[guild.id]?.length ?? 0}</h4>
          {(members[guild.id] ?? [])
            .slice()
            .sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)))
            .map((u) => (
              <button
                key={u.id}
                className={`row ${online.has(u.id) ? '' : 'off'}`}
                title="Ver perfil"
                onClick={() => setCard(u)}
              >
                <Avatar user={u} small online={online.has(u.id)} />
                {nameOf(u)}
              </button>
            ))}
        </aside>
      )}

      {/* áudio remoto fica sempre montado, mesmo fora da tela da chamada */}
      {voice?.remotes.flatMap((r) => r.streams.map((s) => <AudioSink key={r.info.socketId + s.id} stream={s} muted={voice.deafened} />))}
      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}
      {editProfile && (
        <ProfileEditor
          me={me}
          onClose={() => setEditProfile(false)}
          onSaved={(u) => {
            setMe(u)
            meRef.current = u
          }}
        />
      )}
      {card && (
        <ProfileCard
          user={card}
          online={online.has(card.id)}
          isMe={card.id === me.id}
          onClose={() => setCard(null)}
          onEdit={() => {
            setCard(null)
            setEditProfile(true)
          }}
          onDm={() => {
            const name = card.username
            setCard(null)
            void openDm(name).catch((e) => flash(e.message))
          }}
        />
      )}
      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}

function Section({ title, onAdd, children }: { title: string; onAdd?: () => void; children: ReactNode }) {
  return (
    <div className="list">
      <div className="list-title">
        {title}
        {onAdd && (
          <button className="link" onClick={onAdd} title={`Adicionar em ${title}`}>
            +
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function Avatar({ user, small, online, talking, size }: { user: User; small?: boolean; online?: boolean; talking?: boolean; size?: number }) {
  const box = size ? { width: size, height: size, fontSize: size * 0.42, borderRadius: size * 0.3 } : {}
  return (
    <span className={`avatar ${small ? 'small' : ''} ${talking ? 'talking' : ''}`} style={{ background: user.color, ...box }}>
      {user.avatar ? <img src={user.avatar} alt="" draggable={false} /> : nameOf(user).slice(0, 1).toUpperCase()}
      {online !== undefined && <i className={online ? 'on' : ''} />}
    </span>
  )
}

const SWATCHES = ['#e07a5f', '#3d9a8b', '#d9a441', '#7a6fd1', '#c75d8a', '#5b8fd9', '#6aa84f', '#c9683a']

function ProfileEditor({ me, onClose, onSaved }: { me: User; onClose: () => void; onSaved: (u: User) => void }) {
  const [displayName, setDisplayName] = useState(me.displayName ?? '')
  const [status, setStatus] = useState(me.status ?? '')
  const [bio, setBio] = useState(me.bio ?? '')
  const [color, setColor] = useState(me.color)
  const [avatar, setAvatar] = useState<string | null>(me.avatar ?? null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const [cropFile, setCropFile] = useState<File | null>(null)

  const pick = async (f?: File) => {
    if (!f) return
    setError('')
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return setError('Use uma imagem PNG, JPG, GIF ou WebP')
    if (f.size > 8 * 1024 * 1024) return setError('A foto pode ter até 8 MB')
    if (file.current) file.current.value = ''
    // GIF vai inteiro pra não perder a animação; as outras passam pelo recorte
    if (f.type === 'image/gif') return send(f)
    setCropFile(f)
  }
  const send = async (f: File) => {
    setBusy(true)
    try {
      setAvatar((await upload(f)).url)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ''
    }
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      onSaved(await api<User>('/me', { displayName, status, bio, color, avatar }, 'PATCH'))
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  const preview: User = { ...me, displayName: displayName.trim() || null, color, avatar }

  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal profile-edit" onSubmit={save}>
        <h3>Seu perfil</h3>
        <div className="profile-head">
          <Avatar user={preview} size={84} />
          <div className="profile-photo">
            <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => void pick(e.target.files?.[0])} />
            <button type="button" disabled={busy} onClick={() => file.current?.click()}>
              {avatar ? 'Trocar foto' : 'Escolher foto'}
            </button>
            {avatar && (
              <button type="button" className="link" onClick={() => setAvatar(null)}>
                Remover foto
              </button>
            )}
            <span className="muted">@{me.username}</span>
          </div>
        </div>
        <label>
          Nome de exibição
          <input value={displayName} maxLength={32} placeholder={me.username} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Status
          <input value={status} maxLength={80} placeholder="O que você está fazendo?" onChange={(e) => setStatus(e.target.value)} />
        </label>
        <label>
          Sobre mim
          <textarea value={bio} maxLength={300} rows={3} onChange={(e) => setBio(e.target.value)} />
        </label>
        <div className="swatches" role="group" aria-label="Cor do perfil">
          {SWATCHES.map((c) => (
            <button key={c} type="button" className={c === color ? 'on' : ''} style={{ background: c }} title={c} aria-label={`Cor ${c}`} onClick={() => setColor(c)} />
          ))}
          <input type="color" value={color} title="Outra cor" aria-label="Outra cor" onChange={(e) => setColor(e.target.value)} />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" type="submit" disabled={busy}>
            Salvar
          </button>
        </div>
      </form>
      {cropFile && (
        <Cropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onDone={(blob) => {
            setCropFile(null)
            void send(new File([blob], 'avatar.webp', { type: 'image/webp' }))
          }}
        />
      )}
    </div>
  )
}

const CROP_VIEW = 280
const CROP_OUT = 512
const CROP_MAX_ZOOM = 5

/** Recorte quadrado da foto: arrastar pra posicionar, roda do mouse ou barra pra aproximar. */
function Cropper({ file, onDone, onCancel }: { file: File; onDone: (blob: Blob) => void; onCancel: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const k = CROP_VIEW / Math.min(image.naturalWidth, image.naturalHeight)
      setPos({ x: (CROP_VIEW - image.naturalWidth * k) / 2, y: (CROP_VIEW - image.naturalHeight * k) / 2 })
      setZoom(1)
      setImg(image)
    }
    image.onerror = onCancel
    image.src = url
    return () => URL.revokeObjectURL(url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  const w = img?.naturalWidth ?? 1
  const h = img?.naturalHeight ?? 1
  const base = CROP_VIEW / Math.min(w, h) // zoom 1 = a foto cobre o quadro inteiro
  const k = base * zoom
  // a foto nunca deixa buraco dentro do quadro
  const clamp = (p: { x: number; y: number }, scale: number) => ({
    x: Math.min(0, Math.max(CROP_VIEW - w * scale, p.x)),
    y: Math.min(0, Math.max(CROP_VIEW - h * scale, p.y)),
  })
  const zoomTo = (next: number) => {
    const z = Math.min(CROP_MAX_ZOOM, Math.max(1, next))
    const k2 = base * z
    // mantém fixo o ponto que está no centro do quadro
    const cx = (CROP_VIEW / 2 - pos.x) / k
    const cy = (CROP_VIEW / 2 - pos.y) / k
    setPos(clamp({ x: CROP_VIEW / 2 - cx * k2, y: CROP_VIEW / 2 - cy * k2 }, k2))
    setZoom(z)
  }
  const confirm = () => {
    if (!img) return
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = CROP_OUT
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, -pos.x / k, -pos.y / k, CROP_VIEW / k, CROP_VIEW / k, 0, 0, CROP_OUT, CROP_OUT)
    canvas.toBlob((blob) => blob && onDone(blob), 'image/webp', 0.92)
  }

  return (
    <div className="veil crop-veil" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal crop">
        <h3>Ajustar foto</h3>
        <div
          className="crop-view"
          style={{ width: CROP_VIEW, height: CROP_VIEW }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (d) setPos(clamp({ x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }, k))
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) => zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))}
        >
          {img && <img src={img.src} alt="" draggable={false} style={{ width: w * k, height: h * k, transform: `translate(${pos.x}px, ${pos.y}px)` }} />}
          <div className="crop-mask" />
        </div>
        <label className="crop-zoom">
          Zoom
          <input type="range" min={1} max={CROP_MAX_ZOOM} step={0.01} value={zoom} onChange={(e) => zoomTo(Number(e.target.value))} />
        </label>
        <p className="muted">Arraste a foto para posicionar. A roda do mouse também aproxima.</p>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="primary" disabled={!img} onClick={confirm}>
            Usar foto
          </button>
        </div>
      </div>
    </div>
  )
}

function ProfileCard(props: { user: User; online: boolean; isMe: boolean; onClose: () => void; onDm: () => void; onEdit: () => void }) {
  const { user } = props
  const [bio, setBio] = useState<string | null>(user.bio ?? null)
  useEffect(() => {
    let alive = true
    api<User>(`/users/${user.id}`)
      .then((u) => alive && setBio(u.bio ?? null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [user.id, user.displayName, user.avatar, user.status])
  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal profile-card">
        <div className="profile-banner" style={{ background: user.color }} />
        <div className="profile-body">
          <Avatar user={user} size={84} online={props.online} />
          <h3>{nameOf(user)}</h3>
          <span className="muted">
            @{user.username} · {props.online ? 'online' : 'offline'}
          </span>
          {user.status && <p className="profile-status">{user.status}</p>}
          {bio && (
            <>
              <h4>Sobre mim</h4>
              <p className="profile-bio">{bio}</p>
            </>
          )}
          <div className="modal-actions">
            <button onClick={props.onClose}>Fechar</button>
            {props.isMe ? (
              <button className="primary" onClick={props.onEdit}>
                Editar perfil
              </button>
            ) : (
              <button className="primary" onClick={props.onDm}>
                Conversar
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AskModal({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await ask.run(values)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h3>{ask.title}</h3>
        {ask.fields.map((f, i) => (
          <label key={f.key}>
            {f.label}
            <input
              autoFocus={i === 0}
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          </label>
        ))}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" type="submit">
            {ask.action}
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------------- chat ----------------
function Chat(props: {
  me: User
  socket: Socket
  channelId: number
  title: string
  canModerate?: boolean
  messages?: Message[]
  typing?: string
  onLoadOlder: () => Promise<number | undefined>
  onError: (m: string) => void
  onProfile: (u: User) => void
  onCall?: () => void
}) {
  const { me, socket, channelId, messages } = props
  const [text, setText] = useState('')
  const [pending, setPending] = useState<Attachment | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null)
  const [noMore, setNoMore] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const lastTyping = useRef(0)
  const lastId = messages?.[messages.length - 1]?.id

  const stick = useRef(true) // só acompanha novas mensagens se o usuário já está no fim
  const first = useRef(true)
  const lastMine = messages?.[messages.length - 1]?.author.id === me.id
  useEffect(() => {
    const el = scroller.current
    if (!el || lastId === undefined) return
    if (first.current || stick.current || lastMine) {
      el.scrollTo({ top: el.scrollHeight, behavior: first.current ? 'auto' : 'smooth' })
    }
    first.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId])
  const composer = useRef<HTMLTextAreaElement>(null)
  useEffect(() => composer.current?.focus(), [])

  const send = async () => {
    const content = text.trim()
    if (!content && !pending) return
    const res: { error?: string } = await socket.emitWithAck('message:send', { channelId, content, attachment: pending })
    if (res.error) return props.onError(res.error)
    setText('')
    setPending(null)
  }
  const pick = async (file?: File) => {
    if (!file) return
    setBusy(true)
    try {
      setPending(await upload(file))
    } catch (e) {
      props.onError((e as Error).message)
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }
  const onType = (v: string) => {
    setText(v)
    if (Date.now() - lastTyping.current > 2000) {
      lastTyping.current = Date.now()
      socket.emit('typing', { channelId })
    }
  }
  const saveEdit = () => {
    if (editing?.text.trim()) socket.emit('message:edit', { id: editing.id, content: editing.text })
    setEditing(null)
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <strong>{props.title}</strong>
        {props.onCall && (
          <button className="chip" onClick={props.onCall}>
            Ligar
          </button>
        )}
      </div>
      <div
        className="scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
        }}
      >
        {messages && messages.length >= 50 && !noMore && (
          <button className="link center" onClick={async () => setNoMore(((await props.onLoadOlder()) ?? 0) < 50)}>
            Carregar mensagens anteriores
          </button>
        )}
        {!messages && <p className="muted pad">Carregando…</p>}
        {messages?.length === 0 && <p className="muted pad">Nada por aqui ainda. Diga oi!</p>}
        {messages?.map((m, i) => {
          const prev = messages[i - 1]
          const grouped = prev && prev.author.id === m.author.id && m.createdAt - prev.createdAt < 5 * 60_000
          const mine = m.author.id === me.id
          return (
            <div key={m.id} className={`msg ${grouped ? 'grouped' : ''}`}>
              <div className="msg-gutter">{!grouped && <Avatar user={m.author} />}</div>
              <div className="msg-body">
                {!grouped && (
                  <div className="msg-meta">
                    <b className="clicky" style={{ color: m.author.color }} onClick={() => props.onProfile(m.author)}>
                      {nameOf(m.author)}
                    </b>
                    <time>{new Date(m.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</time>
                  </div>
                )}
                {editing?.id === m.id ? (
                  <input
                    className="edit"
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                    onKeyDown={(e) => (e.key === 'Enter' ? saveEdit() : e.key === 'Escape' && setEditing(null))}
                    onBlur={saveEdit}
                  />
                ) : (
                  m.content && (
                    <p>
                      {m.content}
                      {m.editedAt && <small className="muted"> (editada)</small>}
                    </p>
                  )
                )}
                {m.attachment && <AttachmentView a={m.attachment} />}
                {m.reactions.length > 0 && (
                  <div className="reactions">
                    {m.reactions.map((r) => (
                      <button
                        key={r.emoji}
                        className={`chip ${r.userIds.includes(me.id) ? 'on' : ''}`}
                        onClick={() => socket.emit('reaction:toggle', { messageId: m.id, emoji: r.emoji })}
                      >
                        {r.emoji} {r.userIds.length}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="msg-tools">
                {EMOJIS.map((e) => (
                  <button key={e} title={`Reagir ${e}`} onClick={() => socket.emit('reaction:toggle', { messageId: m.id, emoji: e })}>
                    {e}
                  </button>
                ))}
                {mine && m.content && (
                  <button title="Editar" onClick={() => setEditing({ id: m.id, text: m.content })}>
                    ✎
                  </button>
                )}
                {(mine || props.canModerate) && (
                  <button title="Apagar" onClick={() => confirm('Apagar esta mensagem?') && socket.emit('message:delete', { id: m.id })}>
                    ✕
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="typing">{props.typing ? `${props.typing} está digitando…` : ''}</div>
      {pending && (
        <div className="pending">
          📎 {pending.name}
          <button className="link" onClick={() => setPending(null)}>
            remover
          </button>
        </div>
      )}
      <div className="composer">
        <input ref={fileInput} type="file" hidden onChange={(e) => void pick(e.target.files?.[0])} />
        <button title="Anexar arquivo (até 25 MB)" disabled={busy} onClick={() => fileInput.current?.click()}>
          {busy ? '…' : '📎'}
        </button>
        <textarea
          ref={composer}
          rows={1}
          placeholder={`Mensagem em ${props.title}`}
          value={text}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          onPaste={(e) => {
            const f = [...e.clipboardData.files][0]
            if (f) {
              e.preventDefault()
              void pick(f)
            }
          }}
        />
        <button className="primary" onClick={() => void send()}>
          Enviar
        </button>
      </div>
    </div>
  )
}

function AttachmentView({ a }: { a: Attachment }) {
  if (a.mime.startsWith('image/'))
    return (
      <a href={a.url} target="_blank" rel="noreferrer">
        <img className="att" src={a.url} alt={a.name} loading="lazy" />
      </a>
    )
  if (a.mime.startsWith('video/')) return <video className="att" src={a.url} controls />
  if (a.mime.startsWith('audio/')) return <audio src={a.url} controls />
  return (
    <a className="file" href={a.url} download={a.name}>
      📄 {a.name} <span className="muted">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
    </a>
  )
}

// ---------------- voz / vídeo / tela ----------------
type MediaFn = (fn: (s: VoiceSession) => void | Promise<void>) => () => Promise<void>

function VoiceButtons({ voice, media, onLeave }: { voice: VoiceSnapshot; media: MediaFn; onLeave: () => void }) {
  const micOff = voice.muted || !voice.micOk
  return (
    <div className="voice-buttons">
      <button
        className={micOff ? 'warn' : ''}
        disabled={!voice.micOk}
        title={!voice.micOk ? 'Nenhum microfone encontrado' : voice.muted ? 'Ativar microfone' : 'Silenciar microfone'}
        aria-label={voice.muted ? 'Ativar microfone' : 'Silenciar microfone'}
        onClick={media((s) => s.toggleMute())}
      >
        <Icon name="mic" off={micOff} />
      </button>
      <button
        className={voice.deafened ? 'warn' : ''}
        title={voice.deafened ? 'Voltar a ouvir' : 'Parar de ouvir'}
        aria-label={voice.deafened ? 'Voltar a ouvir' : 'Parar de ouvir'}
        onClick={media((s) => s.toggleDeafen())}
      >
        <Icon name="fone" off={voice.deafened} />
      </button>
      <button
        className={voice.video ? 'on' : ''}
        title={voice.video ? 'Desligar câmera' : 'Ligar câmera'}
        aria-label={voice.video ? 'Desligar câmera' : 'Ligar câmera'}
        onClick={media((s) => s.toggleCamera())}
      >
        <Icon name="camera" off={!voice.video} />
      </button>
      <button
        className={voice.screen ? 'on' : ''}
        title={voice.screen ? 'Parar de compartilhar a tela' : 'Compartilhar a tela'}
        aria-label={voice.screen ? 'Parar de compartilhar a tela' : 'Compartilhar a tela'}
        onClick={media((s) => s.toggleScreen())}
      >
        <Icon name="tela" />
      </button>
      <button className="danger" title="Sair da chamada" aria-label="Sair da chamada" onClick={onLeave}>
        <Icon name="sair" />
      </button>
    </div>
  )
}

function Stage(props: { voice: VoiceSnapshot; me: User; title: string; media: MediaFn; onLeave: () => void }) {
  const { voice, me } = props
  const [focus, setFocus] = useState<string | null>(null)
  const tiles: { key: string; user: User; stream: MediaStream | null; voice?: MediaStream | null; label: string; screen?: boolean; muted?: boolean; deaf?: boolean }[] = []
  tiles.push({ key: 'me', user: me, stream: voice.camera, voice: voice.muted ? null : voice.mic, label: `${nameOf(me)} (você)`, muted: voice.muted || !voice.micOk, deaf: voice.deafened })
  if (voice.screenStream) tiles.push({ key: 'me-screen', user: me, stream: voice.screenStream, label: 'Sua tela', screen: true })
  for (const r of voice.remotes) {
    const cam = r.info.video ? r.streams.find((s) => s.id === r.info.cameraStream) ?? null : null
    const scr = r.info.screen ? r.streams.find((s) => s.id === r.info.screenStream) ?? null : null
    const mic = r.streams.find((s) => s.id !== r.info.screenStream && s.getAudioTracks().length > 0) ?? null
    tiles.push({ key: r.info.socketId, user: r.info.user, stream: cam, voice: r.info.muted ? null : mic, label: nameOf(r.info.user), muted: r.info.muted, deaf: r.info.deaf })
    if (scr) tiles.push({ key: r.info.socketId + '-screen', user: r.info.user, stream: scr, label: `Tela de ${nameOf(r.info.user)}`, screen: true })
  }
  // tela compartilhada ganha destaque sozinha, a menos que o usuário escolha outro foco
  const focused = tiles.find((t) => t.key === focus) ?? tiles.find((t) => t.screen) ?? null
  const rest = focused ? tiles.filter((t) => t !== focused) : tiles
  const tile = (t: (typeof tiles)[number], big?: boolean) => (
    <Tile key={t.key} big={big} voice={t.voice ?? null} onClick={() => setFocus(focus === t.key ? null : t.key)}>
      {t.stream ? <StreamVideo stream={t.stream} contain={t.screen} /> : <Avatar user={t.user} />}
      <span className="tile-label">
        {t.label}
        {t.muted && <Icon name="mic" off size={14} />}
        {t.deaf && <Icon name="fone" off size={14} />}
      </span>
    </Tile>
  )
  return (
    <div className="stage">
      <div className="chat-head">
        <strong>♪ {props.title}</strong>
        <span className="muted">{voice.remotes.length + 1} na chamada</span>
      </div>
      {focused && <div className="spot">{tile(focused, true)}</div>}
      <div className={`grid ${focused ? 'strip' : ''}`}>{rest.map((t) => tile(t))}</div>
      <div className="stage-bar">
        <VoiceButtons voice={voice} media={props.media} onLeave={props.onLeave} />
      </div>
    </div>
  )
}

let audioCtx: AudioContext | null = null

/** Verdadeiro enquanto o áudio do stream passa de um limiar (borda acesa em quem fala). */
function useSpeaking(stream: MediaStream | null) {
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return
    audioCtx ??= new AudioContext()
    void audioCtx.resume()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    let loudAt = 0
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
      const now = Date.now()
      if (peak > 10) {
        loudAt = now
        setSpeaking(true)
      } else if (now - loudAt > 350) setSpeaking(false)
    }, 80)
    return () => {
      clearInterval(timer)
      source.disconnect()
      setSpeaking(false)
    }
  }, [stream])
  return speaking
}

function Tile(props: { big?: boolean; voice: MediaStream | null; onClick: () => void; children: ReactNode }) {
  const speaking = useSpeaking(props.voice)
  const box = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  // tela cheia: botão no canto, duplo clique, ou Esc pra sair
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void box.current?.requestFullscreen().catch(() => {})
  }
  return (
    <div
      ref={box}
      className={`tile ${props.big ? 'big' : ''} ${speaking ? 'talking' : ''}`}
      onClick={full ? undefined : props.onClick}
      onDoubleClick={toggleFull}
    >
      {props.children}
      <button
        className="tile-fs"
        title={full ? 'Sair da tela cheia (Esc)' : 'Tela cheia (ou duplo clique)'}
        aria-label={full ? 'Sair da tela cheia' : 'Tela cheia'}
        onClick={(e) => {
          e.stopPropagation()
          toggleFull()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Icon name={full ? 'reduzir' : 'cheia'} size={18} />
      </button>
    </div>
  )
}

function StreamVideo({ stream, contain }: { stream: MediaStream; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream
  }, [stream])
  // sempre mudo: o som sai pelo AudioSink
  return <video ref={ref} autoPlay playsInline muted style={{ objectFit: contain ? 'contain' : 'cover' }} />
}

function AudioSink({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream
  }, [stream])
  useEffect(() => {
    if (ref.current) ref.current.muted = muted
  }, [muted])
  return <audio ref={ref} autoPlay hidden />
}
