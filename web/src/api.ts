export type User = {
  id: number
  username: string
  color: string
  displayName?: string | null
  avatar?: string | null
  status?: string | null
  bio?: string | null
}
/** Nome mostrado: o de exibição, se a pessoa definiu um; senão o de usuário. */
export const nameOf = (u: User) => u.displayName || u.username
export type Channel = { id: number; name: string; type: 'text' | 'voice' }
export type Guild = { id: number; name: string; ownerId: number; inviteCode: string; channels: Channel[] }
export type Dm = { id: number; user: User }
export type Attachment = { url: string; name: string; mime: string; size: number }
export type Reaction = { emoji: string; userIds: number[] }
export type Message = {
  id: number
  channelId: number
  content: string
  attachment: Attachment | null
  createdAt: number
  editedAt: number | null
  author: User
  reactions: Reaction[]
}
export type VoicePeer = {
  socketId: string
  user: User
  muted: boolean
  deaf?: boolean
  video: boolean
  screen: boolean
  cameraStream?: string | null
  screenStream?: string | null
}

const TOKEN_KEY = 'taverna.token'
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t: string | null) =>
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`/api${path}`, {
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`)
  return data as T
}

export async function upload(file: File): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { authorization: `Bearer ${getToken()}` },
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`)
  return data as Attachment
}
