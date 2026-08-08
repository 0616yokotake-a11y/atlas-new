import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  GoogleAuthProvider,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signInWithPopup,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type ConfirmationResult,
  type User,
} from 'firebase/auth'
import dayjs from 'dayjs'
import { auth, db, isFirebaseConfigured } from './lib/firebase'
import { BODY_PARTS } from './data/catalog'
import { useAtlasStore } from './store/useAtlasStore'
import {
  queueSessionDelete,
  queueCustomExercisesSave,
  queueSessionSave,
  removeSession,
  saveSession,
  saveCustomExercises,
  subscribeCustomExercises,
  subscribeSessions,
  flushPendingSyncOps,
} from './lib/firestoreSync'
import type { BodyPart, ExerciseMetricType, ExerciseSet, WorkoutSession } from './types'

type AppTab = 'home' | 'workout' | 'history' | 'analytics' | 'settings'
type MainTab = Exclude<AppTab, 'settings'>
type AuthMode = 'login' | 'signup' | 'reset'
type WorkoutPhase = 'body' | 'exercise' | 'record'
type PickerTargetKey = 'weight' | 'reps' | 'duration'
type BodyPartBadgeTone = 'new' | 'fresh' | 'ready' | 'stale'
type ExercisePreference = {
  restSeconds: number
  metricType?: ExerciseMetricType
}
type ExerciseGuidanceSpec = {
  setup: string
  cue: string
  equipment: string
  focus: string
  tip: string
}
type ExerciseInputProfile = {
  defaultWeight: number
  defaultReps: number
  defaultDurationSec: number
  defaultRestSeconds: number
  weightMin: number
  weightMax: number
  weightStep: number
  repMin: number
  repMax: number
  repStep: number
  durationMin: number
  durationMax: number
  durationStep: number
}
const WHEEL_ITEM_HEIGHT = 54
const WHEEL_VISIBLE_ROWS = 5
const WHEEL_SIDE_PADDING = ((WHEEL_VISIBLE_ROWS - 1) / 2) * WHEEL_ITEM_HEIGHT
const EXERCISE_PREFERENCES_STORAGE_KEY = 'atlas.exercise-preferences.v1'
const EXERCISE_NOTES_STORAGE_KEY = 'atlas.exercise-notes.v1'
const CUSTOM_EXERCISES_STORAGE_KEY = 'atlas.custom-exercises.v1'
const PRO_UNLOCKED_STORAGE_KEY = 'atlas.pro-unlocked.v1'
const TIME_BASED_EXERCISES = new Set(['プランク', 'サイドプランク'])
let audioContextInstance: AudioContext | null = null

function triggerHaptic(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern)
  }
}

function getAudioContext() {
  if (typeof window === 'undefined') {
    return null
  }

  const AudioCtor = window.AudioContext ?? (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtor) {
    return null
  }

  if (!audioContextInstance) {
    audioContextInstance = new AudioCtor()
  }

  return audioContextInstance
}

async function prepareAudioContext() {
  const ctx = getAudioContext()
  if (!ctx) {
    return
  }

  if (ctx.state === 'suspended') {
    await ctx.resume()
  }
}

function playTimerEndSound() {
  try {
    const ctx = getAudioContext()
    if (!ctx) return
    void prepareAudioContext().then(() => {
      const beeps = [0, 0.22, 0.44]
      beeps.forEach((offset) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.setValueAtTime(880, ctx.currentTime + offset)
        gain.gain.setValueAtTime(0, ctx.currentTime + offset)
        gain.gain.linearRampToValueAtTime(0.55, ctx.currentTime + offset + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.18)
        osc.start(ctx.currentTime + offset)
        osc.stop(ctx.currentTime + offset + 0.18)
      })
      window.setTimeout(() => {
        const closingContext = audioContextInstance
        audioContextInstance = null
        void closingContext?.close().catch(() => undefined)
      }, 1400)
    })
  } catch {
    // Web Audio not supported, skip silently
  }
}

function mergeWorkoutSessions(localSessions: WorkoutSession[], remoteSessions: WorkoutSession[]) {
  const remoteIds = new Set(remoteSessions.map((session) => session.id))
  const merged = [
    ...remoteSessions,
    ...localSessions.filter((session) => !remoteIds.has(session.id)),
  ]

  return merged.sort((left, right) => dayjs(right.date).valueOf() - dayjs(left.date).valueOf())
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch() {
    // Keep the UI safe and readable instead of showing a white crash screen.
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app error-boundary-shell">
          <section className="card error-boundary-card">
            <h2>表示に問題が起きました</h2>
            <p>少し待ってからもう一度開いてください。必要なら再読み込みしてください。</p>
            <button type="button" className="secondary-btn" onClick={() => window.location.reload()}>
              再読み込み
            </button>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}

function getDefaultExerciseMetricType(exerciseName: string): ExerciseMetricType {
  return TIME_BASED_EXERCISES.has(exerciseName) ? 'time' : 'reps'
}

function getSetMetricValue(set: Pick<ExerciseSet, 'weight' | 'reps' | 'durationSec'>, metricType: ExerciseMetricType): number {
  if (metricType === 'time') {
    return set.durationSec ?? set.reps
  }
  return set.reps
}

function getExerciseSetVolume(set: Pick<ExerciseSet, 'weight' | 'reps' | 'durationSec'>, metricType: ExerciseMetricType): number {
  const metricValue = getSetMetricValue(set, metricType)
  if (metricType === 'time') {
    return set.weight > 0 ? set.weight * metricValue : metricValue
  }
  return set.weight * metricValue
}

function resolveExerciseMetricType(exercise: { name: string; metricType?: ExerciseMetricType }): ExerciseMetricType {
  return exercise.metricType ?? getDefaultExerciseMetricType(exercise.name)
}

function getWorkoutSessionVolume(session: WorkoutSession): number {
  return session.exercises.reduce((exerciseSum, exercise) => {
    const metricType = resolveExerciseMetricType(exercise)
    return exerciseSum + exercise.sets.reduce((setSum, set) => setSum + getExerciseSetVolume(set, metricType), 0)
  }, 0)
}

function formatSetLabel(set: Pick<ExerciseSet, 'weight' | 'reps' | 'durationSec'>, metricType: ExerciseMetricType): string {
  const metricValue = getSetMetricValue(set, metricType)
  const metricUnit = metricType === 'time' ? '秒' : '回'
  if (set.weight > 0) {
    return `${set.weight}kg×${metricValue}${metricUnit}`
  }
  return `${metricValue}${metricUnit}`
}

const EXERCISE_INFO: Record<string, string> = {
  ベンチプレス: 'やり方: 肩甲骨を寄せて胸を張り、バーをみぞおちへ下ろして真上に押す。注意: 手首を寝かせず、反動でバウンドしない。',
  インクラインベンチ: 'やり方: ベンチ角度を30〜45度にして、鎖骨ラインへ下ろして押し上げる。注意: 肘を開きすぎず、肩前に痛みが出る角度を避ける。',
  ダンベルプレス: 'やり方: 胸を張ったまま、肘をやや内側にして下ろし、弧を描くように押し上げる。注意: 下で止めず、常に胸へテンションを残す。',
  ペックフライ: 'やり方: 肘を軽く曲げたまま、抱え込むように閉じる。注意: 肩をすくめず、腕ではなく胸を寄せる意識で行う。',
  チェストプレス: 'やり方: シート高さを胸中部に合わせ、胸を張って押し切る。注意: 肩が前に出ないようにし、戻しをゆっくり行う。',
  ラットプルダウン: 'やり方: 胸を張ってバーを鎖骨へ引き、肩甲骨を下げる。注意: 体を大きく倒して反動で引かない。',
  ローイング: 'やり方: 胸を張ってみぞおち方向へ引き、肘を後ろに運ぶ。注意: 肩をすくめず、首に力を入れすぎない。',
  デッドリフト: 'やり方: 背中を固め、足で床を押してバーを体に沿わせて上げる。注意: 腰を丸めない・バーを体から離しすぎない。',
  チンニング: 'やり方: 肩甲骨を下げてから肘を引き、胸をバーへ近づける。注意: 脚反動で勢いをつけすぎない。',
  ワンハンドロー: 'やり方: 体幹を固定し、肘を腰へ引いて背中を収縮。注意: 肩が前に巻かれないようトップで1秒止める。',
  ショルダープレス: 'やり方: 体幹を締め、耳横を通して真上へ押し上げる。注意: 腰反りで挙げない。',
  サイドレイズ: 'やり方: 肘主導で真横へ持ち上げ、肩の高さ付近で止める。注意: 反動やすくめ肩を避ける。',
  リアレイズ: 'やり方: 前傾して肘を開くように後方へ上げる。注意: 腕で振らず、肩後部で持ち上げる。',
  アップライトロー: 'やり方: バーを体に沿わせ、みぞおち〜胸下あたりまで引く。注意: 高く引きすぎて肩を詰めない。',
  フェイスプル: 'やり方: ロープを顔へ引き、肘を外へ開いて外旋する。注意: 腰反りを抑え、首で引かない。',
  スクワット: 'やり方: 足裏全体で床を押し、股関節と膝を同時に曲げて立ち上がる。注意: 膝が内側に入らないようにする。',
  レッグプレス: 'やり方: 腰をシートにつけたまま押し、膝を伸ばし切る手前で返す。注意: 可動域を浅くしすぎない。',
  レッグカール: 'やり方: かかとをお尻へ引きつける意識で丸める。注意: 戻しで力を抜かずゆっくり下ろす。',
  ブルガリアンスクワット: 'やり方: 前脚に体重を乗せて真下に沈み、かかとで押して戻る。注意: 上体を起こしすぎず、膝を内側に入れない。',
  カーフレイズ: 'やり方: かかとを深く下ろしてからつま先で高く押す。注意: 反動を使わずトップで一瞬止める。',
  アームカール: 'やり方: 肘を体側に固定して巻き上げる。注意: 上体反動を使わない。',
  ハンマーカール: 'やり方: 手のひらを向かい合わせたまま持ち上げる。注意: 肘位置を前後に動かしすぎない。',
  トライセプスプレスダウン: 'やり方: 肘を脇で固定し、下まで押し切る。注意: 肩が前に出ないようにする。',
  フレンチプレス: 'やり方: 肘を閉じて頭上で曲げ伸ばしする。注意: 肘が外に開きすぎないようにする。',
  ディップス: 'やり方: 軽く前傾して下げ、胸と腕で押し上げる。注意: 肩に痛みが出る深さまで下げない。',
  ディクラインプレス: 'やり方: ベンチを下向きにして胸下部へ下ろし、斜め上へ押し返す。注意: 反動を使わず軌道を安定させる。',
  ケーブルフライ: 'やり方: ケーブルを胸の前で抱え込むように閉じる。注意: 肩をすくめず、胸の収縮を優先する。',
  ダンベルフライ: 'やり方: 肘を軽く曲げて大きく開き、胸で閉じる。注意: 深く下ろしすぎて肩前を痛めない。',
  スミスマシンベンチ: 'やり方: バー軌道を固定し、胸に向かって下ろして押す。注意: ベンチ位置を合わせて肩が詰まらない軌道にする。',
  プッシュアップ: 'やり方: 体を一直線に保って胸を床へ近づけ、押し返す。注意: 腰落ちを防ぎ、反動で浅くしない。',
  シーテッドロー: 'やり方: 胸を張ってグリップをお腹へ引く。注意: 腰を丸めず、戻しで肩が抜けないようにする。',
  Tバーロー: 'やり方: 胸を張ったままバーをみぞおちへ引く。注意: 反動で跳ね上げず、背中で受け止める。',
  バーベルロー: 'やり方: 前傾姿勢を保ち、バーを下腹部へ引く。注意: 腰を起こして僧帽ばかりに逃がさない。',
  ストレートアームプルダウン: 'やり方: 腕を伸ばしたまま太ももへ引き下げる。注意: 肘を曲げすぎず広背筋で動かす。',
  プルオーバー: 'やり方: 胸を張ってアーチを描くように頭上から下ろす。注意: 肩をすくめず可動域をコントロールする。',
  アーノルドプレス: 'やり方: 正面から外へ回旋しながら頭上へ押す。注意: 可動域を欲張りすぎて腰を反らさない。',
  フロントレイズ: 'やり方: 肘を軽く曲げたまま肩の高さまで前へ上げる。注意: 反動で持ち上げずゆっくり下ろす。',
  シュラッグ: 'やり方: ダンベルやバーを真上へすくめる。注意: 首をすくめすぎず僧帽筋の上下だけで動かす。',
  ケーブルサイドレイズ: 'やり方: 片手ずつ真横へ持ち上げる。注意: 手首で振らず、三角筋中部で受ける。',
  マシンショルダープレス: 'やり方: シートを合わせて耳横から押し上げる。注意: 肩をすくめず戻しを丁寧に。',
  ルーマニアンデッドリフト: 'やり方: 膝を軽く曲げたまま股関節を引き、もも裏の伸びを感じて戻る。注意: 背中を丸めない。',
  レッグエクステンション: 'やり方: すねパッドを押し上げて膝を伸ばす。注意: 勢いで蹴らずトップで一瞬止める。',
  ヒップスラスト: 'やり方: ベンチに背を預け、お尻を締めて真上へ押し上げる。注意: 腰を反らせず股関節伸展で上げる。',
  ハックスクワット: 'やり方: 背中をシートにつけて深くしゃがみ押し上げる。注意: 膝が内側に入らないようにする。',
  ランジ: 'やり方: 一歩踏み出して前脚で床を押し戻る。注意: 上体をぶらさず膝の向きを安定させる。',
  プリーチャーカール: 'やり方: パッドに腕を固定して丁寧に巻き上げる。注意: 反動を使わず下ろしをゆっくり行う。',
  ケーブルカール: 'やり方: 肘を固定して下から引き上げる。注意: 肩を前に出さず二頭筋の収縮を保つ。',
  コンセントレーションカール: 'やり方: 肘を内ももへ当てて一点集中で巻き上げる。注意: 手首でこねず二頭で絞る。',
  スカルクラッシャー: 'やり方: 仰向けで肘を固定し、額付近へ下ろして伸ばす。注意: 肘が開きすぎないようにする。',
  ナローベンチプレス: 'やり方: 手幅を狭めて胸下部へ下ろし押し上げる。注意: 肘を開きすぎず三頭へ乗せる。',
  ハンギングレッグレイズ: 'やり方: ぶら下がったまま骨盤を丸めるように脚を上げる。注意: 勢いだけで振り上げない。',
  クランチ: 'やり方: みぞおちを骨盤へ近づけるように上体を丸める。注意: 首だけで引き上げない。',
  レッグレイズ: 'やり方: 骨盤を後傾させる意識で脚を上げる。注意: 腰反りを作らない。',
  プランク: 'やり方: 頭からかかとまで一直線を保って静止。注意: 腰落ち・お尻上がりを避ける。',
  アブローラー: 'やり方: 腹圧をかけたまま前へ伸ばし、腹筋で戻る。注意: 腰を反らせない。',
  ロシアンツイスト: 'やり方: 体幹を固めたまま左右へ丁寧にひねる。注意: 腕だけで振らない。',
  Vシットアップ: 'やり方: 上体と脚を同時に引き寄せてV字を作る。注意: 首ではなく腹筋で起き上がる。',
  バイシクルクランチ: 'やり方: ひねりながら肘と反対膝を近づける。注意: 足だけを速く動かしすぎない。',
  ケーブルクランチ: 'やり方: ロープを持って肋骨を骨盤へ丸め込む。注意: 腕で引かず腹直筋で縮める。',
  サイドプランク: 'やり方: 体を一直線に保ち、脇腹で支える。注意: 腰が落ちないようにする。',
}

function getExerciseGuidanceSpec(exerciseName: string): ExerciseGuidanceSpec {
  if (['ベンチプレス', 'インクラインベンチ', 'ディクラインプレス', 'スミスマシンベンチ', 'ナローベンチプレス'].includes(exerciseName)) {
    return {
      setup: 'ベンチに仰向けで寝て、足裏を床につける。',
      cue: '肩甲骨を寄せて胸を張り、バーを胸へ下ろして真上へ押し返す。',
      equipment: 'ベンチ / バーベル',
      focus: '胸・三頭筋',
      tip: 'みぞおち付近へ下ろすと肩前に逃げにくい。',
    }
  }

  if (exerciseName === 'ダンベルプレス') {
    return {
      setup: 'ベンチに仰向けで寝て、ダンベルを胸の横に構える。',
      cue: '肘をやや内側へ向けたまま下ろし、弧を描くように押し上げる。',
      equipment: 'ベンチ / ダンベル',
      focus: '胸・三頭筋',
      tip: '下で止まりすぎず、胸の張りを保ったまま往復する。',
    }
  }

  if (exerciseName === 'チェストプレス') {
    return {
      setup: 'マシンに座って背中をシートへつけ、グリップを胸の高さに合わせる。',
      cue: '胸を張ったまま前へ押し切り、戻しはゆっくりコントロールする。',
      equipment: 'チェストプレスマシン',
      focus: '胸・三頭筋',
      tip: 'シートが低すぎると肩に入りやすいので胸中央に合う高さにする。',
    }
  }

  if (exerciseName === 'プッシュアップ') {
    return {
      setup: 'うつ伏せで手を床につき、頭からかかとまで一直線に保つ。',
      cue: '胸を床へ近づけてから、手のひらで床を押して体を持ち上げる。',
      equipment: '自重',
      focus: '胸・三頭筋',
      tip: '腰が落ちるなら可動域を少し浅くして姿勢優先で行う。',
    }
  }

  if (exerciseName === 'ペックフライ') {
    return {
      setup: 'マシンに深く座り、肘を軽く曲げたままパッドを構える。',
      cue: '胸を開いてストレッチし、前で抱え込むように閉じる。',
      equipment: 'ペックフライマシン',
      focus: '胸内側・ストレッチ',
      tip: '肩をすくめず、胸の収縮で閉じる意識を優先する。',
    }
  }

  if (exerciseName === 'ケーブルフライ') {
    return {
      setup: '立って片足を軽く前に出し、胸の横からケーブルを構える。',
      cue: '胸を張ったまま弧を描くように前で手を寄せる。',
      equipment: 'ケーブル',
      focus: '胸内側・ストレッチ',
      tip: '上体をぶらさず、手ではなく胸で閉じる感覚を作る。',
    }
  }

  if (exerciseName === 'ダンベルフライ') {
    return {
      setup: 'ベンチに仰向けで寝て、肘を軽く曲げたまま胸の上に構える。',
      cue: '大きく開いて胸を伸ばし、同じ弧で胸の上へ戻す。',
      equipment: 'ベンチ / ダンベル',
      focus: '胸内側・ストレッチ',
      tip: '肩前が痛むほど深く下ろしすぎない。',
    }
  }

  if (
    [
      'ラットプルダウン',
      'チンニング',
      'ストレートアームプルダウン',
      'プルオーバー',
    ].includes(exerciseName)
  ) {
    const setup =
      exerciseName === 'ラットプルダウン'
        ? 'マシンに座って太ももをパッドで固定し、腕を上へ伸ばしてバーを握る。'
        : exerciseName === 'チンニング'
          ? 'バーにぶら下がり、胸を軽く張ったまま足を組む。'
          : exerciseName === 'ストレートアームプルダウン'
            ? '立って胸を張り、腕を伸ばしたままバーを肩幅で握る。'
            : 'ベンチに仰向けで寝るか、マシンの軌道に合わせて胸を張る。'
    return {
      setup,
      cue: '胸を張ったまま、上から下へ引きつける。',
      equipment: 'ラットマシン / バー',
      focus: '広背筋・大円筋',
      tip: '肩をすくめず、肘を脇へ落とすイメージが有効。',
    }
  }

  if (['ローイング', 'シーテッドロー'].includes(exerciseName)) {
    return {
      setup: '座って足と胸を安定させ、みぞおちへ引ける位置でグリップを握る。',
      cue: '肘を後ろへ引き、背中で重さを受け止める。',
      equipment: 'ケーブル / ダンベル / バー',
      focus: '背中中部・僧帽筋',
      tip: '手で引くより、肘を後方へ運ぶ意識が分かりやすい。',
    }
  }

  if (exerciseName === 'ワンハンドロー') {
    return {
      setup: 'ベンチに片手と片膝を乗せ、背中を床と平行に近づける。',
      cue: '胸を張ったまま、肘を腰へ向けて引き上げる。',
      equipment: 'ベンチ / ダンベル',
      focus: '広背筋・背中中部',
      tip: '肩が前へ巻かれないよう、トップで一瞬止めると効きやすい。',
    }
  }

  if (['Tバーロー', 'バーベルロー'].includes(exerciseName)) {
    return {
      setup: '立って股関節から前傾し、背中を固めたままバーを持つ。',
      cue: '前傾角度を保ったまま下腹部へ引きつける。',
      equipment: 'バー / Tバーマシン',
      focus: '背中中部・広背筋',
      tip: '上体を起こして反動を使うほど狙いがぶれやすい。',
    }
  }

  if (exerciseName === 'フェイスプル') {
    return {
      setup: '立って胸を張り、ロープを顔の高さで握る。',
      cue: '肘を外へ開きながら顔へ引き、肩甲骨を寄せる。',
      equipment: 'ケーブル / ロープ',
      focus: '肩後部・僧帽筋',
      tip: '腰を反らず、ロープを鼻から耳の横へ割るように引く。',
    }
  }

  if (['デッドリフト'].includes(exerciseName)) {
    return {
      setup: '立って足を腰幅に置き、バーをすねの前で握って背中を固める。',
      cue: '股関節から起こし、バーを体に沿わせて持ち上げる。',
      equipment: 'バーベル',
      focus: '背面全体',
      tip: '床を押す意識にすると腰だけで引きにくい。',
    }
  }

  if (['ショルダープレス', 'アーノルドプレス'].includes(exerciseName)) {
    return {
      setup: '座るか立って体幹を締め、ダンベルを耳の横に構える。',
      cue: '耳の横から真上へ押し上げる。',
      equipment: 'ダンベル',
      focus: '三角筋前部・中部',
      tip: 'みぞおちを締めて腰反りを防ぐと安定する。',
    }
  }

  if (exerciseName === 'マシンショルダープレス') {
    return {
      setup: 'マシンに座って背中を預け、グリップを耳の横に合わせる。',
      cue: '肩をすくめず、真上へ押してゆっくり戻す。',
      equipment: 'ショルダープレスマシン',
      focus: '三角筋前部・中部',
      tip: 'シートが低すぎると肘が落ちて肩前に入りやすい。',
    }
  }

  if (['サイドレイズ', 'フロントレイズ', 'ケーブルサイドレイズ', 'アップライトロー', 'シュラッグ'].includes(exerciseName)) {
    return {
      setup: '立って胸を張り、腕を体の横か前に自然に下ろして構える。',
      cue: '反動を抑えて、肩主導で持ち上げる。',
      equipment: 'ダンベル / ケーブル',
      focus: '三角筋・僧帽筋',
      tip: 'トップだけでなく下ろしを丁寧にすると効きが安定する。',
    }
  }

  if (exerciseName === 'リアレイズ') {
    return {
      setup: '軽く前傾して立つかベンチにもたれ、肘を少し曲げて腕を下ろす。',
      cue: '肘を外へ開くように持ち上げ、肩後部を縮める。',
      equipment: 'ダンベル / マシン',
      focus: '肩後部',
      tip: '首ですくめると僧帽に逃げるので、肩を下げたまま動かす。',
    }
  }

  if (['スクワット', 'ランジ'].includes(exerciseName)) {
    return {
      setup: '立って足幅を安定させ、胸を張ってお腹に力を入れる。',
      cue: 'しゃがんで脚で押し返す。',
      equipment: 'バーベル / 自重',
      focus: '大腿四頭筋・臀筋',
      tip: '足裏全体で踏むと膝だけに負担が寄りにくい。',
    }
  }

  if (['レッグプレス', 'ハックスクワット'].includes(exerciseName)) {
    return {
      setup: 'マシンに体を預け、足裏全体でプレートを踏める位置に置く。',
      cue: '深く曲げてから、足裏で押して戻る。',
      equipment: '下半身マシン',
      focus: '大腿四頭筋・臀筋',
      tip: '腰が浮くほど深く入れすぎず、可動域を安定させる。',
    }
  }

  if (exerciseName === 'ブルガリアンスクワット') {
    return {
      setup: '後ろ足をベンチへ乗せ、前脚に体重を乗せて立つ。',
      cue: '真下へ沈み、前脚のかかとで床を押して戻る。',
      equipment: 'ベンチ / ダンベル',
      focus: '大腿四頭筋・臀筋',
      tip: '前脚の膝が内へ入らない位置で繰り返す。',
    }
  }

  if (['レッグエクステンション', 'カーフレイズ'].includes(exerciseName)) {
    return {
      setup: exerciseName === 'レッグエクステンション'
        ? 'マシンに座って膝の軸とマシンの軸を合わせる。'
        : '立つかマシンに乗り、つま先の真下に重心を置く。',
      cue: '狙う筋肉で押し切り、戻しもゆっくりコントロールする。',
      equipment: '下半身マシン / 自重',
      focus: exerciseName === 'レッグエクステンション' ? '大腿四頭筋' : 'ふくらはぎ',
      tip: '反動ではなく、トップと下ろしのコントロールで効かせる。',
    }
  }

  if (['ルーマニアンデッドリフト', 'ヒップスラスト', 'レッグカール'].includes(exerciseName)) {
    return {
      setup:
        exerciseName === 'ヒップスラスト'
          ? 'ベンチに背中を預け、足裏を床につけて骨盤を正面へ向ける。'
          : exerciseName === 'レッグカール'
            ? 'マシンにうつ伏せまたは座って、膝の軸を合わせる。'
            : '立って股関節から折れ、バーをももの前で持つ。',
      cue: 'お尻ともも裏を伸ばして戻す。',
      equipment: 'バーベル / マシン',
      focus: 'ハム・臀筋',
      tip: '股関節から折る意識を持つと狙いがぶれにくい。',
    }
  }

  if (['アームカール', 'ハンマーカール', 'ケーブルカール'].includes(exerciseName)) {
    return {
      setup: '立って肘を体の横へ固定し、手のひらを前か内側へ向けて構える。',
      cue: '肘位置を保ったまま、前腕だけを巻き上げる。',
      equipment: 'ダンベル / ケーブル',
      focus: '上腕二頭筋',
      tip: '肩が前へ出ると二頭から負荷が抜けやすい。',
    }
  }

  if (['プリーチャーカール', 'コンセントレーションカール'].includes(exerciseName)) {
    return {
      setup:
        exerciseName === 'プリーチャーカール'
          ? 'パッドに上腕を固定して座り、脇を浮かせないよう構える。'
          : '座って肘を内ももへ当て、前腕が自由に動く姿勢を作る。',
      cue: '上腕を固定したまま、前腕だけを丁寧に巻き上げる。',
      equipment: 'ベンチ / パッド / ダンベル',
      focus: '上腕二頭筋',
      tip: '反動が使えないぶん、下ろしをゆっくり行うと効きやすい。',
    }
  }

  if (['トライセプスプレスダウン', 'ディップス'].includes(exerciseName)) {
    return {
      setup:
        exerciseName === 'トライセプスプレスダウン'
          ? '立って肘を脇で固定し、バーやロープを胸の前で握る。'
          : '平行バーに体を預け、肩をすくめず軽く前傾する。',
      cue: '肘を支点にして押し切り、戻しも肘位置を変えずに行う。',
      equipment: 'ケーブル / 自重',
      focus: '上腕三頭筋',
      tip: '肩ごと押し下げるのではなく、肘の曲げ伸ばしに集中する。',
    }
  }

  if (['フレンチプレス', 'スカルクラッシャー'].includes(exerciseName)) {
    return {
      setup:
        exerciseName === 'フレンチプレス'
          ? '座るか立って、ダンベルを頭上に構えて肘を正面へ向ける。'
          : 'ベンチに仰向けで寝て、バーやダンベルを胸の上に構える。',
      cue: '上腕をなるべく固定し、肘の曲げ伸ばしだけで上げ下げする。',
      equipment: 'ダンベル / EZバー / ベンチ',
      focus: '上腕三頭筋',
      tip: '肘が外へ開きすぎると肩や胸へ逃げやすい。',
    }
  }

  if (['クランチ', 'Vシットアップ', 'ケーブルクランチ'].includes(exerciseName)) {
    return {
      setup:
        exerciseName === 'ケーブルクランチ'
          ? 'ひざ立ちでロープを頭の横に構え、骨盤を軽く立てる。'
          : '床かマットに仰向けで寝て、みぞおちを丸めやすい姿勢を作る。',
      cue: 'みぞおちを骨盤へ近づけるように腹筋を縮める。',
      equipment: '自重 / ケーブル',
      focus: '腹直筋',
      tip: '首だけを曲げず、肋骨をたたむ意識で行う。',
    }
  }

  if (['レッグレイズ', 'ハンギングレッグレイズ'].includes(exerciseName)) {
    return {
      setup:
        exerciseName === 'ハンギングレッグレイズ'
          ? 'バーにぶら下がり、肩を下げて体を安定させる。'
          : '床やベンチに仰向けで寝て、腰を浮かせない位置を作る。',
      cue: '脚を上げるより、骨盤を丸めて下腹部を縮める。',
      equipment: 'バー / 自重',
      focus: '下腹部・腸腰筋',
      tip: '振り上げると腹から抜けるので、反動を抑えて行う。',
    }
  }

  if (['プランク', 'アブローラー', 'サイドプランク'].includes(exerciseName)) {
    return {
      setup:
        exerciseName === 'サイドプランク'
          ? '横向きで前腕か手を床につき、体を一直線に持ち上げる。'
          : 'うつ伏せ姿勢から前腕かローラーを床につき、体を一直線に保つ。',
      cue: '体幹を一直線に固めたまま、腹圧を抜かずに支え続ける。',
      equipment: '自重 / ローラー',
      focus: '体幹全体',
      tip: '腰が落ちる前に止める方がフォームは安定する。',
    }
  }

  return {
    setup: '座るか床に体を預け、体幹を安定させた姿勢から始める。',
    cue: '体幹を固定して左右へひねる。',
    equipment: '自重 / プレート',
    focus: '腹斜筋',
    tip: 'ひねる前に姿勢を固めると脇腹に入りやすい。',
  }
}

function splitExerciseInfo(text: string): { method: string; caution: string } {
  const [methodPart, cautionPart] = text.split('注意:')
  return {
    method: methodPart.replace('やり方:', '').trim(),
    caution: (cautionPart ?? '').trim(),
  }
}

function ExerciseTextGuide({ exerciseName }: { exerciseName: string }) {
  const { setup, cue, equipment, focus, tip } = getExerciseGuidanceSpec(exerciseName)

  return (
    <div className="exercise-guide-card">
      <div className="exercise-guide-meta">
        <span className="guide-tag">姿勢: {setup}</span>
        <span className="guide-tag">狙い: {focus}</span>
        <span className="guide-tag">器具: {equipment}</span>
      </div>
      <p className="exercise-guide-lead">{cue}</p>
      <p className="exercise-guide-tip">
        <strong>コツ</strong> {tip}
      </p>
    </div>
  )
}

function createSet(index: number): ExerciseSet {
  return {
    id: `${Date.now()}-${index}`,
    weight: 60,
    reps: 10,
  }
}

function cloneSetDrafts(sets: Array<Pick<ExerciseSet, 'weight' | 'reps' | 'durationSec'>>): ExerciseSet[] {
  return sets.map((set, index) => ({
    id: `${Date.now()}-${index}`,
    weight: set.weight,
    reps: set.reps,
    durationSec: set.durationSec,
  }))
}

function getExerciseDraftKey(bodyPart: BodyPart, exerciseName: string): string {
  return `${bodyPart}:${exerciseName}`
}

function buildNumberOptions(min: number, max: number, step: number): number[] {
  const decimals = Number.isInteger(step) ? 0 : 1
  const count = Math.floor((max - min) / step) + 1
  return Array.from({ length: count }, (_, index) => Number((min + step * index).toFixed(decimals)))
}

function getNearestOption(options: number[], value: number): number {
  if (options.length === 0) {
    return value
  }

  return options.reduce((closest, option) =>
    Math.abs(option - value) < Math.abs(closest - value) ? option : closest,
  )
}

function getExerciseInputProfile(exerciseName: string): ExerciseInputProfile {
  if (
    [
      'ベンチプレス',
      'インクラインベンチ',
      'ディクラインプレス',
      'スミスマシンベンチ',
      'ナローベンチプレス',
      'バーベルロー',
      'Tバーロー',
      'デッドリフト',
      'スクワット',
      'ルーマニアンデッドリフト',
      'ヒップスラスト',
      'ハックスクワット',
    ].includes(exerciseName)
  ) {
    return {
      defaultWeight: 60,
      defaultReps: 8,
      defaultDurationSec: 60,
      defaultRestSeconds: 150,
      weightMin: 0,
      weightMax: 300,
      weightStep: 2.5,
      repMin: 1,
      repMax: 15,
      repStep: 1,
      durationMin: 15,
      durationMax: 240,
      durationStep: 5,
    }
  }

  if (
    [
      'チェストプレス',
      'ラットプルダウン',
      'ローイング',
      'シーテッドロー',
      'ショルダープレス',
      'マシンショルダープレス',
      'レッグプレス',
      'レッグカール',
      'レッグエクステンション',
      'トライセプスプレスダウン',
      'ケーブルクランチ',
    ].includes(exerciseName)
  ) {
    return {
      defaultWeight: 40,
      defaultReps: 10,
      defaultDurationSec: 60,
      defaultRestSeconds: 105,
      weightMin: 0,
      weightMax: 240,
      weightStep: 5,
      repMin: 4,
      repMax: 20,
      repStep: 1,
      durationMin: 15,
      durationMax: 240,
      durationStep: 5,
    }
  }

  if (
    [
      'ダンベルプレス',
      'ペックフライ',
      'ケーブルフライ',
      'ダンベルフライ',
      'ワンハンドロー',
      'プルオーバー',
      'アーノルドプレス',
      'サイドレイズ',
      'リアレイズ',
      'アップライトロー',
      'フェイスプル',
      'フロントレイズ',
      'シュラッグ',
      'ケーブルサイドレイズ',
      'ブルガリアンスクワット',
      'カーフレイズ',
      'アームカール',
      'ハンマーカール',
      'フレンチプレス',
      'プリーチャーカール',
      'ケーブルカール',
      'コンセントレーションカール',
      'スカルクラッシャー',
      'ストレートアームプルダウン',
    ].includes(exerciseName)
  ) {
    return {
      defaultWeight: 10,
      defaultReps: 12,
      defaultDurationSec: 45,
      defaultRestSeconds: 75,
      weightMin: 0,
      weightMax: 80,
      weightStep: 1,
      repMin: 6,
      repMax: 25,
      repStep: 1,
      durationMin: 10,
      durationMax: 180,
      durationStep: 5,
    }
  }

  if (
    [
      'プッシュアップ',
      'チンニング',
      'ディップス',
      'ランジ',
      'ハンギングレッグレイズ',
      'クランチ',
      'レッグレイズ',
      'プランク',
      'アブローラー',
      'ロシアンツイスト',
      'Vシットアップ',
      'バイシクルクランチ',
      'サイドプランク',
    ].includes(exerciseName)
  ) {
    return {
      defaultWeight: 0,
      defaultReps: ['プランク', 'サイドプランク'].includes(exerciseName) ? 1 : 12,
      defaultDurationSec: ['プランク', 'サイドプランク'].includes(exerciseName) ? 45 : 60,
      defaultRestSeconds: 60,
      weightMin: 0,
      weightMax: 40,
      weightStep: 1,
      repMin: 1,
      repMax: 30,
      repStep: 1,
      durationMin: 10,
      durationMax: 300,
      durationStep: 5,
    }
  }

  return {
    defaultWeight: 20,
    defaultReps: 10,
    defaultDurationSec: 60,
    defaultRestSeconds: 90,
    weightMin: 0,
    weightMax: 120,
    weightStep: 2.5,
    repMin: 4,
    repMax: 20,
    repStep: 1,
    durationMin: 15,
    durationMax: 240,
    durationStep: 5,
  }
}

function getPickerOptionsForExercise(exerciseName: string, key: PickerTargetKey): number[] {
  const profile = getExerciseInputProfile(exerciseName)
  if (key === 'weight') {
    return buildNumberOptions(profile.weightMin, profile.weightMax, profile.weightStep)
  }
  if (key === 'duration') {
    return buildNumberOptions(profile.durationMin, profile.durationMax, profile.durationStep)
  }
  return buildNumberOptions(profile.repMin, profile.repMax, profile.repStep)
}

function createDefaultSetsForExercise(exerciseName: string, metricType: ExerciseMetricType = getDefaultExerciseMetricType(exerciseName)): ExerciseSet[] {
  const profile = getExerciseInputProfile(exerciseName)
  return Array.from({ length: 3 }, (_, index) => ({
    id: `${Date.now()}-${index}`,
    weight: profile.defaultWeight,
    reps: metricType === 'time' ? profile.defaultDurationSec : profile.defaultReps,
    durationSec: metricType === 'time' ? profile.defaultDurationSec : undefined,
  }))
}

function loadExercisePreferences(): Record<string, ExercisePreference> {
  if (typeof window === 'undefined') {
    return {}
  }

  const raw = window.localStorage.getItem(EXERCISE_PREFERENCES_STORAGE_KEY)
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, ExercisePreference>
    return parsed ?? {}
  } catch (error) {
    console.error('Failed to load exercise preferences', error)
    window.localStorage.removeItem(EXERCISE_PREFERENCES_STORAGE_KEY)
    return {}
  }
}

function loadExerciseNotes(): Record<string, string> {
  if (typeof window === 'undefined') {
    return {}
  }

  const raw = window.localStorage.getItem(EXERCISE_NOTES_STORAGE_KEY)
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed ?? {}
  } catch (error) {
    console.error('Failed to load exercise notes', error)
    window.localStorage.removeItem(EXERCISE_NOTES_STORAGE_KEY)
    return {}
  }
}

function createEmptyCustomExercisesByBodyPart(): Record<BodyPart, string[]> {
  return BODY_PARTS.reduce((accumulator, part) => {
    accumulator[part] = []
    return accumulator
  }, {} as Record<BodyPart, string[]>)
}

function loadCustomExercisesByBodyPart(): Record<BodyPart, string[]> {
  if (typeof window === 'undefined') {
    return createEmptyCustomExercisesByBodyPart()
  }

  const raw = window.localStorage.getItem(CUSTOM_EXERCISES_STORAGE_KEY)
  if (!raw) {
    return createEmptyCustomExercisesByBodyPart()
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Record<BodyPart, string[]>>
    const next = createEmptyCustomExercisesByBodyPart()
    BODY_PARTS.forEach((part) => {
      const entries = parsed[part]
      if (!Array.isArray(entries)) {
        return
      }
      next[part] = Array.from(
        new Set(
          entries
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      )
    })
    return next
  } catch (error) {
    console.error('Failed to load custom exercises', error)
    window.localStorage.removeItem(CUSTOM_EXERCISES_STORAGE_KEY)
    return createEmptyCustomExercisesByBodyPart()
  }
}

function mergeCustomExercisesByBodyPart(
  localExercises: Record<BodyPart, string[]>,
  remoteExercises: Record<BodyPart, string[]>,
) {
  const merged = createEmptyCustomExercisesByBodyPart()
  BODY_PARTS.forEach((part) => {
    merged[part] = Array.from(
      new Set([...(localExercises[part] ?? []), ...(remoteExercises[part] ?? [])].map((value) => value.trim()).filter(Boolean)),
    )
  })
  return merged
}

function normalizeCustomExercisesByBodyPart(customExercisesByBodyPart: Record<BodyPart, string[]>) {
  const normalized = createEmptyCustomExercisesByBodyPart()
  BODY_PARTS.forEach((part) => {
    normalized[part] = Array.from(
      new Set((customExercisesByBodyPart[part] ?? []).map((value) => value.trim()).filter(Boolean)),
    )
  })
  return normalized
}

function areCustomExercisesEqual(
  left: Record<BodyPart, string[]>,
  right: Record<BodyPart, string[]>,
) {
  return BODY_PARTS.every((part) => {
    const leftValues = left[part] ?? []
    const rightValues = right[part] ?? []
    if (leftValues.length !== rightValues.length) {
      return false
    }
    return leftValues.every((value, index) => value === rightValues[index])
  })
}

function createSession(
  bodyPart: BodyPart,
  exerciseName: string,
  metricType: ExerciseMetricType,
  sets: ExerciseSet[],
): WorkoutSession {
  return {
    id: crypto.randomUUID(),
    date: dayjs().toISOString(),
    bodyPart,
    exercises: [
      {
        id: crypto.randomUUID(),
        name: exerciseName,
        metricType,
        sets: sets.map((set) => ({ ...set })),
      },
    ],
  }
}

function AuthView({
  onDemoStart,
  onLogin,
  onGoogleLogin,
  onStartPhoneLogin,
  onVerifyPhoneCode,
}: {
  onDemoStart: () => void
  onLogin: (email: string, password: string, mode: AuthMode) => Promise<void>
  onGoogleLogin: () => Promise<void>
  onStartPhoneLogin: (phoneNumber: string) => Promise<void>
  onVerifyPhoneCode: (code: string) => Promise<void>
}) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [phoneNumber, setPhoneNumber] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [phonePending, setPhonePending] = useState(false)
  const [phoneCodeSent, setPhoneCodeSent] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    setPending(true)

    try {
      await onLogin(email, password, mode)
      if (mode === 'reset') {
        setMessage('パスワード再設定メールを送信しました。')
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '認証に失敗しました。')
    } finally {
      setPending(false)
    }
  }

  async function handleGoogleSignIn() {
    setError(null)
    setMessage(null)
    setPending(true)

    try {
      await onGoogleLogin()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Googleログインに失敗しました。')
    } finally {
      setPending(false)
    }
  }

  async function handleSendPhoneCode() {
    setError(null)
    setMessage(null)
    setPhonePending(true)

    try {
      await onStartPhoneLogin(phoneNumber)
      setPhoneCodeSent(true)
      setMessage('確認コードを送信しました。SMSの6桁コードを入力してください。')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'SMS送信に失敗しました。')
    } finally {
      setPhonePending(false)
    }
  }

  async function handleVerifyPhoneCode() {
    setError(null)
    setMessage(null)
    setPhonePending(true)

    try {
      await onVerifyPhoneCode(phoneCode)
      setPhoneCodeSent(false)
      setPhoneCode('')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '電話番号認証に失敗しました。')
    } finally {
      setPhonePending(false)
    }
  }

  return (
    <main className="auth-screen">
      <h1>Atlas</h1>
      <p className="subtitle">筋トレを続けたくなるトレーニング管理</p>
      {!isFirebaseConfigured && (
        <div className="notice">
          Firebase未設定です。まず .env に Firebase キーを設定してください。<br />
          設定前でもデモモードで利用できます。
          <button type="button" onClick={onDemoStart}>
            デモモードで続ける
          </button>
        </div>
      )}
      <div className="auth-tabs">
        <button type="button" onClick={() => setMode('login')} className={mode === 'login' ? 'active' : ''}>
          ログイン
        </button>
        <button type="button" onClick={() => setMode('signup')} className={mode === 'signup' ? 'active' : ''}>
          新規登録
        </button>
        <button type="button" onClick={() => setMode('reset')} className={mode === 'reset' ? 'active' : ''}>
          パスワード再設定
        </button>
      </div>
      <form className="card" onSubmit={handleSubmit}>
        <label>
          メールアドレス
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="you@example.com"
            required
          />
        </label>
        {mode !== 'reset' && (
          <label>
            パスワード
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              minLength={6}
              required
            />
          </label>
        )}
        <button type="submit" disabled={pending}>
          {pending ? '処理中...' : mode === 'login' ? 'ログイン' : mode === 'signup' ? '登録する' : 'メール送信'}
        </button>
        {error && <p className="error">{error}</p>}
        {message && <p className="success">{message}</p>}
      </form>

      <section className="card">
        <h3>Googleログイン</h3>
        <button type="button" onClick={() => void handleGoogleSignIn()} disabled={pending}>
          Googleで続ける
        </button>
      </section>

      <section className="card">
        <h3>電話番号ログイン</h3>
        <label>
          電話番号（例: +819012345678）
          <input
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            type="tel"
            placeholder="+81..."
          />
        </label>
        <button type="button" onClick={() => void handleSendPhoneCode()} disabled={phonePending}>
          {phonePending ? '送信中...' : 'SMSコードを送信'}
        </button>

        {phoneCodeSent && (
          <>
            <label>
              認証コード
              <input
                value={phoneCode}
                onChange={(e) => setPhoneCode(e.target.value)}
                placeholder="6桁コード"
              />
            </label>
            <button type="button" onClick={() => void handleVerifyPhoneCode()} disabled={phonePending}>
              {phonePending ? '確認中...' : 'コード確認してログイン'}
            </button>
          </>
        )}
        <div id="recaptcha-container" />
      </section>
    </main>
  )
}

function App() {
  const { sessions, setSessions, addSession, deleteSession: deleteSessionFromStore } = useAtlasStore()
  const [tab, setTab] = useState<AppTab>('home')
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [isDemoMode, setIsDemoMode] = useState(false)
  const [selectedBodyPart, setSelectedBodyPart] = useState<BodyPart>('胸')
  const [selectedExercise, setSelectedExercise] = useState('')
  const [workoutPhase, setWorkoutPhase] = useState<WorkoutPhase>('body')
  const [sets, setSets] = useState<ExerciseSet[]>([createSet(0), createSet(1), createSet(2)])
  const [restSeconds, setRestSeconds] = useState(90)
  const [timerRunning, setTimerRunning] = useState(false)
  const [historyBodyPartFilters, setHistoryBodyPartFilters] = useState<BodyPart[]>([])
  const [historyExerciseFilters, setHistoryExerciseFilters] = useState<string[]>([])
  const [isHistorySelectionMode, setIsHistorySelectionMode] = useState(false)
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([])
  const [isHistoryDeleteConfirming, setIsHistoryDeleteConfirming] = useState(false)
  const [isDeletingHistory, setIsDeletingHistory] = useState(false)
  const [historyMonthCursor, setHistoryMonthCursor] = useState(() => dayjs().startOf('month').format('YYYY-MM-DD'))
  const [historySelectedDate, setHistorySelectedDate] = useState<string | null>(null)
  const [historyOpenDates, setHistoryOpenDates] = useState<string[]>([])
  const [analyticsWindowDays, setAnalyticsWindowDays] = useState<7 | 30>(7)
  const [exerciseSearchQuery, setExerciseSearchQuery] = useState('')
  const [customExerciseInput, setCustomExerciseInput] = useState('')
  const [customExercisesByBodyPart, setCustomExercisesByBodyPart] = useState<
    Record<BodyPart, string[]>
  >(loadCustomExercisesByBodyPart)
  const [isCustomExercisesHydrated, setIsCustomExercisesHydrated] = useState(false)
  const [exerciseNotes, setExerciseNotes] = useState<Record<string, string>>(loadExerciseNotes)
  const [exerciseNoteDraft, setExerciseNoteDraft] = useState('')
  const [syncStatus, setSyncStatus] = useState('ローカル保存')
  const [isProUnlocked, setIsProUnlocked] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(PRO_UNLOCKED_STORAGE_KEY) === '1'
  })
  const [exerciseInfoTarget, setExerciseInfoTarget] = useState<string | null>(null)
  const [exerciseRenameDraft, setExerciseRenameDraft] = useState('')
  const [isExerciseDeleteConfirming, setIsExerciseDeleteConfirming] = useState(false)
  const [pickerTarget, setPickerTarget] = useState<{ setId: string; key: PickerTargetKey } | null>(null)
  const [pickerValue, setPickerValue] = useState(0)
  const [isSavingWorkout, setIsSavingWorkout] = useState(false)
  const [toastState, setToastState] = useState<{ message: string; tone: 'default' | 'error' } | null>(null)
  const [isRestTimerExpanded, setIsRestTimerExpanded] = useState(false)
  const [restTimerNotice, setRestTimerNotice] = useState<string | null>(null)
  const [restTimerOffset, setRestTimerOffset] = useState({ x: 0, y: 0 })
  const [exerciseSetDrafts, setExerciseSetDrafts] = useState<
    Record<string, Array<Pick<ExerciseSet, 'weight' | 'reps' | 'durationSec'>>>
  >({})
  const [exercisePreferences, setExercisePreferences] = useState<Record<string, ExercisePreference>>(
    loadExercisePreferences,
  )
  const wheelListRef = useRef<HTMLDivElement | null>(null)
  const wheelScrollTimerRef = useRef<number | null>(null)
  const lastWheelHapticValueRef = useRef<number | null>(null)
  const pickerOpenValueRef = useRef(0)
  const toastTimerRef = useRef<number | null>(null)
  const restTimerNoticeRef = useRef<number | null>(null)
  const restTimerFloatingRef = useRef<HTMLDivElement | null>(null)
  const restTimerDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    dragged: boolean
  } | null>(null)
  const previousStreakDaysRef = useRef<number | null>(null)
  const recaptchaRef = useRef<RecaptchaVerifier | null>(null)
  const previousMainTabRef = useRef<MainTab>('home')
  const [phoneConfirmation, setPhoneConfirmation] = useState<ConfirmationResult | null>(null)

  useEffect(() => {
    if (!auth) {
      setLoading(false)
      return
    }

    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    const activateAudioContext = () => {
      void prepareAudioContext()
    }

    window.addEventListener('pointerdown', activateAudioContext, { passive: true })
    window.addEventListener('touchstart', activateAudioContext, { passive: true })
    window.addEventListener('keydown', activateAudioContext)

    return () => {
      window.removeEventListener('pointerdown', activateAudioContext)
      window.removeEventListener('touchstart', activateAudioContext)
      window.removeEventListener('keydown', activateAudioContext)
    }
  }, [])

  useEffect(() => {
    if (!timerRunning) {
      return
    }

    const timer = window.setInterval(() => {
      setRestSeconds((previous) => {
        if (previous <= 1) {
          window.clearInterval(timer)
          setTimerRunning(false)
          triggerHaptic([40, 60, 40, 60, 40])
          playTimerEndSound()
          showRestTimerNotice('⏱️ 休憩終了！次セットいこう')
          return 0
        }

        return previous - 1
      })
    }, 1000)

    return () => window.clearInterval(timer)
  }, [timerRunning])

  useEffect(() => {
    setSelectedExercise('')
    setExerciseSearchQuery('')
  }, [selectedBodyPart])

  useEffect(() => {
    if (workoutPhase !== 'record') {
      resetCompleteConfirm()
    }
  }, [workoutPhase])

  useEffect(() => {
    if (tab !== 'workout') {
      resetCompleteConfirm()
      setPickerTarget(null)
    }
  }, [tab])

  useEffect(() => {
    if (tab !== 'history') {
      setIsHistorySelectionMode(false)
      setSelectedHistoryIds([])
      setIsHistoryDeleteConfirming(false)
      setHistoryBodyPartFilters([])
      setHistoryExerciseFilters([])
    }
  }, [tab])

  useEffect(() => {
    if (!historySelectedDate) {
      return
    }

    const selected = dayjs(historySelectedDate)
    const cursor = dayjs(historyMonthCursor)
    if (!selected.isSame(cursor, 'month')) {
      setHistorySelectedDate(null)
    }
  }, [historyMonthCursor, historySelectedDate])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(EXERCISE_PREFERENCES_STORAGE_KEY, JSON.stringify(exercisePreferences))
  }, [exercisePreferences])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(EXERCISE_NOTES_STORAGE_KEY, JSON.stringify(exerciseNotes))
  }, [exerciseNotes])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(CUSTOM_EXERCISES_STORAGE_KEY, JSON.stringify(customExercisesByBodyPart))
  }, [customExercisesByBodyPart])

  useEffect(() => {
    if (!db || !user || isDemoMode) {
      setIsCustomExercisesHydrated(true)
      return
    }

    const activeDb = db
    const uid = user.uid
    setIsCustomExercisesHydrated(false)

    const unsubscribeCustomExercises = subscribeCustomExercises(activeDb, uid, (remoteCustomExercises) => {
      if (remoteCustomExercises) {
        setCustomExercisesByBodyPart((current) => {
          const merged = mergeCustomExercisesByBodyPart(current, normalizeCustomExercisesByBodyPart(remoteCustomExercises))
          return areCustomExercisesEqual(current, merged) ? current : merged
        })
      }
      setIsCustomExercisesHydrated(true)
    })

    return () => {
      unsubscribeCustomExercises()
    }
  }, [db, isDemoMode, user])

  useEffect(() => {
    if (!db || !user || isDemoMode || !isCustomExercisesHydrated) {
      return
    }

    const activeDb = db
    const uid = user.uid
    const payload = normalizeCustomExercisesByBodyPart(customExercisesByBodyPart)

    void saveCustomExercises(activeDb, uid, payload)
      .then(() => {
        setSyncStatus('クラウド同期済み')
      })
      .catch(() => {
        queueCustomExercisesSave(payload)
        setSyncStatus('同期待機中...')
        showToast('種目リストの同期に失敗しました。再試行します', 'error')
      })
  }, [customExercisesByBodyPart, db, isCustomExercisesHydrated, isDemoMode, user])

  useEffect(() => {
    if (!exerciseInfoTarget) {
      setExerciseNoteDraft('')
      setExerciseRenameDraft('')
      setIsExerciseDeleteConfirming(false)
      return
    }
    setExerciseNoteDraft(exerciseNotes[exerciseInfoTarget] ?? '')
    setExerciseRenameDraft(exerciseInfoTarget)
  }, [exerciseInfoTarget, exerciseNotes])

  useEffect(() => {
    if (workoutPhase !== 'record') {
      return
    }

    setExerciseSetDrafts((previous) => ({
      ...previous,
      [getExerciseDraftKey(selectedBodyPart, selectedExercise)]: sets.map((set) => ({
        weight: set.weight,
        reps: set.reps,
        durationSec: set.durationSec,
      })),
    }))
  }, [selectedBodyPart, selectedExercise, sets, workoutPhase])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
      if (restTimerNoticeRef.current) {
        window.clearTimeout(restTimerNoticeRef.current)
      }
      if (wheelScrollTimerRef.current) {
        window.clearTimeout(wheelScrollTimerRef.current)
      }
    }
  }, [])

  const pickerOptions = useMemo(() => {
    if (!pickerTarget) {
      return []
    }

    return getPickerOptionsForExercise(selectedExercise, pickerTarget.key)
  }, [pickerTarget, selectedExercise])

  useEffect(() => {
    if (!pickerTarget || pickerOptions.length === 0) {
      return
    }

    const selectedIndex = Math.max(0, pickerOptions.indexOf(pickerOpenValueRef.current))
    window.requestAnimationFrame(() => {
      if (!wheelListRef.current) {
        return
      }

      scrollWheelToIndex(selectedIndex, 'auto')
    })
  }, [pickerOptions, pickerTarget])

  useEffect(() => {
    if (!db || !user || isDemoMode) {
      setSyncStatus('ローカル保存')
      return
    }

    const activeDb = db
    const uid = user.uid

    setSyncStatus('クラウド同期中...')
    const unsubscribeSessions = subscribeSessions(activeDb, uid, (nextSessions) => {
      const mergedSessions = mergeWorkoutSessions(useAtlasStore.getState().sessions, nextSessions)
      setSessions(mergedSessions)
      setSyncStatus('クラウド同期済み')
    })

    const flushSyncQueue = () => {
      void flushPendingSyncOps(activeDb, uid, ({ remaining }) => {
        if (remaining > 0) {
          setSyncStatus('クラウド同期待機中...')
          return
        }
        setSyncStatus('クラウド同期済み')
      })
    }

    flushSyncQueue()

    const handleOnline = () => {
      flushSyncQueue()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        flushSyncQueue()
      }
    }

    window.addEventListener('online', handleOnline)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      unsubscribeSessions()
      window.removeEventListener('online', handleOnline)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [db, isDemoMode, setSessions, user])

  const canUseApp = Boolean(user) || isDemoMode

  const historyMonth = useMemo(() => dayjs(historyMonthCursor), [historyMonthCursor])

  const historySessionsByDate = useMemo(() => {
    const map = new Map<string, WorkoutSession[]>()
    sessions.forEach((session) => {
      const dateKey = dayjs(session.date).format('YYYY-MM-DD')
      const bucket = map.get(dateKey) ?? []
      bucket.push(session)
      map.set(dateKey, bucket)
    })
    return map
  }, [sessions])

  const historyCalendarDays = useMemo(() => {
    const start = historyMonth.startOf('month').startOf('week')
    const end = historyMonth.endOf('month').endOf('week')
    const days: Array<{ key: string; dayLabel: string; isCurrentMonth: boolean; sessionCount: number }> = []
    let cursor = start
    while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
      const key = cursor.format('YYYY-MM-DD')
      days.push({
        key,
        dayLabel: cursor.format('D'),
        isCurrentMonth: cursor.isSame(historyMonth, 'month'),
        sessionCount: historySessionsByDate.get(key)?.length ?? 0,
      })
      cursor = cursor.add(1, 'day')
    }
    return days
  }, [historyMonth, historySessionsByDate])

  const historyBaseFiltered = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf())
    return sorted.filter((session) => {
      const dateText = dayjs(session.date).format('YYYY-MM-DD')
      if (historySelectedDate) {
        return dateText === historySelectedDate
      }

      return dayjs(session.date).isSame(historyMonth, 'month')
    })
  }, [historyMonth, historySelectedDate, sessions])

  const historyBodyPartCounts = useMemo(() => {
    const counts = new Map<BodyPart, number>()
    BODY_PARTS.forEach((part) => counts.set(part, 0))
    historyBaseFiltered.forEach((session) => {
      counts.set(session.bodyPart, (counts.get(session.bodyPart) ?? 0) + 1)
    })
    return counts
  }, [historyBaseFiltered])

  const historyBodyPartFiltered = useMemo(() => {
    if (historyBodyPartFilters.length === 0) {
      return historyBaseFiltered
    }
    return historyBaseFiltered.filter((session) => historyBodyPartFilters.includes(session.bodyPart))
  }, [historyBaseFiltered, historyBodyPartFilters])

  const historyExerciseCounts = useMemo(() => {
    const counts = new Map<string, number>()
    historyBodyPartFiltered.forEach((session) => {
      session.exercises.forEach((exercise) => {
        counts.set(exercise.name, (counts.get(exercise.name) ?? 0) + 1)
      })
    })
    return counts
  }, [historyBodyPartFiltered])

  const historyExerciseChips = useMemo(() => {
    return Array.from(historyExerciseCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }))
  }, [historyExerciseCounts])

  const groupedHistory = useMemo(() => {
    if (historyExerciseFilters.length === 0) {
      return historyBodyPartFiltered
    }
    return historyBodyPartFiltered.filter((session) =>
      session.exercises.some((exercise) => historyExerciseFilters.includes(exercise.name)),
    )
  }, [historyBodyPartFiltered, historyExerciseFilters])

  const visibleHistoryIds = useMemo(() => groupedHistory.map((session) => session.id), [groupedHistory])
  const isAllVisibleHistorySelected = useMemo(
    () => visibleHistoryIds.length > 0 && selectedHistoryIds.length === visibleHistoryIds.length,
    [selectedHistoryIds.length, visibleHistoryIds],
  )

  const historyDateSections = useMemo(() => {
    const sections = new Map<
      string,
      {
        date: string
        sessions: WorkoutSession[]
        sessionCount: number
        totalVolume: number
      }
    >()

    groupedHistory.forEach((session) => {
      const dateKey = dayjs(session.date).format('YYYY-MM-DD')
      const existing = sections.get(dateKey)
      const sessionVolume = getWorkoutSessionVolume(session)
      if (!existing) {
        sections.set(dateKey, {
          date: dateKey,
          sessions: [session],
          sessionCount: 1,
          totalVolume: sessionVolume,
        })
        return
      }

      existing.sessions.push(session)
      existing.sessionCount += 1
      existing.totalVolume += sessionVolume
    })

    return Array.from(sections.values()).sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf())
  }, [groupedHistory])

  useEffect(() => {
    setHistoryOpenDates((previous) => {
      const sectionKeys = new Set(historyDateSections.map((section) => section.date))
      const stillOpen = previous.filter((date) => sectionKeys.has(date))
      if (stillOpen.length > 0) {
        return stillOpen
      }

      if (historySelectedDate && sectionKeys.has(historySelectedDate)) {
        return [historySelectedDate]
      }

      return historyDateSections[0] ? [historyDateSections[0].date] : []
    })
  }, [historyDateSections, historySelectedDate])

  useEffect(() => {
    setSelectedHistoryIds((previous) => previous.filter((id) => visibleHistoryIds.includes(id)))
  }, [visibleHistoryIds])

  useEffect(() => {
    setIsHistoryDeleteConfirming(false)
  }, [historyBodyPartFilters, historyExerciseFilters, historySelectedDate, selectedHistoryIds])

  useEffect(() => {
    setHistoryBodyPartFilters((previous) => previous.filter((part) => (historyBodyPartCounts.get(part) ?? 0) > 0))
  }, [historyBodyPartCounts])

  useEffect(() => {
    setHistoryExerciseFilters((previous) => previous.filter((exercise) => historyExerciseCounts.has(exercise)))
  }, [historyExerciseCounts])

  const daysSinceByBodyPart = useMemo(() => {
    const today = dayjs()
    return BODY_PARTS.map((part) => {
      const latestSession = sessions
        .filter((session) => session.bodyPart === part)
        .sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf())[0]
      if (!latestSession) {
        return { part, days: 999, label: '未実施' }
      }

      const days = today.diff(dayjs(latestSession.date), 'day')
      return { part, days, label: `${days}日前` }
    }).sort((a, b) => b.days - a.days)
  }, [sessions])

  const weeklyVolume = useMemo(() => {
    const today = dayjs().startOf('day')
    const dayLabels = ['日', '月', '火', '水', '木', '金', '土']
    const buckets = [0, 0, 0, 0, 0, 0, 0]

    sessions.forEach((session) => {
      const sessionDay = dayjs(session.date).startOf('day')
      const dayDiff = today.diff(sessionDay, 'day')
      if (dayDiff < 0 || dayDiff > 6) {
        return
      }

      const bucketIndex = sessionDay.day()
      const sessionVolume = getWorkoutSessionVolume(session)
      buckets[bucketIndex] += sessionVolume
    })

    return dayLabels.map((label, index) => ({
      label,
      value: buckets[index],
    }))
  }, [sessions])

  const weeklyTotalVolume = useMemo(() => {
    return weeklyVolume.reduce((sum, day) => sum + day.value, 0)
  }, [weeklyVolume])

  const previousWeeklyTotalVolume = useMemo(() => {
    const now = dayjs()
    return sessions
      .filter((session) => {
        const diff = now.diff(dayjs(session.date), 'day')
        return diff >= 7 && diff < 14
      })
      .reduce((sum, session) => sum + getWorkoutSessionVolume(session), 0)
  }, [sessions])

  const weeklyDeltaLabel = useMemo(() => {
    if (previousWeeklyTotalVolume === 0) {
      return weeklyTotalVolume > 0 ? 'NEW' : '0%'
    }

    const delta = ((weeklyTotalVolume - previousWeeklyTotalVolume) / previousWeeklyTotalVolume) * 100
    const rounded = Math.round(delta)
    return `${rounded >= 0 ? '+' : ''}${rounded}%`
  }, [previousWeeklyTotalVolume, weeklyTotalVolume])

  const streakDays = useMemo(() => {
    if (sessions.length === 0) {
      return 0
    }

    const dateSet = new Set(sessions.map((session) => dayjs(session.date).format('YYYY-MM-DD')))
    let cursor = dayjs().startOf('day')
    if (!dateSet.has(cursor.format('YYYY-MM-DD'))) {
      cursor = cursor.subtract(1, 'day')
    }

    let streak = 0
    while (dateSet.has(cursor.format('YYYY-MM-DD'))) {
      streak += 1
      cursor = cursor.subtract(1, 'day')
    }

    return streak
  }, [sessions])

  useEffect(() => {
    const previous = previousStreakDaysRef.current
    if (previous === null) {
      previousStreakDaysRef.current = streakDays
      return
    }

    if (streakDays > previous) {
      showToast(`連続${streakDays}日達成 🔥`)
      triggerHaptic([18, 30, 18])
    }

    previousStreakDaysRef.current = streakDays
  }, [streakDays])

  const weeklyCalories = useMemo(() => {
    const dayLabels = ['日', '月', '火', '水', '木', '金', '土']
    const today = dayjs().startOf('day')
    const dayBuckets: WorkoutSession[][] = [[], [], [], [], [], [], []]
    const strengthMetByBodyPart: Record<BodyPart, number> = {
      胸: 5.2,
      背中: 5.5,
      肩: 4.9,
      脚: 5.8,
      腕: 4.7,
      腹筋: 4.4,
    }
    const assumedBodyWeightKg = 70

    sessions.forEach((session) => {
      const sessionDay = dayjs(session.date).startOf('day')
      const dayDiff = today.diff(sessionDay, 'day')
      if (dayDiff < 0 || dayDiff > 6) {
        return
      }

      dayBuckets[sessionDay.day()].push(session)
    })

    const caloriesByDay = dayLabels.map((label, index) => {
      const daySessions = dayBuckets[index]
      const value = daySessions.reduce((sum, session) => {
        const exerciseCount = session.exercises.length
        const setCount = session.exercises.reduce((acc, exercise) => acc + exercise.sets.length, 0)
        const repCount = session.exercises.reduce((exerciseSum, exercise) => {
          const metricType = resolveExerciseMetricType(exercise)
          return (
            exerciseSum
            + exercise.sets.reduce(
              (setSum, set) =>
                setSum
                + (metricType === 'time'
                  ? Math.max(1, Math.round(getSetMetricValue(set, metricType) / 5))
                  : getSetMetricValue(set, metricType)),
              0,
            )
          )
        }, 0)
        const estimatedMinutes = exerciseCount * 3 + setCount * 2.4 + repCount * 0.08 + 4
        const met = strengthMetByBodyPart[session.bodyPart]
        const sessionCalories = Math.max(
          35,
          Math.min(
            420,
            Math.round(((met * 3.5 * assumedBodyWeightKg) / 200) * estimatedMinutes),
          ),
        )
        return sum + sessionCalories
      }, 0)

      return {
        label,
        value: Math.min(1200, value),
      }
    })
    const total = caloriesByDay.reduce((sum, day) => sum + day.value, 0)
    return { caloriesByDay, total }
  }, [sessions])

  const weeklyCaloriesSummary = useMemo(() => {
    const dayLabels = ['日', '月', '火', '水', '木', '金', '土']
    const todayLabel = dayLabels[dayjs().day()]
    const todayCalories = weeklyCalories.caloriesByDay.find((day) => day.label === todayLabel)?.value ?? 0
    const averageCalories = Math.round(weeklyCalories.total / 7)
    const maxDay = weeklyCalories.caloriesByDay.reduce(
      (best, day) => (day.value > best.value ? day : best),
      weeklyCalories.caloriesByDay[0] ?? { label: todayLabel, value: 0 },
    )
    return {
      todayLabel,
      todayCalories,
      averageCalories,
      maxDay,
      maxValue: Math.max(...weeklyCalories.caloriesByDay.map((item) => item.value), 1),
    }
  }, [weeklyCalories])

  const homeAiMessage = useMemo(() => {
    if (sessions.length === 0) {
      return '最初の1セットを記録して、あなた専用のメッセージを育てよう。'
    }

    const latest = [...sessions].sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf())[0]
    const restDays = dayjs().diff(dayjs(latest.date), 'day')
    const weeklyKcal = weeklyCalories.total
    const raw = `前回は${dayjs(latest.date).format('M/D')}。休養${restDays}日、今週推定${weeklyKcal}kcal。今日はフォームを丁寧に積み上げよう。`
    return raw.length > 72 ? `${raw.slice(0, 72)}…` : raw
  }, [sessions, weeklyCalories.total])

  const latestSessionSummary = useMemo(() => {
    if (sessions.length === 0) {
      return null
    }

    const latest = [...sessions].sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf())[0]
    const totalSets = latest.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0)
    const totalVolume = getWorkoutSessionVolume(latest)
    const restDays = dayjs().diff(dayjs(latest.date), 'day')
    const highlights = latest.exercises.slice(0, 2).map((exercise) => {
      const metricType = resolveExerciseMetricType(exercise)
      const bestSet = exercise.sets.reduce((best, current) => {
        if (current.weight > best.weight) {
          return current
        }
        if (current.weight === best.weight && getSetMetricValue(current, metricType) > getSetMetricValue(best, metricType)) {
          return current
        }
        return best
      }, exercise.sets[0])
      return {
        name: exercise.name,
        bestSetLabel: formatSetLabel(bestSet, metricType),
        setCount: exercise.sets.length,
      }
    })

    return {
      dateLabel: dayjs(latest.date).format('M/D'),
      bodyPart: latest.bodyPart,
      restDaysLabel: restDays === 0 ? '今日実施' : `${restDays}日前`,
      exerciseCount: latest.exercises.length,
      totalSets,
      totalVolume,
      highlights,
      remainingExerciseCount: Math.max(0, latest.exercises.length - highlights.length),
    }
  }, [sessions])

  const latestExerciseSetHistory = useMemo(() => {
    const history = new Map<string, Array<Pick<ExerciseSet, 'weight' | 'reps' | 'durationSec'>>>()
    const sortedSessions = [...sessions].sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf())

    sortedSessions.forEach((session) => {
      session.exercises.forEach((exercise) => {
        const key = getExerciseDraftKey(session.bodyPart, exercise.name)
        if (!history.has(key)) {
          history.set(
            key,
            exercise.sets.map((set) => ({
              weight: set.weight,
              reps: set.reps,
              durationSec: set.durationSec,
            })),
          )
        }
      })
    })

    return history
  }, [sessions])

  const previousExerciseSets = useMemo(() => {
    return latestExerciseSetHistory.get(getExerciseDraftKey(selectedBodyPart, selectedExercise)) ?? []
  }, [latestExerciseSetHistory, selectedBodyPart, selectedExercise])

  const homeLastWorkoutVisibleHighlights = useMemo(
    () => latestSessionSummary?.highlights.slice(0, 1) ?? [],
    [latestSessionSummary],
  )
  const homeLastWorkoutHiddenCount = useMemo(() => {
    if (!latestSessionSummary) {
      return 0
    }
    return latestSessionSummary.exerciseCount - homeLastWorkoutVisibleHighlights.length
  }, [homeLastWorkoutVisibleHighlights.length, latestSessionSummary])

  const exerciseUsageStats = useMemo(() => {
    const stats = new Map<
      string,
      { count: number; lastPerformed: number; metricType: ExerciseMetricType; bestWeight: number; bestMetric: number }
    >()

    sessions
      .filter((session) => session.bodyPart === selectedBodyPart)
      .forEach((session) => {
        const performedAt = dayjs(session.date).valueOf()
        session.exercises.forEach((exercise) => {
          const metricType = exercise.metricType ?? getDefaultExerciseMetricType(exercise.name)
          const sessionBestSet = exercise.sets.reduce((best, set) => {
            if (set.weight > best.weight) {
              return set
            }
            if (set.weight === best.weight && getSetMetricValue(set, metricType) > getSetMetricValue(best, metricType)) {
              return set
            }
            return best
          }, exercise.sets[0])
          const current = stats.get(exercise.name)
          if (!current) {
            stats.set(exercise.name, {
              count: 1,
              lastPerformed: performedAt,
              metricType,
              bestWeight: sessionBestSet.weight,
              bestMetric: getSetMetricValue(sessionBestSet, metricType),
            })
            return
          }

          const hasNewBest =
            sessionBestSet.weight > current.bestWeight ||
            (sessionBestSet.weight === current.bestWeight
              && getSetMetricValue(sessionBestSet, metricType) > current.bestMetric)

          stats.set(exercise.name, {
            count: current.count + 1,
            lastPerformed: Math.max(current.lastPerformed, performedAt),
            metricType,
            bestWeight: hasNewBest ? sessionBestSet.weight : current.bestWeight,
            bestMetric: hasNewBest ? getSetMetricValue(sessionBestSet, metricType) : current.bestMetric,
          })
        })
      })

    return stats
  }, [selectedBodyPart, sessions])

  const filteredExercises = useMemo(() => {
    const query = exerciseSearchQuery.trim()
    // All exercises are user-created: combine library list + exercises found in history
    const allExercises = Array.from(
      new Set([
        ...customExercisesByBodyPart[selectedBodyPart],
        ...Array.from(exerciseUsageStats.keys()),
      ]),
    )
    const originalIndex = new Map(allExercises.map((exercise, index) => [exercise, index]))
    const sortedExercises = [...allExercises].sort((left, right) => {
      const leftStat = exerciseUsageStats.get(left)
      const rightStat = exerciseUsageStats.get(right)
      const countDiff = (rightStat?.count ?? 0) - (leftStat?.count ?? 0)
      if (countDiff !== 0) {
        return countDiff
      }

      const timeDiff = (rightStat?.lastPerformed ?? 0) - (leftStat?.lastPerformed ?? 0)
      if (timeDiff !== 0) {
        return timeDiff
      }

      return (originalIndex.get(left) ?? 0) - (originalIndex.get(right) ?? 0)
    })

    if (!query) {
      return sortedExercises
    }

    return sortedExercises.filter((exercise) => exercise.includes(query))
  }, [customExercisesByBodyPart, exerciseSearchQuery, exerciseUsageStats, selectedBodyPart])

  const bodyPartReadiness = useMemo(() => {
    const readinessMap = new Map<BodyPart, { label: string; tone: BodyPartBadgeTone }>()

    daysSinceByBodyPart.forEach(({ part, days }) => {
      if (days === 999) {
        readinessMap.set(part, { label: '未実施', tone: 'new' })
        return
      }

      if (days === 0) {
        readinessMap.set(part, { label: '今日実施', tone: 'fresh' })
        return
      }

      if (days >= 7) {
        readinessMap.set(part, { label: '空き気味', tone: 'stale' })
        return
      }

      if (days >= 4) {
        readinessMap.set(part, { label: '今日おすすめ', tone: 'ready' })
        return
      }

      readinessMap.set(part, { label: `${days}日休み`, tone: 'fresh' })
    })

    return readinessMap
  }, [daysSinceByBodyPart])

  const selectedExerciseMetricType = useMemo(() => {
    const draftKey = getExerciseDraftKey(selectedBodyPart, selectedExercise)
    return exercisePreferences[draftKey]?.metricType ?? getDefaultExerciseMetricType(selectedExercise)
  }, [exercisePreferences, selectedBodyPart, selectedExercise])

  const hasWorkoutDraft = useMemo(() => {
    return (
      workoutPhase !== 'body' ||
      sets.length !== 3 ||
      sets.some((set, index) => {
        const defaults = createDefaultSetsForExercise(selectedExercise, selectedExerciseMetricType)
        const fallback = defaults[index]
        return !fallback || set.weight !== fallback.weight || set.reps !== fallback.reps
      })
    )
  }, [selectedExercise, selectedExerciseMetricType, sets, workoutPhase])

  const restTimerLabel = `${String(Math.floor(restSeconds / 60)).padStart(2, '0')}:${String(restSeconds % 60).padStart(2, '0')}`
  const shouldShowRestTimerFloating = tab !== 'settings' && (workoutPhase === 'record' || timerRunning)

  useEffect(() => {
    if (!shouldShowRestTimerFloating) {
      setIsRestTimerExpanded(false)
    }
  }, [shouldShowRestTimerFloating])

  useEffect(() => {
    if (!shouldShowRestTimerFloating || !restTimerFloatingRef.current) {
      return
    }

    const rect = restTimerFloatingRef.current.getBoundingClientRect()
    const minGap = 8
    let adjustX = 0
    let adjustY = 0
    if (rect.left < minGap) {
      adjustX = minGap - rect.left
    } else if (rect.right > window.innerWidth - minGap) {
      adjustX = window.innerWidth - minGap - rect.right
    }
    if (rect.top < minGap) {
      adjustY = minGap - rect.top
    } else if (rect.bottom > window.innerHeight - minGap) {
      adjustY = window.innerHeight - minGap - rect.bottom
    }

    if (Math.abs(adjustX) > 0.5 || Math.abs(adjustY) > 0.5) {
      setRestTimerOffset((previous) => ({
        x: previous.x + adjustX,
        y: previous.y + adjustY,
      }))
    }
  }, [isRestTimerExpanded, restTimerOffset, shouldShowRestTimerFloating])

  function vibrateAndSetTab(nextTab: AppTab, pattern: number | number[] = 12) {
    if (nextTab !== tab) {
      triggerHaptic(pattern)
    }
    if (nextTab !== 'settings') {
      previousMainTabRef.current = nextTab
    }
    setTab(nextTab)
  }

  function handleTopSettingsToggle() {
    if (tab === 'settings') {
      triggerHaptic(18)
      setTab(previousMainTabRef.current)
      return
    }
    previousMainTabRef.current = tab
    triggerHaptic(18)
    setTab('settings')
  }

  const selectedExerciseProfile = useMemo(() => getExerciseInputProfile(selectedExercise), [selectedExercise])
  const isInfoTargetInLibrary = useMemo(
    () => !!exerciseInfoTarget && customExercisesByBodyPart[selectedBodyPart].includes(exerciseInfoTarget),
    [customExercisesByBodyPart, exerciseInfoTarget, selectedBodyPart],
  )
  const hasKnownGuide = useMemo(
    () => !!exerciseInfoTarget && !!EXERCISE_INFO[exerciseInfoTarget],
    [exerciseInfoTarget],
  )
  const selectedExerciseGuide = useMemo(
    () => getExerciseGuidanceSpec(exerciseInfoTarget ?? selectedExercise),
    [exerciseInfoTarget, selectedExercise],
  )

  const selectedExerciseInfo = useMemo(() => {
    return splitExerciseInfo(EXERCISE_INFO[exerciseInfoTarget ?? ''] ?? '種目説明は準備中です。')
  }, [exerciseInfoTarget])

  const analytics = useMemo(() => {
    const now = dayjs()
    const sumSessionVolume = (session: WorkoutSession) =>
      session.exercises.reduce((exerciseSum, exercise) => {
        const metricType = exercise.metricType ?? getDefaultExerciseMetricType(exercise.name)
        return exerciseSum + exercise.sets.reduce((setSum, set) => setSum + getExerciseSetVolume(set, metricType), 0)
      }, 0)
    const weeklyTotal = sessions
      .filter((session) => now.diff(dayjs(session.date), 'day') < 7)
      .reduce((sum, session) => sum + sumSessionVolume(session), 0)
    const monthlyTotal = sessions
      .filter((session) => now.diff(dayjs(session.date), 'day') < 31)
      .reduce((sum, session) => sum + sumSessionVolume(session), 0)
    const yearlyTotal = sessions
      .filter((session) => now.diff(dayjs(session.date), 'day') < 366)
      .reduce((sum, session) => sum + sumSessionVolume(session), 0)
    const allTotal = sessions.reduce((sum, session) => sum + sumSessionVolume(session), 0)

    const staleParts = daysSinceByBodyPart.filter((item) => item.days >= 7 && item.days < 999).slice(0, 2)
    const fallbackSummary = [
      staleParts.length > 0
        ? `${staleParts[0].part}が${staleParts[0].days}日空き。次回の優先候補です。`
        : '頻度バランスは良好。次は記録更新を狙いましょう。',
      `直近7日の総負荷は ${weeklyTotal.toLocaleString()}pt です。`,
    ]

    return { weeklyTotal, monthlyTotal, yearlyTotal, allTotal, fallbackSummary }
  }, [daysSinceByBodyPart, sessions])

  const growthRankings = useMemo(() => {
    const now = dayjs().startOf('day')
    const exerciseStats = new Map<
      string,
      {
        metricType: ExerciseMetricType
        currentPeakMetric: number
        previousPeakMetric: number
        currentVolume: number
        previousVolume: number
        lastPerformed: number
      }
    >()

    sessions.forEach((session) => {
      const sessionDay = dayjs(session.date).startOf('day')
      const dayDiff = now.diff(sessionDay, 'day')
      if (dayDiff < 0 || dayDiff >= analyticsWindowDays * 2) {
        return
      }

      const bucket: 'current' | 'previous' = dayDiff < analyticsWindowDays ? 'current' : 'previous'
      session.exercises.forEach((exercise) => {
        const metricType = exercise.metricType ?? getDefaultExerciseMetricType(exercise.name)
        const current = exerciseStats.get(exercise.name) ?? {
          metricType,
          currentPeakMetric: 0,
          previousPeakMetric: 0,
          currentVolume: 0,
          previousVolume: 0,
          lastPerformed: 0,
        }
        const exercisePeak = exercise.sets.reduce((max, set) => Math.max(max, getSetMetricValue(set, metricType)), 0)
        const exerciseVolume = exercise.sets.reduce((sum, set) => sum + getExerciseSetVolume(set, metricType), 0)
        if (bucket === 'current') {
          current.currentPeakMetric = Math.max(current.currentPeakMetric, exercisePeak)
          current.currentVolume += exerciseVolume
          current.lastPerformed = Math.max(current.lastPerformed, sessionDay.valueOf())
        } else {
          current.previousPeakMetric = Math.max(current.previousPeakMetric, exercisePeak)
          current.previousVolume += exerciseVolume
        }
        exerciseStats.set(exercise.name, current)
      })
    })

    const toGrowth = (current: number, previous: number) => {
      if (previous <= 0) {
        if (current <= 0) {
          return { label: '0%', sortScore: 0 }
        }
        return { label: 'NEW', sortScore: 10_000 + current }
      }
      const growth = ((current - previous) / previous) * 100
      const rounded = Math.round(growth)
      return { label: `${rounded >= 0 ? '+' : ''}${rounded}%`, sortScore: growth }
    }

    const ranking = Array.from(exerciseStats.entries())
      .map(([name, stat]) => {
        const weightGrowth = toGrowth(stat.currentPeakMetric, stat.previousPeakMetric)
        const volumeGrowth = toGrowth(stat.currentVolume, stat.previousVolume)
        return {
          name,
          metricType: stat.metricType,
          currentPeakMetric: stat.currentPeakMetric,
          previousPeakMetric: stat.previousPeakMetric,
          currentVolume: stat.currentVolume,
          previousVolume: stat.previousVolume,
          weightGrowthLabel: weightGrowth.label,
          volumeGrowthLabel: volumeGrowth.label,
          weightSortScore: weightGrowth.sortScore,
          volumeSortScore: volumeGrowth.sortScore,
          lastPerformed: stat.lastPerformed,
        }
      })
      .filter((item) => item.currentPeakMetric > 0 || item.currentVolume > 0)

    const sortByScore = (left: { sortScore: number; lastPerformed: number }, right: { sortScore: number; lastPerformed: number }) => {
      const diff = right.sortScore - left.sortScore
      if (diff !== 0) {
        return diff
      }
      return right.lastPerformed - left.lastPerformed
    }

    const weightRanking = [...ranking]
      .sort((left, right) =>
        sortByScore(
          { sortScore: left.weightSortScore, lastPerformed: left.lastPerformed },
          { sortScore: right.weightSortScore, lastPerformed: right.lastPerformed },
        ),
      )
    const volumeRanking = [...ranking]
      .sort((left, right) =>
        sortByScore(
          { sortScore: left.volumeSortScore, lastPerformed: left.lastPerformed },
          { sortScore: right.volumeSortScore, lastPerformed: right.lastPerformed },
        ),
      )

    return {
      weightTop: weightRanking.slice(0, 5),
      weightHiddenCount: Math.max(0, weightRanking.length - 5),
      volumeTop: volumeRanking.slice(0, 5),
      volumeHiddenCount: Math.max(0, volumeRanking.length - 5),
    }
  }, [analyticsWindowDays, sessions])

  const previousWindowVolume = useMemo(() => {
    const now = dayjs()
    return sessions
      .filter((session) => {
        const diff = now.diff(dayjs(session.date), 'day')
        return diff >= analyticsWindowDays && diff < analyticsWindowDays * 2
      })
      .reduce(
        (sum, session) =>
          sum +
          session.exercises.reduce((exerciseSum, exercise) => {
            const metricType = exercise.metricType ?? getDefaultExerciseMetricType(exercise.name)
            return exerciseSum + exercise.sets.reduce((setSum, set) => setSum + getExerciseSetVolume(set, metricType), 0)
          }, 0),
        0,
      )
  }, [analyticsWindowDays, sessions])

  const analyticsLocalSummary = useMemo(() => {
    const currentWindowVolume = analyticsWindowDays === 7 ? analytics.weeklyTotal : analytics.monthlyTotal
    const volumeDeltaLabel =
      previousWindowVolume <= 0
        ? currentWindowVolume > 0
          ? 'NEW'
          : '0%'
        : `${Math.round(((currentWindowVolume - previousWindowVolume) / previousWindowVolume) * 100) >= 0 ? '+' : ''}${Math.round(((currentWindowVolume - previousWindowVolume) / previousWindowVolume) * 100)}%`
    const staleParts = daysSinceByBodyPart.filter((item) => item.days >= 7 && item.days < 999).slice(0, 2)
    const weightLeader = growthRankings.weightTop[0]
    const volumeLeader = growthRankings.volumeTop[0]
    const windowLabel = analyticsWindowDays === 7 ? '直近7日' : '直近30日'

    return [
      `${windowLabel}の総負荷は ${currentWindowVolume.toLocaleString()}pt（前期間比 ${volumeDeltaLabel}）。`,
      weightLeader
        ? `指標伸び率トップは ${weightLeader.name}（${weightLeader.weightGrowthLabel}）。${weightLeader.metricType === 'time' ? '保持時間' : '回数'}は ${weightLeader.previousPeakMetric} → ${weightLeader.currentPeakMetric}。`
        : '指標伸び率の比較対象データがまだ不足しています。',
      volumeLeader
        ? `総負荷伸び率トップは ${volumeLeader.name}（${volumeLeader.volumeGrowthLabel}）。`
        : '総負荷伸び率の比較対象データがまだ不足しています。',
      staleParts.length > 0
        ? `${staleParts.map((item) => `${item.part}${item.days}日空き`).join(' / ')}。次回は優先的に実施推奨。`
        : '部位の休養バランスは良好です。負荷更新フェーズに入れます。',
    ]
  }, [analytics.monthlyTotal, analytics.weeklyTotal, analyticsWindowDays, daysSinceByBodyPart, growthRankings.volumeTop, growthRankings.weightTop, previousWindowVolume])

  const weightRankingInsight = useMemo(() => {
    const top = growthRankings.weightTop
    if (top.length === 0) {
      return 'AI評価: 比較対象データが不足しています。まず同種目を2期間分記録しましょう。'
    }
    const positive = top.filter((item) => item.weightGrowthLabel === 'NEW' || item.weightGrowthLabel.startsWith('+')).length
    const lead = top[0]
    return `AI評価: 上位${top.length}件中${positive}件が伸長。${lead.name}が牽引しています。停滞種目は可動域とセット品質の再確認がおすすめ。`
  }, [growthRankings.weightTop])

  const volumeRankingInsight = useMemo(() => {
    const top = growthRankings.volumeTop
    if (top.length === 0) {
      return 'AI評価: 比較対象データが不足しています。まず同種目を2期間分記録しましょう。'
    }
    const positive = top.filter((item) => item.volumeGrowthLabel === 'NEW' || item.volumeGrowthLabel.startsWith('+')).length
    const lead = top[0]
    return `AI評価: 上位${top.length}件中${positive}件が伸長。${lead.name}は総負荷管理が良好です。疲労感が強い日はセット数や秒数を微調整しましょう。`
  }, [growthRankings.volumeTop])

  const recoveryAlerts = useMemo(() => {
    const alerts: Array<{ severity: 'safe' | 'warn' | 'high'; icon: string; title: string; detail: string }> = []
    const now = dayjs()
    const recentPartCounts = new Map<BodyPart, number>()
    sessions
      .filter((session) => now.diff(dayjs(session.date), 'day') <= 2)
      .forEach((session) => {
        recentPartCounts.set(session.bodyPart, (recentPartCounts.get(session.bodyPart) ?? 0) + 1)
      })

    const overloadParts = Array.from(recentPartCounts.entries())
      .filter(([, count]) => count >= 2)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 2)

    overloadParts.forEach(([part, count]) => {
      alerts.push({
        severity: count >= 3 ? 'high' : 'warn',
        icon: count >= 3 ? '🚨' : '⚠️',
        title: `${part}の負荷が高め`,
        detail: `直近3日で${count}回実施。フォーム重視日または負荷を5〜10%下げた調整日を推奨。`,
      })
    })

    const currentWindowVolume = analyticsWindowDays === 7 ? analytics.weeklyTotal : analytics.monthlyTotal
    if (previousWindowVolume > 0) {
      const increaseRate = ((currentWindowVolume - previousWindowVolume) / previousWindowVolume) * 100
      if (increaseRate >= 25) {
        alerts.push({
          severity: increaseRate >= 40 ? 'high' : 'warn',
          icon: increaseRate >= 40 ? '🔥' : '📈',
          title: '総負荷急上昇',
          detail: `前期間比 +${Math.round(increaseRate)}%。睡眠・栄養・休養を優先し、次回は追い込みすぎを回避。`,
        })
      }
    }

    if (alerts.length === 0) {
      alerts.push({
        severity: 'safe',
        icon: '✅',
        title: '回復バランスは良好',
        detail: '強い過負荷シグナルは検知されませんでした。現状のペースを継続できます。',
      })
    }

    return alerts.slice(0, 3)
  }, [analytics.monthlyTotal, analytics.weeklyTotal, analyticsWindowDays, previousWindowVolume, sessions])

  const bodyPartWindowCounts = useMemo(() => {
    const now = dayjs()
    return BODY_PARTS.map((part) => {
      const count = sessions.filter((session) => {
        const diff = now.diff(dayjs(session.date), 'day')
        return session.bodyPart === part && diff >= 0 && diff < analyticsWindowDays
      }).length
      return { part, count }
    })
  }, [analyticsWindowDays, sessions])

  const bodyPartWindowMaxCount = useMemo(() => {
    return bodyPartWindowCounts.reduce((max, item) => Math.max(max, item.count), 1)
  }, [bodyPartWindowCounts])

  const analyticsNarrativeSummary = useMemo(() => {
    const currentWindowVolume = analyticsWindowDays === 7 ? analytics.weeklyTotal : analytics.monthlyTotal
    const currentWindowSessions = sessions.filter((session) => {
      const diff = dayjs().diff(dayjs(session.date), 'day')
      return diff >= 0 && diff < analyticsWindowDays
    }).length
    const previousWindowSessions = sessions.filter((session) => {
      const diff = dayjs().diff(dayjs(session.date), 'day')
      return diff >= analyticsWindowDays && diff < analyticsWindowDays * 2
    }).length
    const topPart = [...bodyPartWindowCounts].sort((left, right) => right.count - left.count)[0]
    const zeroParts = bodyPartWindowCounts.filter((item) => item.count === 0)
    const sessionDelta = currentWindowSessions - previousWindowSessions
    const volumeTrendPercent =
      previousWindowVolume <= 0
        ? currentWindowVolume > 0
          ? null
          : 0
        : Math.round(((currentWindowVolume - previousWindowVolume) / previousWindowVolume) * 100)

    const persona =
      currentWindowSessions >= 4 && (volumeTrendPercent ?? 0) >= 10
        ? '積み上げ型（頻度×負荷の両輪）'
        : currentWindowSessions <= 2 && currentWindowVolume > 0
          ? '高強度集中型'
          : '安定維持型'

    const action1 =
      sessionDelta >= 2
        ? 'この勢いなら、次の1回はフォーム精度に振るとケガなく伸びます。'
        : sessionDelta <= -2
          ? 'ペースが落ち気味なので、短時間セッションを1回挟むと再加速しやすいです。'
          : '現状のペースは安定。次は弱点部位の1種目追加で伸びしろを作れます。'

    const action2 =
      zeroParts.length > 0
        ? `未実施部位（${zeroParts.map((item) => item.part).join('・')}）を1回入れると、全体の伸びが安定します。`
        : '全主要部位に刺激が入っています。次は苦手種目の指標更新（回数/秒）を狙いましょう。'

    return [
      `あなたの直近傾向は「${persona}」。`,
      topPart ? `主軸は${topPart.part}（${topPart.count}回）。この強みを軸に他部位へ波及させるフェーズです。` : '主軸部位の判定データが不足しています。',
      volumeTrendPercent === null ? '前期間データがないため、今回の記録が新しい基準値になります。' : `総負荷は前期間比 ${volumeTrendPercent >= 0 ? '+' : ''}${volumeTrendPercent}%。`,
      action1,
      action2,
    ]
  }, [analytics.monthlyTotal, analytics.weeklyTotal, analyticsWindowDays, bodyPartWindowCounts, previousWindowVolume, sessions])

  const analyticsSummaryCards = useMemo(() => {
    const currentWindowVolume = analyticsWindowDays === 7 ? analytics.weeklyTotal : analytics.monthlyTotal
    const volumeTrendPercent =
      previousWindowVolume <= 0
        ? currentWindowVolume > 0
          ? null
          : 0
        : Math.round(((currentWindowVolume - previousWindowVolume) / previousWindowVolume) * 100)
    const topPart = [...bodyPartWindowCounts].sort((left, right) => right.count - left.count)[0]
    const topWeight = growthRankings.weightTop[0]

    return [
      {
        icon: '🧠',
        label: 'トレーニングタイプ',
        title: analyticsNarrativeSummary[0]?.replace('あなたの直近傾向は「', '').replace('」。', '') ?? '判定中',
        detail: analyticsNarrativeSummary[1] ?? 'データを蓄積中です。',
      },
      {
        icon: '📊',
        label: analyticsWindowDays === 7 ? '直近7日の勢い' : '直近30日の勢い',
        title:
          volumeTrendPercent === null
            ? '初回基準を作成中'
            : `${volumeTrendPercent >= 0 ? '+' : ''}${volumeTrendPercent}%`,
        detail: `総負荷 ${currentWindowVolume.toLocaleString()}pt`,
      },
      {
        icon: '🎯',
        label: '主軸',
        title: topPart ? `${topPart.part} (${topPart.count}回)` : '判定中',
        detail: topWeight ? `指標伸びトップ: ${topWeight.name} ${topWeight.weightGrowthLabel}` : '伸び率データを蓄積中',
      },
    ]
  }, [analytics.monthlyTotal, analytics.weeklyTotal, analyticsNarrativeSummary, analyticsWindowDays, bodyPartWindowCounts, growthRankings.weightTop, previousWindowVolume])

  const bodyPartWindowCountsInsight = useMemo(() => {
    if (bodyPartWindowCounts.length === 0) {
      return 'AI評価: 回数データが不足しています。'
    }

    const sorted = [...bodyPartWindowCounts].sort((left, right) => right.count - left.count)
    const top = sorted[0]
    const bottom = sorted[sorted.length - 1]
    if (!top || !bottom) {
      return 'AI評価: 回数データが不足しています。'
    }

    if (top.count === 0) {
      return 'AI評価: 期間内の記録がまだありません。ワークアウトを1件追加すると傾向分析が始まります。'
    }

    if (top.count - bottom.count >= 3) {
      return `AI評価: ${top.part}に実施回数が偏っています。未実施/低頻度部位を週内に1回追加すると全身バランスが改善します。`
    }

    return `AI評価: 実施回数の偏りは小さめです。${top.part}を軸に、弱い部位を1回ずつ補強するとさらに安定します。`
  }, [bodyPartWindowCounts])

  const visibleRankingCount = isProUnlocked ? 5 : 2
  const visibleRecoveryAlerts = isProUnlocked ? recoveryAlerts : recoveryAlerts.slice(0, 1)

  async function handleAuth(email: string, password: string, mode: AuthMode) {
    if (!auth) {
      throw new Error('Firebase 設定が不足しています。')
    }

    if (mode === 'login') {
      await signInWithEmailAndPassword(auth, email, password)
      return
    }

    if (mode === 'signup') {
      await createUserWithEmailAndPassword(auth, email, password)
      return
    }

    await sendPasswordResetEmail(auth, email)
  }

  async function handleGoogleLogin() {
    if (!auth) {
      throw new Error('Firebase 設定が不足しています。')
    }

    await signInWithPopup(auth, new GoogleAuthProvider())
  }

  async function handleStartPhoneLogin(phoneNumber: string) {
    if (!auth) {
      throw new Error('Firebase 設定が不足しています。')
    }

    if (!phoneNumber) {
      throw new Error('電話番号を入力してください。')
    }

    if (!recaptchaRef.current) {
      recaptchaRef.current = new RecaptchaVerifier(auth, 'recaptcha-container', {
        size: 'invisible',
      })
    }

    const confirmation = await signInWithPhoneNumber(auth, phoneNumber, recaptchaRef.current)
    setPhoneConfirmation(confirmation)
  }

  async function handleVerifyPhoneCode(code: string) {
    if (!phoneConfirmation) {
      throw new Error('先にSMSコードを送信してください。')
    }

    if (!code) {
      throw new Error('認証コードを入力してください。')
    }

    await phoneConfirmation.confirm(code)
    setPhoneConfirmation(null)
  }

  function addSet() {
    const profile = getExerciseInputProfile(selectedExercise)
    const metricType = selectedExerciseMetricType
    resetCompleteConfirm()
    setSets((previous) => [
      ...previous,
      (() => {
        const previousSet = previous[previous.length - 1]
        return {
          id: `${Date.now()}-${previous.length}`,
          weight: previousSet?.weight ?? profile.defaultWeight,
          reps:
            metricType === 'time'
              ? previousSet?.durationSec ?? previousSet?.reps ?? profile.defaultDurationSec
              : previousSet?.reps ?? profile.defaultReps,
          durationSec:
            metricType === 'time'
              ? previousSet?.durationSec ?? previousSet?.reps ?? profile.defaultDurationSec
              : undefined,
        }
      })(),
    ])
  }

  function removeSet(setId: string) {
    resetCompleteConfirm()
    setSets((previous) => previous.filter((set) => set.id !== setId))
  }

  function updateSet(setId: string, key: PickerTargetKey, value: number) {
    resetCompleteConfirm()
    setSets((previous) =>
      previous.map((set) => {
        if (set.id !== setId) {
          return set
        }
        if (key === 'duration') {
          return { ...set, reps: value, durationSec: value }
        }
        return { ...set, [key]: value }
      }),
    )
  }

  function getExerciseMetricType(bodyPart: BodyPart, exerciseName: string): ExerciseMetricType {
    const draftKey = getExerciseDraftKey(bodyPart, exerciseName)
    return exercisePreferences[draftKey]?.metricType ?? getDefaultExerciseMetricType(exerciseName)
  }

  function getExercisePreferredRestSeconds(bodyPart: BodyPart, exerciseName: string): number {
    const draftKey = getExerciseDraftKey(bodyPart, exerciseName)
    return exercisePreferences[draftKey]?.restSeconds ?? getExerciseInputProfile(exerciseName).defaultRestSeconds
  }

  function setExercisePreferredRestSeconds(bodyPart: BodyPart, exerciseName: string, rest: number) {
    const draftKey = getExerciseDraftKey(bodyPart, exerciseName)
    setExercisePreferences((previous) => ({
      ...previous,
      [draftKey]: {
        metricType: previous[draftKey]?.metricType ?? getDefaultExerciseMetricType(exerciseName),
        restSeconds: rest,
      },
    }))
  }

  function getPreparedSetsForExercise(bodyPart: BodyPart, exerciseName: string): ExerciseSet[] {
    const draftKey = getExerciseDraftKey(bodyPart, exerciseName)
    const draftSets = exerciseSetDrafts[draftKey] ?? latestExerciseSetHistory.get(draftKey)
    const metricType = getExerciseMetricType(bodyPart, exerciseName)
    if (draftSets && draftSets.length > 0) {
      const cloned = cloneSetDrafts(draftSets)
      return cloned.map((set) => ({
        ...set,
        durationSec: metricType === 'time' ? set.durationSec ?? set.reps : undefined,
      }))
    }

    return createDefaultSetsForExercise(exerciseName, metricType)
  }

  function handleExerciseSelect(exerciseName: string) {
    setSelectedExercise(exerciseName)
    setSets(getPreparedSetsForExercise(selectedBodyPart, exerciseName))
    setWorkoutPhase('record')
    setTimerRunning(false)
    setRestSeconds(getExercisePreferredRestSeconds(selectedBodyPart, exerciseName))
    resetCompleteConfirm()
  }

  function handleCustomExerciseSubmit() {
    const name = customExerciseInput.trim()
    if (!name) {
      showToast('種目名を入力してください', 'error')
      return
    }

    setCustomExercisesByBodyPart((previous) => {
      const bodyPartCustoms = previous[selectedBodyPart]
      if (bodyPartCustoms.includes(name)) {
        return previous
      }
      return {
        ...previous,
        [selectedBodyPart]: [...bodyPartCustoms, name],
      }
    })

    handleExerciseSelect(name)
    showToast(`「${name}」を追加しました`)
    setCustomExerciseInput('')
  }

  function renameCustomExercise(oldName: string, newName: string) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) {
      showToast('別の名前を入力してください', 'error')
      return
    }

    if (customExercisesByBodyPart[selectedBodyPart].includes(trimmed)) {
      showToast('同じ名前の種目がすでにあります', 'error')
      return
    }

    setCustomExercisesByBodyPart((prev) => ({
      ...prev,
      [selectedBodyPart]: prev[selectedBodyPart].map((n) => (n === oldName ? trimmed : n)),
    }))

    if (exerciseNotes[oldName]) {
      setExerciseNotes((prev) => {
        const next = { ...prev }
        next[trimmed] = prev[oldName]
        delete next[oldName]
        return next
      })
    }

    const oldKey = getExerciseDraftKey(selectedBodyPart, oldName)
    const newKey = getExerciseDraftKey(selectedBodyPart, trimmed)
    if (exercisePreferences[oldKey]) {
      setExercisePreferences((prev) => {
        const next = { ...prev }
        next[newKey] = prev[oldKey]
        delete next[oldKey]
        return next
      })
    }

    if (exerciseSetDrafts[oldKey]) {
      setExerciseSetDrafts((prev) => {
        const next = { ...prev }
        next[newKey] = prev[oldKey]
        delete next[oldKey]
        return next
      })
    }

    if (selectedExercise === oldName) {
      setSelectedExercise(trimmed)
    }

    setExerciseInfoTarget(trimmed)
    showToast(`「${trimmed}」に名前を変更しました`)
    triggerHaptic(16)
  }

  function deleteExerciseFromLibrary(name: string) {
    setCustomExercisesByBodyPart((prev) => ({
      ...prev,
      [selectedBodyPart]: prev[selectedBodyPart].filter((n) => n !== name),
    }))
    setIsExerciseDeleteConfirming(false)
    setExerciseInfoTarget(null)
    if (selectedExercise === name) {
      setSelectedExercise('')
    }
    showToast(`「${name}」をリストから削除しました`)
    triggerHaptic(20)
  }

  function openWheelPicker(setId: string, key: PickerTargetKey, currentValue: number) {
    const nextValue = getNearestOption(getPickerOptionsForExercise(selectedExercise, key), currentValue)
    pickerOpenValueRef.current = nextValue
    lastWheelHapticValueRef.current = nextValue
    resetCompleteConfirm()
    setPickerTarget({ setId, key })
    setPickerValue(nextValue)
  }

  function scrollWheelToIndex(index: number, behavior: ScrollBehavior) {
    if (!wheelListRef.current) {
      return
    }

    wheelListRef.current.scrollTo({
      top: index * WHEEL_ITEM_HEIGHT,
      behavior,
    })
  }

  function snapWheelToNearest(behavior: ScrollBehavior) {
    if (!wheelListRef.current || pickerOptions.length === 0) {
      return
    }

    const index = Math.round(wheelListRef.current.scrollTop / WHEEL_ITEM_HEIGHT)
    const clampedIndex = Math.max(0, Math.min(pickerOptions.length - 1, index))
    const nextValue = pickerOptions[clampedIndex]
    if (typeof nextValue === 'number') {
      setPickerValue(nextValue)
      scrollWheelToIndex(clampedIndex, behavior)
    }
  }

  function applyWheelPicker() {
    if (!pickerTarget) {
      return
    }

    if (wheelScrollTimerRef.current) {
      window.clearTimeout(wheelScrollTimerRef.current)
      wheelScrollTimerRef.current = null
    }
    updateSet(pickerTarget.setId, pickerTarget.key, pickerValue)
    triggerHaptic(18)
    setPickerTarget(null)
  }

  function adjustRestSeconds(delta: number) {
    resetCompleteConfirm()
    setRestSeconds((previous) => {
      const nextRest = Math.min(600, Math.max(30, previous + delta))
      setExercisePreferredRestSeconds(selectedBodyPart, selectedExercise, nextRest)
      return nextRest
    })
  }

  function toggleRestTimerRunning() {
    void prepareAudioContext()
    triggerHaptic(timerRunning ? 14 : 20)
    resetCompleteConfirm()
    setTimerRunning((previous) => {
      if (!previous && restSeconds === 0) {
        setRestSeconds(getExercisePreferredRestSeconds(selectedBodyPart, selectedExercise))
      }
      return !previous
    })
  }

  function resetRestTimer() {
    triggerHaptic(12)
    resetCompleteConfirm()
    setTimerRunning(false)
    setRestSeconds(getExercisePreferredRestSeconds(selectedBodyPart, selectedExercise))
  }

  function resetCompleteConfirm() {
    return
  }

  function handleCompleteAction() {
    if (isSavingWorkout) {
      return
    }

    void saveWorkout()
  }

  function showToast(message: string, tone: 'default' | 'error' = 'default') {
    setToastState({ message, tone })
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current)
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastState(null)
      toastTimerRef.current = null
    }, 2200)
  }

  function showRestTimerNotice(message: string) {
    setRestTimerNotice(message)
    if (restTimerNoticeRef.current) {
      window.clearTimeout(restTimerNoticeRef.current)
    }
    restTimerNoticeRef.current = window.setTimeout(() => {
      setRestTimerNotice(null)
      restTimerNoticeRef.current = null
    }, 3200)
  }

  function handleRestTimerPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    restTimerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: restTimerOffset.x,
      originY: restTimerOffset.y,
      dragged: false,
    }
  }

  function handleRestTimerPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const dragState = restTimerDragRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    const deltaX = event.clientX - dragState.startX
    const deltaY = event.clientY - dragState.startY
    const movedEnough = Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10
    if (movedEnough) {
      dragState.dragged = true
    }
    if (!dragState.dragged) {
      return
    }

    const maxX = Math.max(0, window.innerWidth / 2 - 20)
    const minY = -(window.innerHeight - 20)
    const maxY = Math.max(24, window.innerHeight - 120)
    const nextX = Math.max(-maxX, Math.min(maxX, dragState.originX + deltaX))
    const nextY = Math.max(minY, Math.min(maxY, dragState.originY + deltaY))
    setRestTimerOffset({ x: nextX, y: nextY })
  }

  function handleRestTimerPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const dragState = restTimerDragRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const shouldToggle = !dragState.dragged
    restTimerDragRef.current = null

    if (shouldToggle) {
      triggerHaptic(10)
      setIsRestTimerExpanded((previous) => !previous)
      return
    }

    triggerHaptic(8)
  }

  function handleRestTimerPointerCancel(event: React.PointerEvent<HTMLButtonElement>) {
    const dragState = restTimerDragRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    restTimerDragRef.current = null
  }

  function startWorkoutFlow(forceReset = false) {
    if (!forceReset && hasWorkoutDraft) {
      vibrateAndSetTab('workout', 18)
      return
    }

    vibrateAndSetTab('workout', 18)
    setWorkoutPhase('body')
    setSets(createDefaultSetsForExercise(selectedExercise, selectedExerciseMetricType))
    setExerciseSearchQuery('')
    resetCompleteConfirm()
  }

  async function handleDeleteHistorySessions(sessionIds: string[]) {
    if (isDeletingHistory) {
      return
    }

    setIsDeletingHistory(true)
    try {
      sessionIds.forEach((sessionId) => deleteSessionFromStore(sessionId))
      setSelectedHistoryIds([])
      setIsHistorySelectionMode(false)
      setIsHistoryDeleteConfirming(false)
      showToast(`${sessionIds.length}件の履歴を削除しました`)
      setIsDeletingHistory(false)

      if (db && user && !isDemoMode) {
        const dbRef = db
        const uid = user.uid
        setSyncStatus('クラウド同期中...')
        void Promise.allSettled(sessionIds.map((sessionId) => removeSession(dbRef, uid, sessionId)))
          .then((results) => {
            const failedIds = sessionIds.filter((_, index) => results[index].status === 'rejected')
            if (failedIds.length > 0) {
              failedIds.forEach((sessionId) => queueSessionDelete(sessionId))
              setSyncStatus('同期待機中...')
              showToast(`${failedIds.length}件の削除を再同期待ちにしました`, 'error')
              return
            }

            setSyncStatus('クラウド同期済み')
          })
          .catch(() => {
            setSyncStatus('同期エラー')
            showToast('履歴は削除済み / 同期エラー', 'error')
          })
      } else {
        setSyncStatus('ローカル保存')
      }
    } catch {
      setSyncStatus('同期エラー')
      showToast('履歴削除に失敗しました', 'error')
      setIsDeletingHistory(false)
    }
  }

  async function saveWorkout() {
    if (isSavingWorkout) {
      return
    }

    if (!selectedExercise.trim()) {
      showToast('種目を選択してください', 'error')
      return
    }

    setIsSavingWorkout(true)
    try {
      const session = createSession(selectedBodyPart, selectedExercise, selectedExerciseMetricType, sets)
      addSession(session)
      setTab('workout')
      setWorkoutPhase('body')
      setSets(createDefaultSetsForExercise(selectedExercise, selectedExerciseMetricType))
      setRestSeconds(getExercisePreferredRestSeconds(selectedBodyPart, selectedExercise))
      setTimerRunning(false)
      showToast('保存しました')
      resetCompleteConfirm()
      setIsSavingWorkout(false)

      if (db && user && !isDemoMode) {
        const dbRef = db
        const uid = user.uid
        setSyncStatus('クラウド同期中...')
        void saveSession(dbRef, uid, session)
          .then(() => {
            setSyncStatus('クラウド同期済み')
          })
          .catch(() => {
            queueSessionSave(session)
            setSyncStatus('同期待機中...')
            showToast('端末には保存済み / 同期失敗を再試行します', 'error')
          })
      } else {
        setSyncStatus('ローカル保存')
      }
    } catch {
      setSyncStatus('同期エラー')
      showToast('保存に失敗しました', 'error')
      resetCompleteConfirm()
      setIsSavingWorkout(false)
    }
  }

  async function logout() {
    if (!auth) {
      setIsDemoMode(false)
      return
    }

    try {
      await signOut(auth)
    } catch {
      showToast('ログアウトに失敗しました', 'error')
    }
  }

  let content: ReactNode

  if (loading) {
    content = <main className="loading">読み込み中...</main>
  } else if (!canUseApp) {
    content = (
      <AuthView
        onDemoStart={() => setIsDemoMode(true)}
        onLogin={handleAuth}
        onGoogleLogin={handleGoogleLogin}
        onStartPhoneLogin={handleStartPhoneLogin}
        onVerifyPhoneCode={handleVerifyPhoneCode}
      />
    )
  } else {
    content = (
      <main className={`app has-fixed-nav ${tab === 'home' ? 'home-single-screen' : ''} ${tab === 'workout' ? 'no-scroll' : ''}`}>
      <header className="header">
        <h1 className="brand-title">Atlas</h1>
        <div className="header-meta">
          <p className="header-email">{user?.email ?? 'デモモード'}</p>
          <p className="sync-badge">{syncStatus}</p>
        </div>
        <button
          type="button"
          className={`top-settings-btn ${tab === 'settings' ? 'active' : ''}`}
          onClick={handleTopSettingsToggle}
          aria-label={tab === 'settings' ? '前の画面に戻る' : '設定を開く'}
        >
          ⚙
        </button>
      </header>

      {tab === 'home' && (
        <section className="home-grid">
          <section className="card home-primary-card">
            <h2>AIメッセージ</h2>
            <p className="home-ai-main" title={homeAiMessage}>
              {homeAiMessage}
            </p>
          </section>

          <section className="home-kpi-inline">
            <p className="kpi-chip">
              <span className="kpi-label">前週比</span>
              <strong className="kpi-value">{weeklyDeltaLabel}</strong>
            </p>
            <p className="kpi-chip">
              <span className="kpi-label">連続日数</span>
              <strong className="kpi-value">
                {streakDays}
                <small>日</small>
              </strong>
            </p>
          </section>

          <section className="card home-graph-card">
            <div className="row">
              <h2>推定消費カロリー</h2>
              <span className="badge">{weeklyCalories.total.toLocaleString()} kcal</span>
            </div>
            <p className="home-graph-meta">
              今日 {weeklyCaloriesSummary.todayCalories} / 平均 {weeklyCaloriesSummary.averageCalories} / 最大{' '}
              {weeklyCaloriesSummary.maxDay.value}({weeklyCaloriesSummary.maxDay.label})
            </p>
            <div className="mini-chart">
              {weeklyCalories.caloriesByDay.map((day) => {
                const heightPercent = Math.max(8, Math.round((day.value / weeklyCaloriesSummary.maxValue) * 100))
                const isToday = day.label === weeklyCaloriesSummary.todayLabel
                return (
                  <div key={day.label} className={`mini-chart-item ${isToday ? 'active' : ''}`}>
                    <div className="mini-bar-track">
                      <div className="mini-bar" style={{ height: `${heightPercent}%` }} />
                    </div>
                    <span>{day.label}</span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="card home-last-workout-card">
            <div className="row">
              <h2>前回トレーニング</h2>
              {latestSessionSummary && <span className="badge">{latestSessionSummary.restDaysLabel}</span>}
            </div>
            {latestSessionSummary ? (
              <>
                <p className="home-last-workout-meta">
                  {latestSessionSummary.dateLabel} / {latestSessionSummary.bodyPart}
                </p>
                <div className="home-last-workout-kpi">
                  <p>
                    <span>種目</span>
                    <strong>{latestSessionSummary.exerciseCount}</strong>
                  </p>
                  <p>
                    <span>セット</span>
                    <strong>{latestSessionSummary.totalSets}</strong>
                  </p>
                  <p>
                    <span>総負荷</span>
                    <strong>{latestSessionSummary.totalVolume.toLocaleString()}pt</strong>
                  </p>
                </div>
                <div className="home-last-workout-lines">
                  {homeLastWorkoutVisibleHighlights.map((item) => (
                    <p key={item.name}>
                      <span>{item.name}</span>
                      <strong>{item.bestSetLabel}</strong>
                      <small>{item.setCount}セット</small>
                    </p>
                  ))}
                  {homeLastWorkoutHiddenCount > 0 && (
                    <p className="home-last-workout-more">ほか {homeLastWorkoutHiddenCount} 種目</p>
                  )}
                </div>
              </>
            ) : (
              <p className="home-last-workout-empty">履歴が増えると前回内容をここに表示します。</p>
            )}
          </section>

          <button type="button" className="thumb-workout-cta" onClick={() => startWorkoutFlow(false)}>
            {hasWorkoutDraft ? 'ワークアウト再開' : 'ワークアウト開始'}
          </button>
        </section>
      )}

      {tab === 'workout' && (
        <section className="card workout-screen">
          <div className="row">
            <h2>{workoutPhase === 'record' ? `${selectedBodyPart} / ${selectedExercise} 記録` : 'ワークアウト'}</h2>
            {workoutPhase !== 'body' ? (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  triggerHaptic(12)
                  setWorkoutPhase((previous) => (previous === 'record' ? 'exercise' : 'body'))
                }}
              >
                戻る
              </button>
            ) : (
              <button type="button" className="secondary-btn" onClick={() => vibrateAndSetTab('home', 12)}>
                ホーム
              </button>
            )}
          </div>

          {workoutPhase !== 'record' && (
            <div className="step-indicator">
              <span className={workoutPhase === 'body' ? 'active' : ''}>1.部位</span>
              <span className={workoutPhase === 'exercise' ? 'active' : ''}>2.種目</span>
            </div>
          )}
          <p className="workout-affordance-hint">
            {workoutPhase === 'record'
              ? '重量・回数/秒をタップして編集 → 保存して終了'
              : 'カードをタップして次へ進みます'}
          </p>

          {workoutPhase === 'body' && (
            <div className="step-panel">
              <div className="body-map body-map-full">
                {BODY_PARTS.map((part) => (
                  <button
                    key={part}
                    type="button"
                    className={selectedBodyPart === part ? 'active' : ''}
                    onClick={() => {
                      setSelectedBodyPart(part)
                      setWorkoutPhase('exercise')
                      triggerHaptic(30)
                    }}
                  >
                    <span>{part}</span>
                    <small className={`body-badge tone-${bodyPartReadiness.get(part)?.tone ?? 'new'}`}>
                      {bodyPartReadiness.get(part)?.label ?? '未実施'}
                    </small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {workoutPhase === 'exercise' && (
            <div className="step-panel exercise-step">
              <input
                value={exerciseSearchQuery}
                onChange={(event) => setExerciseSearchQuery(event.target.value)}
                placeholder="種目を検索"
              />
              <div className="custom-exercise-row">
                <input
                  value={customExerciseInput}
                  onChange={(event) => setCustomExerciseInput(event.target.value)}
                  placeholder="自由入力で種目追加（例: ケーブルリアレイズ）"
                />
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => {
                    triggerHaptic(12)
                    handleCustomExerciseSubmit()
                  }}
                >
                  追加
                </button>
              </div>
              <div className="exercise-list">
                {filteredExercises.map((exercise) => (
                  <div key={exercise} className={`exercise-item ${selectedExercise === exercise ? 'selected' : ''}`}>
                    <button
                      type="button"
                      onClick={() => {
                        handleExerciseSelect(exercise)
                        triggerHaptic(20)
                      }}
                    >
                      <span>{exercise}</span>
                      <small className="previous-record">
                        {exerciseUsageStats.get(exercise)
                          ? (() => {
                              const stat = exerciseUsageStats.get(exercise)
                              if (!stat) {
                                return '最高記録なし'
                              }
                              const unit = stat.metricType === 'time' ? '秒' : '回'
                              return stat.bestWeight > 0
                                ? `${stat.bestWeight}kg×${stat.bestMetric}${unit}`
                                : `${stat.bestMetric}${unit}`
                            })()
                          : '最高記録なし'}
                      </small>
                    </button>
                    <button
                      type="button"
                      className="info-btn"
                      onClick={() => {
                        triggerHaptic(10)
                        setExerciseInfoTarget(exercise)
                      }}
                    >
                      i
                    </button>
                  </div>
                ))}
                {filteredExercises.length === 0 && <p className="empty-state">該当する種目がありません。</p>}
              </div>
            </div>
          )}

          {workoutPhase === 'record' && (
            <div className="step-panel record-step">
              <div className="record-step-body">
                <div className="record-metric-pill">
                  <span className={`metric-fixed-badge ${selectedExerciseMetricType === 'time' ? 'time' : 'reps'}`}>
                    {selectedExerciseMetricType === 'time' ? '秒数固定' : '回数固定'}
                  </span>
                  <small className="metric-fixed-helper">
                    {selectedExerciseMetricType === 'time'
                      ? 'この種目は秒数で記録します。'
                      : 'この種目は回数で記録します。'}
                  </small>
                </div>
                <div className="previous-set-card">
                  <p className="previous-set-line">
                    前回セット:
                    {' '}
                    {previousExerciseSets.length > 0
                      ? previousExerciseSets.map((set) => formatSetLabel(set, selectedExerciseMetricType)).join(' / ')
                      : '記録なし'}
                  </p>
                  <span className="previous-set-status">
                    {previousExerciseSets.length > 0 ? '選択時に自動反映' : '初回は3セットから開始'}
                  </span>
                </div>
                <div className="record-set-list">
                  {sets.map((set, index) => (
                    <div key={set.id} className="set-row set-row-compact">
                      <span>Set {index + 1}</span>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic(10)
                          openWheelPicker(set.id, 'weight', set.weight)
                        }}
                      >
                        {set.weight}kg
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic(10)
                          openWheelPicker(
                            set.id,
                            selectedExerciseMetricType === 'time' ? 'duration' : 'reps',
                            getSetMetricValue(set, selectedExerciseMetricType),
                          )
                        }}
                      >
                        {selectedExerciseMetricType === 'time'
                          ? `${getSetMetricValue(set, selectedExerciseMetricType)}秒`
                          : `${set.reps}回`}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic(16)
                          removeSet(set.id)
                        }}
                        disabled={sets.length <= 1}
                      >
                        削除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="action-row record-action-row">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic(18)
                    addSet()
                  }}
                >
                  ＋セット追加
                </button>
              </div>
              <div className="action-row complete-action-row">
                <button
                  type="button"
                  disabled={isSavingWorkout}
                  onClick={() => {
                    triggerHaptic(50)
                    handleCompleteAction()
                  }}
                >
                  {isSavingWorkout ? '保存中...' : '保存して終了'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'history' && (
        <section className="card history-screen-card">
          <h2>履歴</h2>
          <p className="history-affordance-hint">日付をタップで展開、長い一覧は「複数選択削除」からまとめて操作できます。</p>
          <div className="history-calendar-card">
            <div className="history-calendar-header">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic(10)
                  setHistoryMonthCursor((previous) => dayjs(previous).subtract(1, 'month').format('YYYY-MM-DD'))
                }}
              >
                ←
              </button>
              <strong>{historyMonth.format('YYYY年 M月')}</strong>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic(10)
                  setHistoryMonthCursor((previous) => dayjs(previous).add(1, 'month').format('YYYY-MM-DD'))
                }}
              >
                →
              </button>
            </div>
            <div className="history-calendar-weekdays">
              {['日', '月', '火', '水', '木', '金', '土'].map((weekday) => (
                <span key={weekday}>{weekday}</span>
              ))}
            </div>
            <div className="history-calendar-grid">
              {historyCalendarDays.map((day) => (
                <button
                  key={day.key}
                  type="button"
                  className={`history-calendar-day ${!day.isCurrentMonth ? 'other-month' : ''} ${day.sessionCount > 0 ? 'has-log' : ''} ${historySelectedDate === day.key ? 'active' : ''}`}
                  onClick={() => {
                    triggerHaptic(10)
                    if (!day.isCurrentMonth) {
                      setHistoryMonthCursor(day.key)
                    }
                    setHistorySelectedDate((previous) => (previous === day.key ? null : day.key))
                  }}
                >
                  <span>{day.dayLabel}</span>
                  {day.sessionCount > 0 && <small>{day.sessionCount}</small>}
                </button>
              ))}
            </div>
            <div className="history-calendar-selection">
              <p>{historySelectedDate ? `${dayjs(historySelectedDate).format('M/D')} の履歴` : '日付をタップでその日の詳細を表示'}</p>
              {historySelectedDate && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic(10)
                    setHistorySelectedDate(null)
                  }}
                >
                  全日表示
                </button>
              )}
            </div>
          </div>
          <div className="chip-row history-chip-row">
            <button
              type="button"
              className={`chip-button ${historyBodyPartFilters.length === 0 ? 'active' : ''}`}
              onClick={() => {
                triggerHaptic(10)
                setHistoryBodyPartFilters([])
                setHistoryExerciseFilters([])
              }}
            >
              全部位
              <small className="history-chip-count">{historyBaseFiltered.length}</small>
            </button>
            {BODY_PARTS.map((part) => {
              const count = historyBodyPartCounts.get(part) ?? 0
              const isActive = historyBodyPartFilters.includes(part)
              return (
                <button
                  key={part}
                  type="button"
                  className={`chip-button ${isActive ? 'active' : ''}`}
                  disabled={!isActive && count === 0}
                  onClick={() => {
                    triggerHaptic(10)
                    setHistoryBodyPartFilters((previous) =>
                      previous.includes(part)
                        ? previous.filter((current) => current !== part)
                        : [...previous, part],
                    )
                    setHistoryExerciseFilters([])
                  }}
                >
                  {part}
                  <small className="history-chip-count">{count}</small>
                </button>
              )
            })}
          </div>
          <div className="chip-row history-chip-row history-exercise-chip-row">
            <button
              type="button"
              className={`chip-button ${historyExerciseFilters.length === 0 ? 'active' : ''}`}
              onClick={() => {
                triggerHaptic(10)
                setHistoryExerciseFilters([])
              }}
            >
              全種目
              <small className="history-chip-count">{historyBodyPartFiltered.length}</small>
            </button>
            {historyExerciseChips.map((chip) => {
              const isActive = historyExerciseFilters.includes(chip.name)
              return (
                <button
                  key={chip.name}
                  type="button"
                  className={`chip-button ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    triggerHaptic(10)
                    setHistoryExerciseFilters((previous) =>
                      previous.includes(chip.name)
                        ? previous.filter((current) => current !== chip.name)
                        : [...previous, chip.name],
                    )
                  }}
                >
                  {chip.name}
                  <small className="history-chip-count">{chip.count}</small>
                </button>
              )
            })}
          </div>
          <div className={`history-bulk-actions ${isHistorySelectionMode ? 'selection-mode' : ''}`}>
            {!isHistorySelectionMode ? (
              <button
                type="button"
                className="history-delete-btn"
                onClick={() => {
                  if (visibleHistoryIds.length === 0) {
                    triggerHaptic(8)
                    showToast('削除できる履歴がありません', 'error')
                    return
                  }
                  triggerHaptic(12)
                  setIsHistoryDeleteConfirming(false)
                  setIsHistorySelectionMode(true)
                }}
              >
                複数選択削除
              </button>
            ) : (
              <>
                <div className="history-selection-header">
                  <p className="history-selection-status">
                    選択中 {selectedHistoryIds.length} / {visibleHistoryIds.length}
                  </p>
                  <button
                    type="button"
                    className="history-delete-btn"
                    onClick={() => {
                      triggerHaptic(10)
                      setIsHistorySelectionMode(false)
                      setSelectedHistoryIds([])
                      setIsHistoryDeleteConfirming(false)
                    }}
                  >
                    選択終了
                  </button>
                </div>
                <p className="history-selection-helper">
                  {isHistoryDeleteConfirming
                    ? '確認中：もう一度「削除」をタップで確定'
                    : '部位/種目チップは複数選択できます。削除したい履歴を選択してから「削除」をタップ'}
                </p>
                <div className="history-selection-actions">
                  <button
                    type="button"
                    className="history-delete-btn"
                    disabled={visibleHistoryIds.length === 0}
                    onClick={() => {
                      triggerHaptic(10)
                      setSelectedHistoryIds(() => (isAllVisibleHistorySelected ? [] : [...visibleHistoryIds]))
                    }}
                  >
                    {visibleHistoryIds.length === 0
                      ? '対象なし'
                      : isAllVisibleHistorySelected
                        ? '全件解除'
                        : '全件選択'}
                  </button>
                  <button
                    type="button"
                    className={`history-delete-btn danger ${selectedHistoryIds.length === 0 ? 'disabled' : ''}`}
                    disabled={selectedHistoryIds.length === 0 || isDeletingHistory}
                    onClick={() => {
                      if (!isHistoryDeleteConfirming) {
                        triggerHaptic(12)
                        setIsHistoryDeleteConfirming(true)
                        return
                      }
                      triggerHaptic(22)
                      void handleDeleteHistorySessions([...selectedHistoryIds])
                    }}
                  >
                    {isDeletingHistory
                      ? '削除中...'
                      : isHistoryDeleteConfirming
                        ? `再タップで${selectedHistoryIds.length}件削除`
                        : `${selectedHistoryIds.length}件削除`}
                  </button>
                </div>
              </>
            )}
          </div>
          {historyDateSections.map((section) => {
            const isOpen = historyOpenDates.includes(section.date)
            return (
              <section key={section.date} className="history-date-group">
                <button
                  type="button"
                  className={`history-date-toggle ${isOpen ? 'open' : ''}`}
                  onClick={() => {
                    triggerHaptic(10)
                    setHistoryOpenDates((previous) =>
                      previous.includes(section.date)
                        ? previous.filter((date) => date !== section.date)
                        : [...previous, section.date],
                    )
                  }}
                >
                  <div>
                    <strong>{dayjs(section.date).format('YYYY/MM/DD')}</strong>
                    <small>{section.sessionCount}件 / 総負荷 {section.totalVolume.toLocaleString()}pt</small>
                  </div>
                  <div className="history-date-toggle-state">
                    <small className={`history-open-badge ${isOpen ? 'open' : ''}`}>{isOpen ? '表示中' : '未表示'}</small>
                    <span className={`history-toggle-icon ${isOpen ? 'open' : ''}`}>{isOpen ? '−' : '+'}</span>
                  </div>
                </button>
                {isOpen &&
                  section.sessions.map((session) => (
                    <article key={session.id} className="history-item">
                      <div className="history-item-head">
                        <strong>{session.bodyPart}</strong>
                        {isHistorySelectionMode && (
                          <button
                            type="button"
                            className={`history-select-btn ${selectedHistoryIds.includes(session.id) ? 'selected' : ''}`}
                            onClick={() => {
                              triggerHaptic(10)
                              setSelectedHistoryIds((previous) =>
                                previous.includes(session.id)
                                  ? previous.filter((id) => id !== session.id)
                                  : [...previous, session.id],
                              )
                            }}
                          >
                            {selectedHistoryIds.includes(session.id) ? '選択中' : '選択'}
                          </button>
                        )}
                      </div>
                      {session.exercises.map((exercise) => (
                        <p key={exercise.id}>
                          {exercise.name}:{' '}
                          {exercise.sets
                            .map((set) => formatSetLabel(set, exercise.metricType ?? getDefaultExerciseMetricType(exercise.name)))
                            .join(' / ')}
                        </p>
                      ))}
                    </article>
                  ))}
              </section>
            )
          })}
          {historyDateSections.length === 0 && <p>履歴がありません。</p>}
        </section>
      )}

      {tab === 'analytics' && (
        <section className="card analytics-screen-card">
          <div className="row analytics-header-row">
            <h2>分析</h2>
          </div>

          <section className="analytics-ai-summary">
            <h3>総合サマリー</h3>
            <div className="analytics-summary-card-grid">
              {analyticsSummaryCards.map((card) => (
                <article key={`${card.label}-${card.title}`} className="analytics-summary-card">
                  <div className="analytics-summary-head">
                    <span className="analytics-summary-icon" aria-hidden="true">{card.icon}</span>
                    <div>
                      <small>{card.label}</small>
                      <strong>{card.title}</strong>
                    </div>
                  </div>
                  <p>{card.detail}</p>
                </article>
              ))}
            </div>
            {[...analyticsNarrativeSummary.slice(3), ...analyticsLocalSummary]
              .slice(0, isProUnlocked ? 4 : 2)
              .map((text) => (
              <p key={text} className="feedback-line">・{text}</p>
            ))}
            {!isProUnlocked && (
              <p className="analytics-pro-teaser">Proで詳細サマリーをさらに表示</p>
            )}
          </section>

          <div className="chip-row analytics-period-row">
            <button
              type="button"
              className={`chip-button ${analyticsWindowDays === 7 ? 'active' : ''}`}
              onClick={() => {
                triggerHaptic(10)
                setAnalyticsWindowDays(7)
              }}
            >
              7日比較
            </button>
            <button
              type="button"
              className={`chip-button ${analyticsWindowDays === 30 ? 'active' : ''}`}
              onClick={() => {
                triggerHaptic(10)
                setAnalyticsWindowDays(30)
              }}
            >
              30日比較
            </button>
          </div>

          <section className="analytics-ranking-grid">
            <article className="analytics-ranking-card">
              <h3>指標伸び率ランキング</h3>
              {growthRankings.weightTop.slice(0, visibleRankingCount).map((item, index) => (
                <div key={`weight-${item.name}`} className="analytics-ranking-item">
                  <div className="analytics-ranking-main">
                    <strong>{index + 1}. {item.name}</strong>
                    <small>{item.previousPeakMetric}{item.metricType === 'time' ? '秒' : '回'} → {item.currentPeakMetric}{item.metricType === 'time' ? '秒' : '回'}</small>
                  </div>
                  <span>{item.weightGrowthLabel}</span>
                </div>
              ))}
              {growthRankings.weightTop.length - visibleRankingCount > 0 && (
                <p className="analytics-pro-teaser">+{growthRankings.weightTop.length - visibleRankingCount}件は Pro で解放</p>
              )}
              <p className="analytics-ranking-insight">{weightRankingInsight}</p>
            </article>

            <article className="analytics-ranking-card">
              <h3>総負荷伸び率ランキング</h3>
              {growthRankings.volumeTop.slice(0, visibleRankingCount).map((item, index) => (
                <div key={`volume-${item.name}`} className="analytics-ranking-item">
                  <div className="analytics-ranking-main">
                    <strong>{index + 1}. {item.name}</strong>
                    <small>{item.previousVolume.toLocaleString()}pt → {item.currentVolume.toLocaleString()}pt</small>
                  </div>
                  <span>{item.volumeGrowthLabel}</span>
                </div>
              ))}
              {growthRankings.volumeTop.length - visibleRankingCount > 0 && (
                <p className="analytics-pro-teaser">+{growthRankings.volumeTop.length - visibleRankingCount}件は Pro で解放</p>
              )}
              <p className="analytics-ranking-insight">{volumeRankingInsight}</p>
            </article>
          </section>

          <section className="analytics-insight-grid">
            <article className="analytics-ranking-card">
              <h3>疲労・回復アラート</h3>
              {visibleRecoveryAlerts.map((alert) => (
                <article key={`${alert.title}-${alert.detail}`} className={`analytics-alert-item ${alert.severity}`}>
                  <div className="analytics-alert-head">
                    <span aria-hidden="true">{alert.icon}</span>
                    <strong>{alert.title}</strong>
                  </div>
                  <p>{alert.detail}</p>
                </article>
              ))}
              {!isProUnlocked && recoveryAlerts.length - visibleRecoveryAlerts.length > 0 && (
                <p className="analytics-pro-teaser">+{recoveryAlerts.length - visibleRecoveryAlerts.length}件は Pro で解放</p>
              )}
            </article>
          </section>

          <article className="analytics-ranking-card">
            <h3>{analyticsWindowDays === 7 ? '直近7日' : '直近30日'}の部位別実施回数</h3>
            <div className="analytics-balance-list">
              {bodyPartWindowCounts.map((item) => (
                <div key={`balance-${item.part}`} className="analytics-balance-row">
                  <span>{item.part}</span>
                  <div className="analytics-balance-track">
                    <div
                      className="analytics-balance-fill"
                      style={{ width: `${Math.round((item.count / bodyPartWindowMaxCount) * 100)}%` }}
                    />
                  </div>
                  <strong>{item.count}回</strong>
                </div>
              ))}
            </div>
            <p className="analytics-ranking-insight">{bodyPartWindowCountsInsight}</p>
          </article>
        </section>
      )}

      {tab === 'settings' && (
        <section className="card">
          <h2>設定</h2>
          <p>プロフィール: {user?.email ?? 'デモユーザー'}</p>

          <div className="settings-section">
            <label>
              <strong>Pro版（仮）</strong>
              <p className="settings-hint">
                無料版は一部コンテンツを制限し、Pro版（仮）で詳細サマリー・ランキング表示件数・疲労アラート件数を解放します。
              </p>
            </label>
            <button
              type="button"
              className={`secondary-btn ${isProUnlocked ? 'settings-pro-active' : ''}`}
              onClick={() => {
                const next = !isProUnlocked
                setIsProUnlocked(next)
                window.localStorage.setItem(PRO_UNLOCKED_STORAGE_KEY, next ? '1' : '0')
                showToast(next ? 'Pro版（仮）を有効化しました' : 'Pro版（仮）を解除しました')
              }}
            >
              {isProUnlocked ? '課金状態（仮）: ON' : '課金する（仮）'}
            </button>
          </div>

          <button type="button" onClick={logout}>
            ログアウト
          </button>
        </section>
      )}

      {exerciseInfoTarget && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="row">
              <h3>{exerciseInfoTarget}</h3>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic(12)
                  setExerciseInfoTarget(null)
                }}
              >
                閉じる
              </button>
            </div>

            {hasKnownGuide ? (
              <>
                <ExerciseTextGuide exerciseName={exerciseInfoTarget!} />
                <div className="info-copy">
                  <p><strong>姿勢</strong> {selectedExerciseGuide.setup}</p>
                  <p><strong>やり方</strong> {selectedExerciseInfo.method}</p>
                  {selectedExerciseInfo.caution && <p><strong>注意</strong> {selectedExerciseInfo.caution}</p>}
                </div>
              </>
            ) : (
              <p className="empty-state" style={{ padding: '4px 0' }}>ガイドなし（メモで記録できます）</p>
            )}

            {isInfoTargetInLibrary && (
              <div className="exercise-edit-section">
                <p className="exercise-edit-label">名前を変更</p>
                <div className="custom-exercise-row">
                  <input
                    value={exerciseRenameDraft}
                    onChange={(event) => setExerciseRenameDraft(event.target.value)}
                    placeholder="新しい種目名"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && exerciseInfoTarget) {
                        renameCustomExercise(exerciseInfoTarget, exerciseRenameDraft)
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => exerciseInfoTarget && renameCustomExercise(exerciseInfoTarget, exerciseRenameDraft)}
                  >
                    変更
                  </button>
                </div>
                {isExerciseDeleteConfirming ? (
                  <div className="action-row">
                    <button
                      type="button"
                      className="danger-btn"
                      onClick={() => exerciseInfoTarget && deleteExerciseFromLibrary(exerciseInfoTarget)}
                    >
                      本当に削除
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsExerciseDeleteConfirming(false)}
                    >
                      キャンセル
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="danger-btn"
                    onClick={() => { triggerHaptic(12); setIsExerciseDeleteConfirming(true) }}
                  >
                    リストから削除
                  </button>
                )}
              </div>
            )}

            <div className="exercise-note-editor">
              <label>
                ユーザーメモ
                <textarea
                  value={exerciseNoteDraft}
                  onChange={(event) => setExerciseNoteDraft(event.target.value)}
                  placeholder="フォームのコツや注意点をメモ"
                />
              </label>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  if (!exerciseInfoTarget) {
                    return
                  }
                  const trimmedNote = exerciseNoteDraft.trim()
                  setExerciseNotes((previous) => {
                    const next = { ...previous }
                    if (trimmedNote) {
                      next[exerciseInfoTarget] = trimmedNote
                    } else {
                      delete next[exerciseInfoTarget]
                    }
                    return next
                  })
                  showToast(trimmedNote ? 'メモを保存しました' : 'メモを削除しました')
                  triggerHaptic(12)
                }}
              >
                メモ保存
              </button>
            </div>
          </div>
        </div>
      )}

      {pickerTarget && (
        <div className="overlay">
          <div className="overlay-card picker-overlay-card">
            <h3>{pickerTarget.key === 'weight' ? '重量を選択' : pickerTarget.key === 'duration' ? '秒数を選択' : '回数を選択'}</h3>
            <p className="picker-meta">
              {pickerTarget.key === 'weight'
                ? `${selectedExerciseProfile.weightStep}kg刻み / ${selectedExerciseProfile.weightMin}〜${selectedExerciseProfile.weightMax}kg`
                : pickerTarget.key === 'duration'
                  ? `${selectedExerciseProfile.durationStep}秒刻み / ${selectedExerciseProfile.durationMin}〜${selectedExerciseProfile.durationMax}秒`
                  : `${selectedExerciseProfile.repStep}回刻み / ${selectedExerciseProfile.repMin}〜${selectedExerciseProfile.repMax}回`}
            </p>
            <div className="wheel-shell">
              <div className="wheel-window">
                <div className="wheel-highlight" />
                <div
                  ref={wheelListRef}
                  className="wheel-list"
                  onScroll={(event) => {
                    const container = event.currentTarget
                    const index = Math.round(container.scrollTop / WHEEL_ITEM_HEIGHT)
                    const clampedIndex = Math.max(0, Math.min(pickerOptions.length - 1, index))
                    const nextValue = pickerOptions[clampedIndex]
                    if (typeof nextValue === 'number' && nextValue !== pickerValue) {
                      setPickerValue(nextValue)
                      if (nextValue !== lastWheelHapticValueRef.current) {
                        lastWheelHapticValueRef.current = nextValue
                        triggerHaptic(10)
                      }
                    }
                    if (wheelScrollTimerRef.current) {
                      window.clearTimeout(wheelScrollTimerRef.current)
                    }
                    wheelScrollTimerRef.current = window.setTimeout(() => {
                      snapWheelToNearest('smooth')
                      wheelScrollTimerRef.current = null
                    }, 90)
                  }}
                >
                  <div style={{ height: `${WHEEL_SIDE_PADDING}px` }} />
                  {pickerOptions.map((value, index) => (
                    <button
                      key={value}
                      type="button"
                      className={`wheel-item ${value === pickerValue ? 'selected' : ''}`}
                      onClick={() => {
                        setPickerValue(value)
                        if (value !== lastWheelHapticValueRef.current) {
                          lastWheelHapticValueRef.current = value
                          triggerHaptic(10)
                        }
                        scrollWheelToIndex(index, 'smooth')
                      }}
                    >
                      {value}
                    </button>
                  ))}
                  <div style={{ height: `${WHEEL_SIDE_PADDING}px` }} />
                </div>
                <span className="wheel-unit">{pickerTarget.key === 'weight' ? 'kg' : pickerTarget.key === 'duration' ? '秒' : '回'}</span>
              </div>
            </div>
            <div className="action-row">
              <button type="button" onClick={applyWheelPicker}>
                決定
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic(12)
                  if (wheelScrollTimerRef.current) {
                    window.clearTimeout(wheelScrollTimerRef.current)
                    wheelScrollTimerRef.current = null
                  }
                  setPickerTarget(null)
                }}
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {toastState && <div className={`toast ${toastState.tone === 'error' ? 'toast-error' : ''}`}>{toastState.message}</div>}
      {restTimerNotice && <div className="rest-timer-notice">{restTimerNotice}</div>}
      {shouldShowRestTimerFloating && (
        <div
          ref={restTimerFloatingRef}
          className={`rest-timer-floating ${isRestTimerExpanded ? 'expanded' : ''}`}
          style={{ transform: `translate(calc(-50% + ${restTimerOffset.x}px), ${restTimerOffset.y}px)` }}
        >
          <button
            type="button"
            className={`rest-timer-fab-toggle ${timerRunning ? 'running' : ''}`}
            onPointerDown={handleRestTimerPointerDown}
            onPointerMove={handleRestTimerPointerMove}
            onPointerUp={handleRestTimerPointerUp}
            onPointerCancel={handleRestTimerPointerCancel}
          >
            <span>休憩</span>
            <strong>{restTimerLabel}</strong>
          </button>
          {isRestTimerExpanded && (
            <div className="rest-timer-floating-panel">
              <div className="timer-adjust">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic(10)
                    adjustRestSeconds(-15)
                  }}
                  disabled={timerRunning}
                >
                  －
                </button>
                <p>{restTimerLabel}</p>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic(10)
                    adjustRestSeconds(15)
                  }}
                  disabled={timerRunning}
                >
                  ＋
                </button>
              </div>
              <div className="action-row">
                <button type="button" onClick={toggleRestTimerRunning}>
                  {timerRunning ? 'STOP' : 'START'}
                </button>
                <button type="button" onClick={resetRestTimer}>
                  リセット
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <nav className="bottom-nav">
        <button type="button" onClick={() => vibrateAndSetTab('home', 10)} className={tab === 'home' ? 'active' : ''}>
          ホーム
        </button>
        <button
          type="button"
          onClick={() => startWorkoutFlow(false)}
          className={tab === 'workout' ? 'active' : ''}
        >
          ワーク
        </button>
        <button
          type="button"
          onClick={() => vibrateAndSetTab('analytics', 10)}
          className={`analytics-cta ${tab === 'analytics' ? 'active' : ''}`}
        >
          分析
        </button>
        <button
          type="button"
          onClick={() => vibrateAndSetTab('history', 10)}
          className={tab === 'history' ? 'active' : ''}
        >
          履歴
        </button>
      </nav>
    </main>
    )
  }

  return <AppErrorBoundary>{content}</AppErrorBoundary>
}

export default App
