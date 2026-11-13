/** Temas de cor do app. Cada um define as variáveis de cor usadas no CSS. */
export type ThemeId = 'taverna' | 'meia-noite' | 'floresta' | 'ameixa' | 'grafite' | 'claro'
export type ThemeChoice = { preset?: ThemeId; accent?: string | null }

type Palette = { bg: string; panel: string; raised: string; line: string; text: string; muted: string; accent: string; ok: string; danger: string; light?: boolean }

export const THEMES: Record<ThemeId, { name: string; colors: Palette }> = {
  taverna: { name: 'Taverna', colors: { bg: '#1b1613', panel: '#241d19', raised: '#30261f', line: '#3d3129', text: '#efe6dc', muted: '#a39384', accent: '#e0a43a', ok: '#7fb069', danger: '#d9624e' } },
  'meia-noite': { name: 'Meia-noite', colors: { bg: '#11141c', panel: '#171b26', raised: '#212737', line: '#2c3446', text: '#e6eaf2', muted: '#8f9ab0', accent: '#6c8cff', ok: '#5fc48a', danger: '#ef5f6b' } },
  floresta: { name: 'Floresta', colors: { bg: '#121a15', panel: '#18221b', raised: '#213026', line: '#2c3e31', text: '#e3efe6', muted: '#8fa897', accent: '#5cc58a', ok: '#8bd17c', danger: '#e0675a' } },
  ameixa: { name: 'Ameixa', colors: { bg: '#1a1320', panel: '#221a2a', raised: '#2e2338', line: '#3c2f49', text: '#efe6f5', muted: '#a796b5', accent: '#c77dff', ok: '#6fd19a', danger: '#ff6b8b' } },
  grafite: { name: 'Grafite', colors: { bg: '#161616', panel: '#1e1e1e', raised: '#2a2a2a', line: '#383838', text: '#ececec', muted: '#9a9a9a', accent: '#e5484d', ok: '#46a758', danger: '#ff6369' } },
  claro: { name: 'Claro', colors: { bg: '#f4f1ec', panel: '#ffffff', raised: '#ece7df', line: '#d9d1c5', text: '#2a231d', muted: '#75685b', accent: '#b9771a', ok: '#3f8f45', danger: '#c4462f', light: true } },
}

/** Texto legível sobre a cor de destaque (escuro em cor clara, branco em cor escura). */
function inkFor(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.4 ? '#1a1207' : '#ffffff'
}

const STORE = 'cgl.theme'

export function applyTheme(choice: ThemeChoice | undefined) {
  const t = THEMES[choice?.preset ?? 'taverna'] ?? THEMES.taverna
  const accent = choice?.accent && /^#[0-9a-f]{6}$/i.test(choice.accent) ? choice.accent : t.colors.accent
  const root = document.documentElement.style
  for (const [k, v] of Object.entries(t.colors)) if (k !== 'light') root.setProperty(`--${k}`, v as string)
  root.setProperty('--accent', accent)
  root.setProperty('--accent-ink', inkFor(accent))
  root.setProperty('color-scheme', t.colors.light ? 'light' : 'dark')
  document.documentElement.dataset.theme = t.colors.light ? 'light' : 'dark'
  try {
    localStorage.setItem(STORE, JSON.stringify(choice ?? {}))
  } catch {
    // sem armazenamento: o tema volta ao entrar na conta
  }
}

/** Aplica o último tema usado já ao abrir, antes de carregar a conta (evita piscar). */
export function applyStoredTheme() {
  try {
    applyTheme(JSON.parse(localStorage.getItem(STORE) || '{}'))
  } catch {
    applyTheme(undefined)
  }
}
