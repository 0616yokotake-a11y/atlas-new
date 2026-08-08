import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  setDoc,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore'
import type { MyMenu, WorkoutSession } from '../types'

const PENDING_SYNC_STORAGE_KEY = 'atlas.pending-sync-ops.v1'
const MAX_PENDING_SYNC_ATTEMPTS = 8

type PendingSyncOperation =
  | {
      id: string
      type: 'saveSession'
      session: WorkoutSession
      createdAt: string
      attempts: number
    }
  | {
      id: string
      type: 'removeSession'
      sessionId: string
      createdAt: string
      attempts: number
    }

type PendingSyncProgress = {
  completed: number
  remaining: number
}

function readPendingSyncOps(): PendingSyncOperation[] {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const raw = window.localStorage.getItem(PENDING_SYNC_STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((item): item is PendingSyncOperation => Boolean(item && typeof item === 'object'))
  } catch {
    return []
  }
}

function writePendingSyncOps(operations: PendingSyncOperation[]) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(PENDING_SYNC_STORAGE_KEY, JSON.stringify(operations))
  } catch {
    // Ignore storage write failures.
  }
}

function makePendingSyncId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function enqueuePendingSyncOp(operation: PendingSyncOperation) {
  const existing = readPendingSyncOps()
  const deduped = existing.filter((item) => {
    if (item.type === 'saveSession' && operation.type === 'saveSession') {
      return item.session.id !== operation.session.id
    }
    if (item.type === 'removeSession' && operation.type === 'removeSession') {
      return item.sessionId !== operation.sessionId
    }
    return true
  })

  deduped.push(operation)
  writePendingSyncOps(deduped)
}

function userSessionsCollection(db: Firestore, uid: string) {
  return collection(db, 'users', uid, 'sessions')
}

function userMenusCollection(db: Firestore, uid: string) {
  return collection(db, 'users', uid, 'myMenus')
}

export function subscribeSessions(
  db: Firestore,
  uid: string,
  onChange: (sessions: WorkoutSession[]) => void,
): Unsubscribe {
  return onSnapshot(userSessionsCollection(db, uid), (snapshot) => {
    const sessions = snapshot.docs.map((item) => item.data() as WorkoutSession)
    onChange(sessions)
  })
}

export function subscribeMyMenus(
  db: Firestore,
  uid: string,
  onChange: (myMenus: MyMenu[]) => void,
): Unsubscribe {
  return onSnapshot(userMenusCollection(db, uid), (snapshot) => {
    const myMenus = snapshot.docs.map((item) => item.data() as MyMenu)
    onChange(myMenus)
  })
}

export async function saveSession(db: Firestore, uid: string, session: WorkoutSession) {
  await setDoc(doc(db, 'users', uid, 'sessions', session.id), session)
}

export async function removeSession(db: Firestore, uid: string, sessionId: string) {
  await deleteDoc(doc(db, 'users', uid, 'sessions', sessionId))
}

export async function saveMyMenu(db: Firestore, uid: string, myMenu: MyMenu) {
  await setDoc(doc(db, 'users', uid, 'myMenus', myMenu.id), myMenu)
}

export async function removeMyMenu(db: Firestore, uid: string, menuId: string) {
  await deleteDoc(doc(db, 'users', uid, 'myMenus', menuId))
}

export function queueSessionSave(session: WorkoutSession) {
  enqueuePendingSyncOp({
    id: makePendingSyncId('save-session'),
    type: 'saveSession',
    session,
    createdAt: new Date().toISOString(),
    attempts: 0,
  })
}

export function queueSessionDelete(sessionId: string) {
  enqueuePendingSyncOp({
    id: makePendingSyncId('remove-session'),
    type: 'removeSession',
    sessionId,
    createdAt: new Date().toISOString(),
    attempts: 0,
  })
}

export async function flushPendingSyncOps(
  db: Firestore,
  uid: string,
  onProgress?: (state: PendingSyncProgress) => void,
) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return [] as PendingSyncOperation[]
  }

  const pending = readPendingSyncOps()
  if (pending.length === 0) {
    return [] as PendingSyncOperation[]
  }

  const remaining: PendingSyncOperation[] = []
  let completedCount = 0

  for (const operation of pending) {
    if (operation.attempts >= MAX_PENDING_SYNC_ATTEMPTS) {
      remaining.push(operation)
      continue
    }

    try {
      if (operation.type === 'saveSession') {
        await saveSession(db, uid, operation.session)
      } else {
        await removeSession(db, uid, operation.sessionId)
      }
      completedCount += 1
    } catch {
      const retriedOperation = {
        ...operation,
        attempts: operation.attempts + 1,
      }
      remaining.push(retriedOperation)
    }
  }

  writePendingSyncOps(remaining)
  onProgress?.({ completed: completedCount, remaining: remaining.length })
  return remaining
}
