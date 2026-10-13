export type SignpostsPhase = 'idle' | 'running' | 'done' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'signposts-mod': {
      eligible: number
      phase: SignpostsPhase
      detail: string
      isDismissed: boolean
    }
  }
}
