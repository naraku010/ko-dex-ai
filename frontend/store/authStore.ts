import { create } from 'zustand'
import type { AuthUser } from '@/types/assistant'

export const LOCAL_USER: AuthUser = {
  user_id: 'local',
  user_name: 'KODEX',
  role: 'admin',
}

interface AuthState {
  user: AuthUser
  hydrating: boolean
}

export const useAuthStore = create<AuthState>(() => ({
  user: LOCAL_USER,
  hydrating: false,
}))
