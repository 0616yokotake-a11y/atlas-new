import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BodyPart, MyMenu, WorkoutSession } from '../types'

type AtlasStore = {
  sessions: WorkoutSession[]
  myMenus: MyMenu[]
  setSessions: (sessions: WorkoutSession[]) => void
  setMyMenus: (myMenus: MyMenu[]) => void
  addSession: (session: WorkoutSession) => void
  deleteSession: (sessionId: string) => void
  addMyMenu: (name: string, bodyPart: BodyPart, exercises: string[]) => MyMenu
  updateMyMenu: (menuId: string, name: string, bodyPart: BodyPart, exercises: string[]) => void
  deleteMyMenu: (menuId: string) => void
}

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.floor(Math.random() * 100000)}`
}

export const useAtlasStore = create<AtlasStore>()(
  persist(
    (set) => ({
      sessions: [],
      myMenus: [],
      setSessions: (sessions) => set({ sessions }),
      setMyMenus: (myMenus) => set({ myMenus }),
      addSession: (session) => set((state) => ({ sessions: [session, ...state.sessions] })),
      deleteSession: (sessionId) =>
        set((state) => ({
          sessions: state.sessions.filter((session) => session.id !== sessionId),
        })),
      addMyMenu: (name, bodyPart, exercises) => {
        const created = { id: makeId(), name, bodyPart, exercises }
        set((state) => ({
          myMenus: [...state.myMenus, created],
        }))
        return created
      },
      updateMyMenu: (menuId, name, bodyPart, exercises) =>
        set((state) => ({
          myMenus: state.myMenus.map((menu) =>
            menu.id === menuId ? { ...menu, name, bodyPart, exercises } : menu,
          ),
        })),
      deleteMyMenu: (menuId) =>
        set((state) => ({
          myMenus: state.myMenus.filter((menu) => menu.id !== menuId),
        })),
    }),
    {
      name: 'atlas-local-store',
    },
  ),
)
