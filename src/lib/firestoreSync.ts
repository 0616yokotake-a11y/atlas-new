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
