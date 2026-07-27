import { useEffect, useMemo, useRef, useState } from 'react'
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
import { BODY_PARTS, EXERCISES_BY_BODY_PART } from './data/catalog'
import { useAtlasStore } from './store/useAtlasStore'
import { removeSession, saveSession, subscribeSessions } from './lib/firestoreSync'
import { requestAiFeedback } from './lib/aiFeedback'
import type { BodyPart, ExerciseSet, WorkoutSession } from './types'

type AppTab = 'home' | 'workout' | 'history' | 'analytics' | 'settings'
type AuthMode = 'login' | 'signup' | 'reset'
type WorkoutPhase = 'body' | 'exercise' | 'record'
type PickerTargetKey = 'weight' | 'reps'
type BodyPartBadgeTone = 'new' | 'fresh' | 'ready' | 'stale'
type ExercisePreference = {
  restSeconds: number
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
  defaultRestSeconds: number
  weightMin: number
  weightMax: number
  weightStep: number
  repMin: number
  repMax: number
  repStep: number
}
const WHEEL_ITEM_HEIGHT = 54
const WHEEL_VISIBLE_ROWS = 5
const WHEEL_SIDE_PADDING = ((WHEEL_VISIBLE_ROWS - 1) / 2) * WHEEL_ITEM_HEIGHT
const EXERCISE_PREFERENCES_STORAGE_KEY = 'atlas.exercise-preferences.v1'

function triggerHaptic(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern)
  }
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

function cloneSetDrafts(sets: Array<Pick<ExerciseSet, 'weight' | 'reps'>>): ExerciseSet[] {
  return sets.map((set, index) => ({
    id: `${Date.now()}-${index}`,
    weight: set.weight,
    reps: set.reps,
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
      defaultRestSeconds: 150,
      weightMin: 0,
      weightMax: 300,
      weightStep: 2.5,
      repMin: 1,
      repMax: 15,
      repStep: 1,
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
      defaultRestSeconds: 105,
      weightMin: 0,
      weightMax: 240,
      weightStep: 5,
      repMin: 4,
      repMax: 20,
      repStep: 1,
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
      defaultRestSeconds: 75,
      weightMin: 0,
      weightMax: 80,
      weightStep: 1,
      repMin: 6,
      repMax: 25,
      repStep: 1,
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
      defaultRestSeconds: 60,
      weightMin: 0,
      weightMax: 40,
      weightStep: 1,
      repMin: 1,
      repMax: 30,
      repStep: 1,
    }
  }

  return {
    defaultWeight: 20,
    defaultReps: 10,
    defaultRestSeconds: 90,
    weightMin: 0,
    weightMax: 120,
    weightStep: 2.5,
    repMin: 4,
    repMax: 20,
    repStep: 1,
  }
}

function getPickerOptionsForExercise(exerciseName: string, key: PickerTargetKey): number[] {
  const profile = getExerciseInputProfile(exerciseName)
  return key === 'weight'
    ? buildNumberOptions(profile.weightMin, profile.weightMax, profile.weightStep)
    : buildNumberOptions(profile.repMin, profile.repMax, profile.repStep)
}

function createDefaultSetsForExercise(exerciseName: string): ExerciseSet[] {
  const profile = getExerciseInputProfile(exerciseName)
  return Array.from({ length: 3 }, (_, index) => ({
    id: `${Date.now()}-${index}`,
    weight: profile.defaultWeight,
    reps: profile.defaultReps,
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

function createSession(bodyPart: BodyPart, exerciseName: string, sets: ExerciseSet[]): WorkoutSession {
  return {
    id: crypto.randomUUID(),
    date: dayjs().toISOString(),
    bodyPart,
    exercises: [
      {
        id: crypto.randomUUID(),
        name: exerciseName,
        sets,
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
  const [selectedExercise, setSelectedExercise] = useState(EXERCISES_BY_BODY_PART.胸[0])
  const [workoutPhase, setWorkoutPhase] = useState<WorkoutPhase>('body')
  const [sets, setSets] = useState<ExerciseSet[]>([createSet(0), createSet(1), createSet(2)])
  const [restSeconds, setRestSeconds] = useState(90)
  const [timerRunning, setTimerRunning] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyDeleteTargetId, setHistoryDeleteTargetId] = useState<string | null>(null)
  const [isDeletingHistory, setIsDeletingHistory] = useState(false)
  const [historyMonthCursor, setHistoryMonthCursor] = useState(() => dayjs().startOf('month').format('YYYY-MM-DD'))
  const [historySelectedDate, setHistorySelectedDate] = useState<string | null>(null)
  const [historyOpenDates, setHistoryOpenDates] = useState<string[]>([])
  const [exerciseSearchQuery, setExerciseSearchQuery] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState('ローカル保存')
  const [aiFeedback, setAiFeedback] = useState<string[]>([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [exerciseInfoTarget, setExerciseInfoTarget] = useState<string | null>(null)
  const [pickerTarget, setPickerTarget] = useState<{ setId: string; key: 'weight' | 'reps' } | null>(null)
  const [pickerValue, setPickerValue] = useState(0)
  const [isSavingWorkout, setIsSavingWorkout] = useState(false)
  const [toastState, setToastState] = useState<{ message: string; tone: 'default' | 'error' } | null>(null)
  const [isLandscapeBlocked, setIsLandscapeBlocked] = useState(false)
  const [exerciseSetDrafts, setExerciseSetDrafts] = useState<
    Record<string, Array<Pick<ExerciseSet, 'weight' | 'reps'>>>
  >({})
  const [exercisePreferences, setExercisePreferences] = useState<Record<string, ExercisePreference>>(
    loadExercisePreferences,
  )
  const wheelListRef = useRef<HTMLDivElement | null>(null)
  const wheelScrollTimerRef = useRef<number | null>(null)
  const lastWheelHapticValueRef = useRef<number | null>(null)
  const pickerOpenValueRef = useRef(0)
  const toastTimerRef = useRef<number | null>(null)
  const recaptchaRef = useRef<RecaptchaVerifier | null>(null)
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
    if (!timerRunning) {
      return
    }

    const timer = window.setInterval(() => {
      setRestSeconds((previous) => {
        if (previous <= 1) {
          window.clearInterval(timer)
          setTimerRunning(false)
          triggerHaptic([120, 80, 120])
          return 0
        }

        return previous - 1
      })
    }, 1000)

    return () => window.clearInterval(timer)
  }, [timerRunning])

  useEffect(() => {
    setSelectedExercise(EXERCISES_BY_BODY_PART[selectedBodyPart][0])
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
    }
  }, [tab])

  useEffect(() => {
    if (tab !== 'history') {
      setHistoryDeleteTargetId(null)
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
    if (workoutPhase !== 'record') {
      return
    }

    setExerciseSetDrafts((previous) => ({
      ...previous,
      [getExerciseDraftKey(selectedBodyPart, selectedExercise)]: sets.map((set) => ({
        weight: set.weight,
        reps: set.reps,
      })),
    }))
  }, [selectedBodyPart, selectedExercise, sets, workoutPhase])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
      if (wheelScrollTimerRef.current) {
        window.clearTimeout(wheelScrollTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const mediaQuery = window.matchMedia('(orientation: landscape) and (max-width: 1024px)')
    const updateOrientationBlock = () => {
      setIsLandscapeBlocked(mediaQuery.matches)
    }

    updateOrientationBlock()
    if (typeof screen !== 'undefined' && 'orientation' in screen && typeof screen.orientation.lock === 'function') {
      void screen.orientation.lock('portrait').catch(() => undefined)
    }

    mediaQuery.addEventListener('change', updateOrientationBlock)
    window.addEventListener('resize', updateOrientationBlock)

    return () => {
      mediaQuery.removeEventListener('change', updateOrientationBlock)
      window.removeEventListener('resize', updateOrientationBlock)
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

    setSyncStatus('クラウド同期中...')
    const unsubscribeSessions = subscribeSessions(db, user.uid, (nextSessions) => {
      setSessions(nextSessions)
      setSyncStatus('クラウド同期済み')
    })
    return () => {
      unsubscribeSessions()
    }
  }, [isDemoMode, setSessions, user])

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

  const groupedHistory = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf())
    return sorted.filter((session) => {
      const dateText = dayjs(session.date).format('YYYY-MM-DD')
      const hasExercise = session.exercises.some((exercise) => exercise.name.includes(historyQuery))
      const matchesQuery =
        !historyQuery || dateText.includes(historyQuery) || session.bodyPart.includes(historyQuery) || hasExercise
      if (!matchesQuery) {
        return false
      }

      if (historySelectedDate) {
        return dateText === historySelectedDate
      }

      return dayjs(session.date).isSame(historyMonth, 'month')
    })
  }, [historyMonth, historyQuery, historySelectedDate, sessions])

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
      const sessionVolume = session.exercises
        .flatMap((exercise) => exercise.sets)
        .reduce((sum, set) => sum + set.weight * set.reps, 0)
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
      const sessionVolume = session.exercises
        .flatMap((exercise) => exercise.sets)
        .reduce((sum, set) => sum + set.weight * set.reps, 0)
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
      .flatMap((session) => session.exercises)
      .flatMap((exercise) => exercise.sets)
      .reduce((sum, set) => sum + set.weight * set.reps, 0)
  }, [sessions])

  const weeklyDeltaLabel = useMemo(() => {
    if (previousWeeklyTotalVolume === 0) {
      return weeklyTotalVolume > 0 ? 'NEW' : '0%'
    }

    const delta = ((weeklyTotalVolume - previousWeeklyTotalVolume) / previousWeeklyTotalVolume) * 100
    const rounded = Math.round(delta)
    return `${rounded >= 0 ? '+' : ''}${rounded}%`
  }, [previousWeeklyTotalVolume, weeklyTotalVolume])

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
        const repCount = session.exercises.flatMap((exercise) => exercise.sets).reduce((acc, set) => acc + set.reps, 0)
        const estimatedMinutes = exerciseCount * 3 + setCount * 2.4 + repCount * 0.08 + 4
        const met = strengthMetByBodyPart[session.bodyPart]
        const sessionCalories = Math.max(
          35,
          Math.min(
            180,
            Math.round(((met * 3.5 * assumedBodyWeightKg) / 200) * estimatedMinutes),
          ),
        )
        return sum + sessionCalories
      }, 0)

      return {
        label,
        value: Math.min(320, value),
      }
    })
    const total = caloriesByDay.reduce((sum, day) => sum + day.value, 0)
    return { caloriesByDay, total }
  }, [sessions])

  const homeAiMessage = useMemo(() => {
    if (aiFeedback[0]) {
      const compact = aiFeedback[0].replace(/\s+/g, ' ').trim()
      return compact.length > 72 ? `${compact.slice(0, 72)}…` : compact
    }

    if (sessions.length === 0) {
      return '最初の1セットを記録して、あなた専用のメッセージを育てよう。'
    }

    const latest = [...sessions].sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf())[0]
    const restDays = dayjs().diff(dayjs(latest.date), 'day')
    const weeklyKcal = weeklyCalories.total
    const raw = `前回は${dayjs(latest.date).format('M/D')}。休養${restDays}日、今週推定${weeklyKcal}kcal。今日はフォームを丁寧に積み上げよう。`
    return raw.length > 72 ? `${raw.slice(0, 72)}…` : raw
  }, [aiFeedback, sessions, weeklyCalories.total])

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

  const bodyBalanceIndex = useMemo(() => {
    const now = dayjs()
    const counts = BODY_PARTS.map(
      (part) =>
        sessions.filter((session) => session.bodyPart === part && now.diff(dayjs(session.date), 'day') < 7).length,
    )
    const total = counts.reduce((sum, count) => sum + count, 0)
    if (total === 0) {
      return 0
    }

    const probabilities = counts.filter((count) => count > 0).map((count) => count / total)
    const entropy = probabilities.reduce((sum, p) => sum - p * Math.log(p), 0)
    const maxEntropy = Math.log(BODY_PARTS.length)
    return Math.round((entropy / maxEntropy) * 100)
  }, [sessions])

  const latestExerciseSetHistory = useMemo(() => {
    const history = new Map<string, Array<Pick<ExerciseSet, 'weight' | 'reps'>>>()
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

  const exerciseUsageStats = useMemo(() => {
    const stats = new Map<string, { count: number; lastPerformed: number; latestSetLine: string }>()

    sessions
      .filter((session) => session.bodyPart === selectedBodyPart)
      .forEach((session) => {
        const performedAt = dayjs(session.date).valueOf()
        session.exercises.forEach((exercise) => {
          const latestSetLine = exercise.sets.map((set) => `${set.weight}kg×${set.reps}`).join(' / ')
          const current = stats.get(exercise.name)
          if (!current) {
            stats.set(exercise.name, {
              count: 1,
              lastPerformed: performedAt,
              latestSetLine,
            })
            return
          }

          stats.set(exercise.name, {
            count: current.count + 1,
            lastPerformed: Math.max(current.lastPerformed, performedAt),
            latestSetLine: current.lastPerformed >= performedAt ? current.latestSetLine : latestSetLine,
          })
        })
      })

    return stats
  }, [selectedBodyPart, sessions])

  const filteredExercises = useMemo(() => {
    const query = exerciseSearchQuery.trim()
    const baseExercises = EXERCISES_BY_BODY_PART[selectedBodyPart]
    const originalIndex = new Map(baseExercises.map((exercise, index) => [exercise, index]))
    const sortedExercises = [...baseExercises].sort((left, right) => {
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
  }, [exerciseSearchQuery, exerciseUsageStats, selectedBodyPart])

  const popularExerciseChips = useMemo(() => {
    return filteredExercises.slice(0, 4)
  }, [filteredExercises])

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

  const hasWorkoutDraft = useMemo(() => {
    return (
      workoutPhase !== 'body' ||
      sets.length !== 3 ||
      sets.some((set, index) => {
        const defaults = createDefaultSetsForExercise(selectedExercise)
        const fallback = defaults[index]
        return !fallback || set.weight !== fallback.weight || set.reps !== fallback.reps
      })
    )
  }, [selectedExercise, sets, workoutPhase])

  function vibrateAndSetTab(nextTab: AppTab, pattern: number | number[] = 12) {
    if (nextTab !== tab) {
      triggerHaptic(pattern)
    }
    setTab(nextTab)
  }

  const selectedExerciseProfile = useMemo(() => getExerciseInputProfile(selectedExercise), [selectedExercise])
  const selectedExerciseGuide = useMemo(
    () => getExerciseGuidanceSpec(exerciseInfoTarget ?? selectedExercise),
    [exerciseInfoTarget, selectedExercise],
  )

  const selectedExerciseInfo = useMemo(() => {
    return splitExerciseInfo(EXERCISE_INFO[exerciseInfoTarget ?? ''] ?? '種目説明は準備中です。')
  }, [exerciseInfoTarget])

  const analytics = useMemo(() => {
    const frequency = BODY_PARTS.map((part) => ({
      part,
      count: sessions.filter((session) => session.bodyPart === part).length,
    }))
    const now = dayjs()
    const weeklyTotal = sessions
      .filter((session) => now.diff(dayjs(session.date), 'day') < 7)
      .flatMap((session) => session.exercises)
      .flatMap((exercise) => exercise.sets)
      .reduce((sum, set) => sum + set.weight * set.reps, 0)
    const monthlyTotal = sessions
      .filter((session) => now.diff(dayjs(session.date), 'day') < 31)
      .flatMap((session) => session.exercises)
      .flatMap((exercise) => exercise.sets)
      .reduce((sum, set) => sum + set.weight * set.reps, 0)
    const yearlyTotal = sessions
      .filter((session) => now.diff(dayjs(session.date), 'day') < 366)
      .flatMap((session) => session.exercises)
      .flatMap((exercise) => exercise.sets)
      .reduce((sum, set) => sum + set.weight * set.reps, 0)
    const allTotal = sessions
      .flatMap((session) => session.exercises)
      .flatMap((exercise) => exercise.sets)
      .reduce((sum, set) => sum + set.weight * set.reps, 0)

    const staleParts = daysSinceByBodyPart.filter((item) => item.days >= 7 && item.days < 999).slice(0, 2)
    const feedback = [
      `胸の実施回数は ${frequency.find((f) => f.part === '胸')?.count ?? 0} 回です。`,
      ...staleParts.map((item) => `${item.part} は ${item.days} 日空いています。今週中の実施がおすすめです。`),
      `直近7日間の総ボリュームは ${weeklyTotal.toLocaleString()} kg です。`,
    ]

    return { frequency, weeklyTotal, monthlyTotal, yearlyTotal, allTotal, feedback }
  }, [daysSinceByBodyPart, sessions])

  async function handleAuth(email: string, password: string, mode: AuthMode) {
    if (!auth) {
      throw new Error('Firebase 設定が不足しています。')
    }

    setAuthError(null)

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
    resetCompleteConfirm()
    setSets((previous) => [
      ...previous,
      {
        id: `${Date.now()}-${previous.length}`,
        weight: previous[previous.length - 1]?.weight ?? profile.defaultWeight,
        reps: previous[previous.length - 1]?.reps ?? profile.defaultReps,
      },
    ])
  }

  function removeSet(setId: string) {
    resetCompleteConfirm()
    setSets((previous) => previous.filter((set) => set.id !== setId))
  }

  function updateSet(setId: string, key: PickerTargetKey, value: number) {
    resetCompleteConfirm()
    setSets((previous) => previous.map((set) => (set.id === setId ? { ...set, [key]: value } : set)))
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
        restSeconds: rest,
      },
    }))
  }

  function getPreparedSetsForExercise(bodyPart: BodyPart, exerciseName: string): ExerciseSet[] {
    const draftKey = getExerciseDraftKey(bodyPart, exerciseName)
    const draftSets = exerciseSetDrafts[draftKey] ?? latestExerciseSetHistory.get(draftKey)
    if (draftSets && draftSets.length > 0) {
      return cloneSetDrafts(draftSets)
    }

    return createDefaultSetsForExercise(exerciseName)
  }

  function handleExerciseSelect(exerciseName: string) {
    setSelectedExercise(exerciseName)
    setSets(getPreparedSetsForExercise(selectedBodyPart, exerciseName))
    setWorkoutPhase('record')
    setTimerRunning(false)
    setRestSeconds(getExercisePreferredRestSeconds(selectedBodyPart, exerciseName))
    resetCompleteConfirm()
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

  function startWorkoutFlow(forceReset = false) {
    if (!forceReset && hasWorkoutDraft) {
      vibrateAndSetTab('workout', 18)
      return
    }

    vibrateAndSetTab('workout', 18)
    setWorkoutPhase('body')
    setSets(createDefaultSetsForExercise(selectedExercise))
    setExerciseSearchQuery('')
    setAuthError(null)
    resetCompleteConfirm()
  }

  async function handleDeleteHistorySession(sessionId: string) {
    if (isDeletingHistory) {
      return
    }

    setIsDeletingHistory(true)
    try {
      if (db && user && !isDemoMode) {
        await removeSession(db, user.uid, sessionId)
        setSyncStatus('クラウド同期済み')
      } else {
        deleteSessionFromStore(sessionId)
        setSyncStatus('ローカル保存')
      }

      setHistoryDeleteTargetId(null)
      showToast('履歴を削除しました')
      setAuthError(null)
    } catch (error) {
      setSyncStatus('同期エラー')
      setAuthError(error instanceof Error ? error.message : '履歴削除に失敗しました。')
      showToast('履歴削除に失敗しました', 'error')
    } finally {
      setIsDeletingHistory(false)
    }
  }

  async function saveWorkout() {
    if (isSavingWorkout) {
      return
    }

    setIsSavingWorkout(true)
    try {
      const session = createSession(selectedBodyPart, selectedExercise, sets)
      addSession(session)
      setTab('workout')
      setWorkoutPhase('body')
      setSets(createDefaultSetsForExercise(selectedExercise))
      setRestSeconds(getExercisePreferredRestSeconds(selectedBodyPart, selectedExercise))
      setTimerRunning(false)
      setAuthError(null)
      showToast('保存しました')
      resetCompleteConfirm()

      if (db && user && !isDemoMode) {
        setSyncStatus('クラウド同期中...')
        try {
          await saveSession(db, user.uid, session)
          setSyncStatus('クラウド同期済み')
        } catch (error) {
          setSyncStatus('同期エラー')
          setAuthError(
            error instanceof Error
              ? `同期に失敗しました。記録は端末に保存済みです。${error.message}`
              : '同期に失敗しました。記録は端末に保存済みです。',
          )
          showToast('端末には保存済み / 同期エラー', 'error')
        }
      } else {
        setSyncStatus('ローカル保存')
      }
    } catch (error) {
      setSyncStatus('同期エラー')
      setAuthError(error instanceof Error ? error.message : 'ワークアウト保存に失敗しました。')
      showToast('保存に失敗しました', 'error')
      resetCompleteConfirm()
    } finally {
      setIsSavingWorkout(false)
    }
  }

  async function refreshAiFeedback() {
    try {
      if (sessions.length === 0) {
        throw new Error('履歴がないためAI分析できません。')
      }

      setAiLoading(true)
      setAiError(null)
      const feedback = await requestAiFeedback(sessions)
      setAiFeedback(feedback)
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'AI分析の更新に失敗しました。')
    } finally {
      setAiLoading(false)
    }
  }

  async function logout() {
    if (!auth) {
      setIsDemoMode(false)
      return
    }

    try {
      await signOut(auth)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'ログアウトに失敗しました。')
    }
  }

  if (loading) {
    return <main className="loading">読み込み中...</main>
  }

  if (isLandscapeBlocked) {
    return (
      <main className="orientation-guard">
        <div className="orientation-guard-card">
          <h1>縦画面で使ってください</h1>
          <p>Atlas はスマホ縦持ち専用です。端末を縦に戻すと、そのまま続きから再開できます。</p>
        </div>
      </main>
    )
  }

  if (!canUseApp) {
    return (
      <AuthView
        onDemoStart={() => setIsDemoMode(true)}
        onLogin={handleAuth}
        onGoogleLogin={handleGoogleLogin}
        onStartPhoneLogin={handleStartPhoneLogin}
        onVerifyPhoneCode={handleVerifyPhoneCode}
      />
    )
  }

  return (
    <main className={`app has-fixed-nav ${tab === 'home' ? 'home-single-screen' : ''} ${tab === 'workout' ? 'no-scroll' : ''}`}>
      <header className="header">
        <h1 className="brand-title">Atlas</h1>
        <div className="header-meta">
          <p className="header-email">{user?.email ?? 'デモモード'}</p>
          <p className="sync-badge">{syncStatus}</p>
        </div>
      </header>
      {authError && <p className="error">{authError}</p>}

      {tab === 'home' && (
        <section className="home-grid">
          <section className="card home-primary-card">
            <h2>AIメッセージ</h2>
            <p className="home-ai-main" title={homeAiMessage}>
              {homeAiMessage}
            </p>
          </section>

          <section className="card home-graph-card">
            <div className="row">
              <h2>推定消費カロリー</h2>
              <span className="badge">{weeklyCalories.total.toLocaleString()} kcal</span>
            </div>
            <div className="mini-chart">
              {weeklyCalories.caloriesByDay.map((day) => {
                const max = Math.max(...weeklyCalories.caloriesByDay.map((item) => item.value), 1)
                const heightPercent = Math.max(8, Math.round((day.value / max) * 100))
                return (
                  <div key={day.label} className="mini-chart-item">
                    <div className="mini-bar-track">
                      <div className="mini-bar" style={{ height: `${heightPercent}%` }} />
                    </div>
                    <span>{day.label}</span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="home-kpi-inline">
            <p className="kpi-chip">
              <span>継続日数</span>
              <strong>{streakDays}日</strong>
            </p>
            <p className="kpi-chip">
              <span>今週総重量</span>
              <strong>{weeklyTotalVolume.toLocaleString()}kg</strong>
            </p>
            <p className="kpi-chip">
              <span>前週比</span>
              <strong>{weeklyDeltaLabel}</strong>
            </p>
            <p className="kpi-chip">
              <span>部位バランス指数</span>
              <strong>{bodyBalanceIndex}</strong>
            </p>
          </section>
        </section>
      )}

      {tab === 'workout' && (
        <section className="card workout-screen">
          <div className="row">
            <h2>{workoutPhase === 'record' ? `${selectedBodyPart} / ${selectedExercise} 記録` : 'ワークアウト'}</h2>
            {workoutPhase !== 'body' ? (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic(12)
                  setWorkoutPhase((previous) => (previous === 'record' ? 'exercise' : 'body'))
                }}
              >
                戻る
              </button>
            ) : (
              <button type="button" onClick={() => vibrateAndSetTab('home', 12)}>
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
              <div className="chip-row">
                {popularExerciseChips.map((exercise) => (
                  <button
                    key={exercise}
                    type="button"
                    className="chip-button"
                    onClick={() => {
                      triggerHaptic(16)
                      handleExerciseSelect(exercise)
                    }}
                  >
                    {exercise}
                  </button>
                ))}
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
                        {exerciseUsageStats.get(exercise)?.latestSetLine
                          ? `${exerciseUsageStats.get(exercise)?.latestSetLine}`
                          : '前回記録なし'}
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
                <div className="previous-set-card">
                  <p className="previous-set-line">
                    前回セット:
                    {' '}
                    {previousExerciseSets.length > 0
                      ? previousExerciseSets.map((set) => `${set.weight}kg×${set.reps}`).join(' / ')
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
                          openWheelPicker(set.id, 'reps', set.reps)
                        }}
                      >
                        {set.reps}回
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
              <div className="timer">
                <h3>休憩タイマー</h3>
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
                  <p>
                    {String(Math.floor(restSeconds / 60)).padStart(2, '0')}:
                    {String(restSeconds % 60).padStart(2, '0')}
                  </p>
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
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic(timerRunning ? 14 : 20)
                      resetCompleteConfirm()
                      setTimerRunning((previous) => {
                        if (!previous && restSeconds === 0) {
                          setRestSeconds(getExercisePreferredRestSeconds(selectedBodyPart, selectedExercise))
                        }
                        return !previous
                      })
                    }}
                  >
                    {timerRunning ? 'STOP' : 'START'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic(12)
                      resetCompleteConfirm()
                      setTimerRunning(false)
                      setRestSeconds(getExercisePreferredRestSeconds(selectedBodyPart, selectedExercise))
                    }}
                  >
                    リセット
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'history' && (
        <section className="card">
          <h2>履歴</h2>
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
          <input
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
            placeholder="日付 / 部位 / 種目で検索"
          />
          {historyDateSections.map((section) => {
            const isOpen = historyOpenDates.includes(section.date)
            return (
              <section key={section.date} className="history-date-group">
                <button
                  type="button"
                  className="history-date-toggle"
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
                    <small>{section.sessionCount}件 / 総重量 {section.totalVolume.toLocaleString()}kg</small>
                  </div>
                  <span>{isOpen ? '−' : '+'}</span>
                </button>
                {isOpen &&
                  section.sessions.map((session) => (
                    <article key={session.id} className="history-item">
                      <div className="history-item-head">
                        <strong>{session.bodyPart}</strong>
                        <button
                          type="button"
                          className={`history-delete-btn ${historyDeleteTargetId === session.id ? 'danger' : ''}`}
                          disabled={isDeletingHistory}
                          onClick={() => {
                            if (historyDeleteTargetId === session.id) {
                              void handleDeleteHistorySession(session.id)
                              return
                            }

                            setHistoryDeleteTargetId(session.id)
                          }}
                        >
                          {historyDeleteTargetId === session.id ? '削除する' : '削除'}
                        </button>
                      </div>
                      {session.exercises.map((exercise) => (
                        <p key={exercise.id}>
                          {exercise.name}:{' '}
                          {exercise.sets.map((set) => `${set.weight}×${set.reps}`).join(' / ')}
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
        <section className="card">
          <h2>分析</h2>
          <h3>部位頻度</h3>
          {analytics.frequency.map((item) => (
            <div key={item.part} className="row">
              <strong>{item.part}</strong>
              <span className="badge">{'★'.repeat(Math.min(item.count, 5)) || '☆'}</span>
            </div>
          ))}
          <h3>ボリューム</h3>
          <p>週間: {analytics.weeklyTotal.toLocaleString()} kg</p>
          <p>月間: {analytics.monthlyTotal.toLocaleString()} kg</p>
          <p>年間: {analytics.yearlyTotal.toLocaleString()} kg</p>
          <p>総重量: {analytics.allTotal.toLocaleString()} kg</p>
          <div className="row">
            <h3>AIフィードバック</h3>
            <button type="button" onClick={() => void refreshAiFeedback()} disabled={aiLoading}>
              {aiLoading ? '更新中...' : 'AI分析を更新'}
            </button>
          </div>
          {aiError && <p className="error">{aiError}</p>}
          {(aiFeedback.length > 0 ? aiFeedback : analytics.feedback).map((text) => (
            <p key={text} className="feedback-line">・{text}</p>
          ))}
        </section>
      )}

      {tab === 'settings' && (
        <section className="card">
          <h2>設定</h2>
          <p>プロフィール: {user?.email ?? 'デモユーザー'}</p>
          {authError && <p className="error">{authError}</p>}
          <button type="button" onClick={logout}>
            ログアウト
          </button>
        </section>
      )}

      {tab === 'home' && (
        <button type="button" className="thumb-workout-cta" onClick={() => startWorkoutFlow(false)}>
          {hasWorkoutDraft ? 'ワークアウト再開' : 'ワークアウト開始'}
        </button>
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
            <ExerciseTextGuide exerciseName={exerciseInfoTarget} />
            <div className="info-copy">
              <p><strong>姿勢</strong> {selectedExerciseGuide.setup}</p>
              <p><strong>やり方</strong> {selectedExerciseInfo.method}</p>
              {selectedExerciseInfo.caution && <p><strong>注意</strong> {selectedExerciseInfo.caution}</p>}
            </div>
          </div>
        </div>
      )}

      {pickerTarget && (
        <div className="overlay">
          <div className="overlay-card">
            <h3>{pickerTarget.key === 'weight' ? '重量を選択' : '回数を選択'}</h3>
            <p className="picker-meta">
              {pickerTarget.key === 'weight'
                ? `${selectedExerciseProfile.weightStep}kg刻み / ${selectedExerciseProfile.weightMin}〜${selectedExerciseProfile.weightMax}kg`
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
                <span className="wheel-unit">{pickerTarget.key === 'weight' ? 'kg' : '回'}</span>
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

      <nav className="bottom-nav">
        <button type="button" onClick={() => vibrateAndSetTab('home', 10)} className={tab === 'home' ? 'active' : ''}>
          ホーム
        </button>
        <button
          type="button"
          onClick={() => startWorkoutFlow(false)}
          className={tab === 'workout' ? 'active' : ''}
        >
          ワークアウト
        </button>
        <button
          type="button"
          onClick={() => vibrateAndSetTab('history', 10)}
          className={tab === 'history' ? 'active' : ''}
        >
          履歴
        </button>
        <button
          type="button"
          onClick={() => vibrateAndSetTab('analytics', 10)}
          className={tab === 'analytics' ? 'active' : ''}
        >
          分析
        </button>
        <button
          type="button"
          onClick={() => vibrateAndSetTab('settings', 10)}
          className={tab === 'settings' ? 'active' : ''}
        >
          設定
        </button>
      </nav>
    </main>
  )
}

export default App
