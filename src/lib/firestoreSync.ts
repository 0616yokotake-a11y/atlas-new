import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  setDoc,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore'
import type { BodyPart, ExerciseMetricType, MyMenu, WorkoutSession } from '../types'

const PENDING_SYNC_STORAGE_KEY = 'atlas.pending-sync-ops.v1'
const MAX_PENDING_SYNC_ATTEMPTS = 8

export type TrainingGoal = '筋肥大' | 'ダイエット'

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
  | {
      id: string
      type: 'saveLibrary'
      customExercisesByBodyPart: Record<BodyPart, string[]>
      createdAt: string
      attempts: number
    }
  | {
      id: string
      type: 'saveUserSettings'
      userSettings: UserSettingsPayload
      createdAt: string
      attempts: number
    }

type PendingSyncProgress = {
  completed: number
  remaining: number
}

type PendingSyncRetryOptions = {
  force?: boolean
  timeoutMs?: number
}

export type PendingSyncOverview = {
  totalCount: number
  blockedCount: number
  sessions: {
    pendingCount: number
    blockedCount: number
  }
  customExercises: {
    pendingCount: number
    blockedCount: number
  }
  userSettings: {
    pendingCount: number
    blockedCount: number
  }
}

export type UserSettingsPayload = {
  exerciseNotes: Record<string, string>
  exercisePreferences: Record<string, { restSeconds: number; metricType?: ExerciseMetricType }>
  proUnlocked: boolean
  trainingGoal: TrainingGoal
  myMenus: MyMenu[]
  pickerStepSettings: {
    weightStep: number
    repStep: number
    durationStep: number
  }
  bodyProfile: {
    heightCm: number | null
    weightKg: number | null
    age: number | null
  }
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

function readLatestPendingSaveUserSettings(): UserSettingsPayload | null {
  const pendingOps = readPendingSyncOps()
  for (let index = pendingOps.length - 1; index >= 0; index -= 1) {
    const op = pendingOps[index]
    if (op.type === 'saveUserSettings') {
      return op.userSettings
    }
  }
  return null
}

function readLatestPendingSaveCustomExercises(): Record<BodyPart, string[]> | null {
  const pendingOps = readPendingSyncOps()
  for (let index = pendingOps.length - 1; index >= 0; index -= 1) {
    const op = pendingOps[index]
    if (op.type === 'saveLibrary') {
      return op.customExercisesByBodyPart
    }
  }
  return null
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

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((item) => stripUndefinedDeep(item))
      .filter((item) => item !== undefined) as T
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    Object.entries(value as Record<string, unknown>).forEach(([key, nestedValue]) => {
      if (nestedValue === undefined) {
        return
      }
      result[key] = stripUndefinedDeep(nestedValue)
    })
    return result as T
  }

  return value
}

async function withSyncTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: number | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error('Firestore 同期が時間切れになりました'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }
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
    if (item.type === 'saveSession' && operation.type === 'removeSession') {
      return item.session.id !== operation.sessionId
    }
    if (item.type === 'removeSession' && operation.type === 'saveSession') {
      return item.sessionId !== operation.session.id
    }
    if (item.type === 'saveLibrary' && operation.type === 'saveLibrary') {
      return false
    }
    if (item.type === 'saveUserSettings' && operation.type === 'saveUserSettings') {
      return false
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

function userLibraryDoc(db: Firestore, uid: string) {
  return doc(db, 'users', uid, 'library', 'customExercises')
}

function userSettingsDoc(db: Firestore, uid: string) {
  return doc(db, 'users', uid, 'settings', 'main')
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
  await setDoc(doc(db, 'users', uid, 'sessions', session.id), stripUndefinedDeep(session))
}

export async function removeSession(db: Firestore, uid: string, sessionId: string) {
  await deleteDoc(doc(db, 'users', uid, 'sessions', sessionId))
}

export async function saveMyMenu(db: Firestore, uid: string, myMenu: MyMenu) {
  await setDoc(doc(db, 'users', uid, 'myMenus', myMenu.id), stripUndefinedDeep(myMenu))
}

export async function removeMyMenu(db: Firestore, uid: string, menuId: string) {
  await deleteDoc(doc(db, 'users', uid, 'myMenus', menuId))
}

export function subscribeCustomExercises(
  db: Firestore,
  uid: string,
  onChange: (customExercisesByBodyPart: Record<BodyPart, string[]> | null) => void,
): Unsubscribe {
  return onSnapshot(userLibraryDoc(db, uid), (snapshot) => {
    const data = snapshot.exists() ? (snapshot.data() as { customExercisesByBodyPart?: Record<BodyPart, string[]> }) : null
    onChange(data?.customExercisesByBodyPart ?? null)
  })
}

export async function saveCustomExercises(
  db: Firestore,
  uid: string,
  customExercisesByBodyPart: Record<BodyPart, string[]>,
) {
  await setDoc(userLibraryDoc(db, uid), stripUndefinedDeep({ customExercisesByBodyPart }), { merge: true })
}

export function subscribeUserSettings(
  db: Firestore,
  uid: string,
  onChange: (userSettings: UserSettingsPayload | null) => void,
): Unsubscribe {
  return onSnapshot(userSettingsDoc(db, uid), (snapshot) => {
    const data = snapshot.exists() ? (snapshot.data() as Partial<UserSettingsPayload>) : null
    if (!data) {
      onChange(null)
      return
    }

    onChange({
      exerciseNotes: data.exerciseNotes ?? {},
      exercisePreferences: data.exercisePreferences ?? {},
      proUnlocked: Boolean(data.proUnlocked),
      trainingGoal: data.trainingGoal === 'ダイエット' ? 'ダイエット' : '筋肥大',
      myMenus: Array.isArray(data.myMenus) ? data.myMenus : [],
      pickerStepSettings: data.pickerStepSettings ?? {
        weightStep: 1,
        repStep: 1,
        durationStep: 5,
      },
      bodyProfile: data.bodyProfile ?? {
        heightCm: null,
        weightKg: null,
        age: null,
      },
    })
  })
}

export async function saveUserSettings(db: Firestore, uid: string, userSettings: UserSettingsPayload) {
  await setDoc(userSettingsDoc(db, uid), stripUndefinedDeep(userSettings), { merge: true })
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

export function queueCustomExercisesSave(customExercisesByBodyPart: Record<BodyPart, string[]>) {
  enqueuePendingSyncOp({
    id: makePendingSyncId('save-library'),
    type: 'saveLibrary',
    customExercisesByBodyPart,
    createdAt: new Date().toISOString(),
    attempts: 0,
  })
}

export function getPendingCustomExercisesSavePayload() {
  return readLatestPendingSaveCustomExercises()
}

export function queueUserSettingsSave(userSettings: UserSettingsPayload) {
  enqueuePendingSyncOp({
    id: makePendingSyncId('save-user-settings'),
    type: 'saveUserSettings',
    userSettings,
    createdAt: new Date().toISOString(),
    attempts: 0,
  })
}

export function getPendingUserSettingsSavePayload() {
  return readLatestPendingSaveUserSettings()
}

export function getPendingSessionSyncState() {
  const pending = readPendingSyncOps()
  const savingIds = new Set<string>()
  const deletingIds = new Set<string>()

  pending.forEach((operation) => {
    if (operation.type === 'saveSession') {
      savingIds.add(operation.session.id)
    }
    if (operation.type === 'removeSession') {
      deletingIds.add(operation.sessionId)
    }
  })

  return { savingIds, deletingIds }
}

export function getPendingSyncOverview() {
  const pending = readPendingSyncOps()
  const sessionPending = pending.filter((operation) => operation.type === 'saveSession' || operation.type === 'removeSession')
  const customExercisesPending = pending.filter((operation) => operation.type === 'saveLibrary')
  const userSettingsPending = pending.filter((operation) => operation.type === 'saveUserSettings')

  return {
    totalCount: pending.length,
    blockedCount: pending.filter((operation) => operation.attempts >= MAX_PENDING_SYNC_ATTEMPTS).length,
    sessions: {
      pendingCount: sessionPending.length,
      blockedCount: sessionPending.filter((operation) => operation.attempts >= MAX_PENDING_SYNC_ATTEMPTS).length,
    },
    customExercises: {
      pendingCount: customExercisesPending.length,
      blockedCount: customExercisesPending.filter((operation) => operation.attempts >= MAX_PENDING_SYNC_ATTEMPTS).length,
    },
    userSettings: {
      pendingCount: userSettingsPending.length,
      blockedCount: userSettingsPending.filter((operation) => operation.attempts >= MAX_PENDING_SYNC_ATTEMPTS).length,
    },
  }
}

export function prunePendingSessionSaveOps(activeSessionIds: string[]) {
  const pending = readPendingSyncOps()
  const activeSessionIdSet = new Set(activeSessionIds)
  const nextPending = pending.filter((operation) => {
    if (operation.type !== 'saveSession') {
      return true
    }

    return activeSessionIdSet.has(operation.session.id)
  })

  if (nextPending.length !== pending.length) {
    writePendingSyncOps(nextPending)
  }
}

export function removePendingSessionSave(sessionId: string) {
  const pending = readPendingSyncOps()
  const nextPending = pending.filter((operation) => !(operation.type === 'saveSession' && operation.session.id === sessionId))
  if (nextPending.length !== pending.length) {
    writePendingSyncOps(nextPending)
  }
}

export function removePendingSessionDelete(sessionId: string) {
  const pending = readPendingSyncOps()
  const nextPending = pending.filter((operation) => !(operation.type === 'removeSession' && operation.sessionId === sessionId))
  if (nextPending.length !== pending.length) {
    writePendingSyncOps(nextPending)
  }
}

export function removePendingCustomExercisesSave() {
  const pending = readPendingSyncOps()
  const nextPending = pending.filter((operation) => operation.type !== 'saveLibrary')
  if (nextPending.length !== pending.length) {
    writePendingSyncOps(nextPending)
  }
}

export function removePendingUserSettingsSave() {
  const pending = readPendingSyncOps()
  const nextPending = pending.filter((operation) => operation.type !== 'saveUserSettings')
  if (nextPending.length !== pending.length) {
    writePendingSyncOps(nextPending)
  }
}

export function hasPendingCustomExercisesSave() {
  return readPendingSyncOps().some((operation) => operation.type === 'saveLibrary')
}

export function hasPendingUserSettingsSave() {
  return readPendingSyncOps().some((operation) => operation.type === 'saveUserSettings')
}

export function clearPendingSyncOps() {
  writePendingSyncOps([])
}

export async function flushPendingSyncOps(
  db: Firestore,
  uid: string,
  onProgress?: (state: PendingSyncProgress) => void,
  options?: PendingSyncRetryOptions,
) {
  const force = options?.force ?? false
  const timeoutMs = options?.timeoutMs ?? 7000
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
    if (!force && operation.attempts >= MAX_PENDING_SYNC_ATTEMPTS) {
      remaining.push(operation)
      continue
    }

    try {
      const syncPromise =
        operation.type === 'saveSession'
          ? saveSession(db, uid, operation.session)
          : operation.type === 'removeSession'
            ? removeSession(db, uid, operation.sessionId)
            : operation.type === 'saveUserSettings'
              ? saveUserSettings(db, uid, operation.userSettings)
              : saveCustomExercises(db, uid, operation.customExercisesByBodyPart)

      await withSyncTimeout(syncPromise, timeoutMs)
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
