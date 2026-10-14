export type SignpostsPhase = 'idle' | 'running' | 'done' | 'failed'

/** One `search_signposts` call that found something, as the pane lists it. */
export type SignpostsSearch = { query: string; claims: { claim: string; category: string }[] }

declare module 'claude-code' {
  interface PluginState {
    'signposts-mod': {
      eligible: number
      phase: SignpostsPhase
      detail: string
      isDismissed: boolean
      row: string
      searches: SignpostsSearch[]
      isPanePlaced: boolean
      manualCommand: string
    }
  }
}
